/**
 * Tests for src/oauth-google.ts — local JWKS-based ID token verification.
 *
 * We generate our OWN RSA keypair, publish its public half as the "Google"
 * JWKS via a stubbed global fetch, and sign tokens with the private half. This
 * lets us exercise the full verify path (signature + claim checks) without a
 * real Google round-trip, and lets us forge invalid tokens (wrong key, wrong
 * aud, expired, etc.) to confirm they're rejected.
 *
 * config.ts is mocked so `googleOAuth.clientId` is non-empty (the preload
 * leaves it empty, which would short-circuit verifyIdToken to null).
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const KID = "test-kid-1";

let verifyIdToken: (t: string) => Promise<unknown>;
let __resetJwksCacheForTests: () => void;

let privateKey: KeyObject;
let publicJwk: Record<string, unknown>;

// The JWK set our stubbed fetch will serve. Mutable so individual tests can
// simulate rotation / empty sets.
let servedJwks: { keys: unknown[] };
let realFetch: typeof globalThis.fetch;
let _savedConfig: any;

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

interface SignOpts {
  alg?: string;
  kid?: string | null;
  signingKey?: KeyObject; // override to forge a bad signature
}

/** Build a signed JWT. RS256 by default, signed with our test private key. */
function makeToken(payload: Record<string, unknown>, opts: SignOpts = {}): string {
  const header: Record<string, unknown> = { alg: opts.alg ?? "RS256", typ: "JWT" };
  if (opts.kid !== null) header["kid"] = opts.kid ?? KID;
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(opts.signingKey ?? privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

function validPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "1234567890",
    email: "User@Example.com",
    email_verified: true,
    name: "Test User",
    iat: now - 10,
    exp: now + 3600,
    ...over,
  };
}

beforeAll(async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  const jwk = pair.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  publicJwk = { ...jwk, kid: KID, alg: "RS256", use: "sig" };
  servedJwks = { keys: [publicJwk] };

  // Stub global fetch to serve our JWKS regardless of URL.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(servedJwks), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    })) as unknown as typeof globalThis.fetch;

  // Mock config so googleOAuth.clientId is set.
  _savedConfig = await import("../src/config.ts");
  mock.module("../src/config.ts", () => ({
    ..._savedConfig,
    config: {
      ..._savedConfig.config,
      googleOAuth: { ..._savedConfig.config.googleOAuth, clientId: CLIENT_ID },
    },
  }));

  const mod = await import("../src/oauth-google.ts");
  verifyIdToken = mod.verifyIdToken;
  __resetJwksCacheForTests = mod.__resetJwksCacheForTests;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (_savedConfig) mock.module("../src/config.ts", () => ({ ..._savedConfig }));
});

beforeEach(() => {
  servedJwks = { keys: [publicJwk] };
  __resetJwksCacheForTests();
});

describe("verifyIdToken", () => {
  test("accepts a valid token and normalizes the identity", async () => {
    const id = (await verifyIdToken(makeToken(validPayload()))) as any;
    expect(id).not.toBeNull();
    expect(id.sub).toBe("1234567890");
    expect(id.email).toBe("user@example.com"); // lowercased
    expect(id.emailVerified).toBe(true);
    expect(id.name).toBe("Test User");
  });

  test("accepts the bare 'accounts.google.com' issuer too", async () => {
    const id = await verifyIdToken(makeToken(validPayload({ iss: "accounts.google.com" })));
    expect(id).not.toBeNull();
  });

  test("accepts email_verified as the string \"true\"", async () => {
    const id = await verifyIdToken(makeToken(validPayload({ email_verified: "true" })));
    expect(id).not.toBeNull();
  });

  test("rejects a token signed by a different (attacker) key", async () => {
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = makeToken(validPayload(), { signingKey: attacker.privateKey });
    expect(await verifyIdToken(token)).toBeNull();
  });

  test("rejects a tampered payload (signature no longer matches)", async () => {
    const token = makeToken(validPayload());
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify(validPayload({ sub: "evil" }))).toString("base64url");
    expect(await verifyIdToken(`${h}.${forged}.${s}`)).toBeNull();
  });

  test("rejects alg confusion (alg: none)", async () => {
    // A 'none' token with empty signature.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: KID })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(validPayload())).toString("base64url");
    expect(await verifyIdToken(`${header}.${payload}.`)).toBeNull();
  });

  test("rejects a wrong audience", async () => {
    const token = makeToken(validPayload({ aud: "someone-else.apps.googleusercontent.com" }));
    expect(await verifyIdToken(token)).toBeNull();
  });

  test("rejects a wrong issuer", async () => {
    const token = makeToken(validPayload({ iss: "https://evil.example.com" }));
    expect(await verifyIdToken(token)).toBeNull();
  });

  test("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken(validPayload({ iat: now - 7200, exp: now - 3600 }));
    expect(await verifyIdToken(token)).toBeNull();
  });

  test("rejects a token issued in the future", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken(validPayload({ iat: now + 3600, exp: now + 7200 }));
    expect(await verifyIdToken(token)).toBeNull();
  });

  test("rejects unverified email", async () => {
    expect(await verifyIdToken(makeToken(validPayload({ email_verified: false })))).toBeNull();
  });

  test("rejects missing sub", async () => {
    const p = validPayload();
    delete p.sub;
    expect(await verifyIdToken(makeToken(p))).toBeNull();
  });

  test("rejects missing email", async () => {
    const p = validPayload();
    delete p.email;
    expect(await verifyIdToken(makeToken(p))).toBeNull();
  });

  test("rejects a token with an unknown kid", async () => {
    expect(await verifyIdToken(makeToken(validPayload(), { kid: "no-such-kid" }))).toBeNull();
  });

  test("rejects a token with no kid", async () => {
    expect(await verifyIdToken(makeToken(validPayload(), { kid: null }))).toBeNull();
  });

  test("rejects structurally malformed tokens", async () => {
    expect(await verifyIdToken("")).toBeNull();
    expect(await verifyIdToken("a.b")).toBeNull();
    expect(await verifyIdToken("not-a-jwt")).toBeNull();
    expect(await verifyIdToken("a.b.c.d")).toBeNull();
  });

  test("caches keys: a second verify does not re-fetch JWKS", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify(servedJwks), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "max-age=3600" },
      });
    }) as unknown as typeof globalThis.fetch;
    const prev = globalThis.fetch;
    globalThis.fetch = counting;
    try {
      __resetJwksCacheForTests();
      await verifyIdToken(makeToken(validPayload()));
      await verifyIdToken(makeToken(validPayload()));
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = prev;
    }
  });
});
