/**
 * In-memory token-bucket rate limit, keyed by IP + action.
 *
 * Resets on process restart, which is acceptable for v1. If we ever need
 * persistence across restarts, swap this implementation out (the public API
 * `check()` stays the same).
 */

interface Bucket {
  tokens: number;
  updated: number;
}

interface LimitConfig {
  capacity: number;
  refillPerHour: number;
}

const LIMITS: Record<string, LimitConfig> = {
  submit: { capacity: 60, refillPerHour: 60 },
  login: { capacity: 10, refillPerHour: 10 },
  withdraw: { capacity: 20, refillPerHour: 20 },
  // Account signup triggers an outbound verification email. Keep tight to
  // avoid abuse and preserve our 300/mo Resend budget for real users.
  signup: { capacity: 5, refillPerHour: 5 },
  // API endpoints — somewhat generous since they're read-only or low-cost.
  api: { capacity: 20, refillPerHour: 20 },
  // Verification-code submission. 5 attempts per code are already enforced
  // in the DB; this is a per-IP-floor on top so an attacker can't burn
  // through codes across many half-finished accounts.
  verify: { capacity: 30, refillPerHour: 30 },
  // Google OAuth start. Mostly a paranoia check — the actual flow is
  // signed, but capping the number of started flows prevents abuse.
  oauth: { capacity: 30, refillPerHour: 30 },
  // Entry complaints. Anonymous visitors can hit this, and each one writes a
  // DB row + fires an email + a Discord post, so keep it tight per IP.
  complaint: { capacity: 10, refillPerHour: 10 },
};

const buckets = new Map<string, Bucket>();

const MAX_KEYS = 50_000; // ~few MB of RAM at most

export function check(action: keyof typeof LIMITS, ip: string): { allowed: boolean; retryAfterSec?: number } {
  const cfg = LIMITS[action];
  if (!cfg) return { allowed: true };
  const key = `${action}:${ip}`;
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: cfg.capacity, updated: now };

  const refillRate = cfg.refillPerHour / 3600 / 1000; // tokens per ms
  const elapsed = now - bucket.updated;
  bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsed * refillRate);
  bucket.updated = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    setBucket(key, bucket);
    return { allowed: true };
  }

  const needed = 1 - bucket.tokens;
  const retryAfterSec = Math.ceil(needed / refillRate / 1000);
  setBucket(key, bucket);
  return { allowed: false, retryAfterSec };
}

function setBucket(key: string, bucket: Bucket) {
  if (buckets.size >= MAX_KEYS && !buckets.has(key)) {
    // Evict buckets that have refilled to ~capacity first — those carry no
    // protective state, so dropping them harms nobody. Only fall back to
    // insertion-order eviction if no refilled buckets exist.
    let removed = 0;
    const target = Math.max(1, Math.floor(MAX_KEYS / 20));
    for (const [k, b] of buckets) {
      const cfg = LIMITS[k.split(":", 1)[0]!];
      if (cfg && b.tokens >= cfg.capacity - 0.5) {
        buckets.delete(k);
        if (++removed >= target) break;
      }
    }
    if (removed === 0) {
      // Last resort: oldest-by-insertion. Still bounded.
      for (const k of buckets.keys()) {
        buckets.delete(k);
        if (++removed >= target) break;
      }
    }
  }
  buckets.set(key, bucket);
}

/** Periodic GC of stale buckets (full or near-full, untouched for an hour). */
export function gc() {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.updated > 60 * 60 * 1000) buckets.delete(k);
  }
}
