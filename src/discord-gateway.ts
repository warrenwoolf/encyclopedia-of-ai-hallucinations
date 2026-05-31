/**
 * Discord gateway presence connection.
 *
 * The REST notifier in `discord.ts` only POSTs messages — it never opens a
 * gateway connection, so the bot shows as **offline** in Discord even while the
 * site is up and posting. This module opens a single gateway WebSocket whose
 * sole purpose is to advertise an "online" presence for as long as the server
 * runs. We subscribe to no events and request no (privileged) intents —
 * `intents: 0` is enough to appear online; the `presence` block in IDENTIFY is
 * what sets the status.
 *
 * Contract (mirrors discord.ts's "best-effort, never break the app" stance):
 *   - `startDiscordPresence()` is safe to call once at server startup. If
 *     `DISCORD_BOT_TOKEN` is unset it logs once and no-ops.
 *   - Nothing here throws into the caller; all socket work is async and any
 *     error schedules a reconnect with exponential backoff (capped).
 *   - A missed heartbeat ACK is treated as a zombied connection and forces a
 *     reconnect (Discord's documented requirement).
 *
 * We deliberately do NOT implement RESUME — a presence-only bot loses nothing by
 * re-IDENTIFYing on reconnect, and it keeps the state machine small. Reconnects
 * are infrequent in practice and the backoff keeps us well clear of the
 * identify rate limit.
 */
import { config } from "./config.ts";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

// Gateway op codes (https://discord.com/developers/docs/topics/gateway-events).
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const ACTIVITY_TYPE_WATCHING = 3;
const MAX_BACKOFF_MS = 60_000;

let started = false;
let stopped = false;
let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastSeq: number | null = null;
let backoffMs = 1_000;
let acked = true;
let reconnectScheduled = false;

/**
 * Open the presence connection. Idempotent — calling more than once is a no-op.
 * Call once at startup.
 */
export function startDiscordPresence(): void {
  if (started) return;
  started = true;
  if (!config.discord.botToken) {
    console.log("[discord] DISCORD_BOT_TOKEN not set — presence (online status) disabled");
    return;
  }
  connect();
}

/** Tear the connection down and stop reconnecting. For tests / graceful exit. */
export function stopDiscordPresence(): void {
  stopped = true;
  clearHeartbeat();
  try {
    ws?.close(1000);
  } catch {
    // ignore
  }
  ws = null;
}

function connect(): void {
  if (stopped) return;
  let socket: WebSocket;
  try {
    socket = new WebSocket(GATEWAY_URL);
  } catch (err) {
    console.error("[discord] gateway connect failed:", err);
    scheduleReconnect();
    return;
  }
  ws = socket;
  acked = true;

  socket.addEventListener("open", () => {
    backoffMs = 1_000; // a successful open resets the backoff
  });

  socket.addEventListener("message", (ev: MessageEvent) => {
    let payload: any;
    try {
      payload = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (payload == null) return;
    if (typeof payload.s === "number") lastSeq = payload.s;

    switch (payload.op) {
      case OP_HELLO: {
        const interval = Number(payload.d?.heartbeat_interval) || 41_250;
        startHeartbeat(interval);
        identify();
        break;
      }
      case OP_HEARTBEAT:
        // Server asked for an immediate heartbeat.
        sendHeartbeat();
        break;
      case OP_HEARTBEAT_ACK:
        acked = true;
        break;
      case OP_RECONNECT:
      case OP_INVALID_SESSION:
        // Drop the socket; the 'close' handler schedules the reconnect.
        try {
          socket.close();
        } catch {
          // ignore
        }
        break;
      // OP_DISPATCH and everything else: we subscribe to nothing, so ignore.
    }
  });

  socket.addEventListener("close", () => {
    if (ws === socket) ws = null;
    clearHeartbeat();
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    // A 'close' always follows an 'error'; reconnect is handled there. Swallow
    // so an unhandled rejection can't bubble out of the socket.
  });
}

function identify(): void {
  send({
    op: OP_IDENTIFY,
    d: {
      token: config.discord.botToken,
      // No intents: we don't consume any gateway events, only advertise
      // presence. Appearing online does not require any (privileged) intent.
      intents: 0,
      properties: { os: "linux", browser: "enaih", device: "enaih" },
      presence: {
        since: null,
        activities: [{ name: "for AI hallucinations · enaih.org", type: ACTIVITY_TYPE_WATCHING }],
        status: "online",
        afk: false,
      },
    },
  });
}

function startHeartbeat(intervalMs: number): void {
  clearHeartbeat();
  acked = true;
  heartbeatTimer = setInterval(() => {
    if (!acked) {
      // No ACK since the last beat — the connection is a zombie. Force-close;
      // the 'close' handler reconnects.
      try {
        ws?.close();
      } catch {
        // ignore
      }
      return;
    }
    acked = false;
    sendHeartbeat();
  }, intervalMs);
  // Don't let the heartbeat timer keep the process alive on its own.
  heartbeatTimer?.unref?.();
}

function sendHeartbeat(): void {
  send({ op: OP_HEARTBEAT, d: lastSeq });
}

function clearHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function send(obj: unknown): void {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (err) {
    console.error("[discord] gateway send failed:", err);
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectScheduled) return;
  reconnectScheduled = true;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  const timer = setTimeout(() => {
    reconnectScheduled = false;
    connect();
  }, delay);
  timer.unref?.();
}
