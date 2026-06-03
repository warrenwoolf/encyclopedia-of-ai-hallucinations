/**
 * Discord bot notifications.
 *
 * Posts plain messages to two channels via the Discord REST API (no SDK dep,
 * no gateway connection — we only ever POST a message):
 *   - staff channel  ← a submission enters the review queue (submit-for-review
 *                       or propose), or a reader files a complaint on an entry.
 *                       Lets reviewers know there's work.
 *   - public channel ← an entry is approved and published.
 *
 * (The bot's *online presence* is handled separately in src/discord-gateway.ts,
 * which opens a gateway WebSocket purely to advertise an "online" status.)
 *
 * Design mirrors email.ts: every exported function returns Promise<void> and
 * NEVER throws. Notifications are a best-effort side channel; a Discord outage
 * must not break submit or review. If DISCORD_BOT_TOKEN is unset the module
 * logs once and no-ops; either channel id can be left blank to disable just
 * that side.
 *
 * Security: `allowed_mentions: { parse: [] }` is sent on every message so a
 * submitter can't smuggle an `@everyone` / role ping through a title, model
 * string, or complaint body into the staff channel.
 */
import { config } from "./config.ts";

const API_BASE = "https://discord.com/api/v10";
const MAX_CONTENT = 2000; // Discord's per-message content limit.

let warnedNoToken = false;

/** Truncate to a Discord-safe length, leaving room for surrounding text. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

async function postMessage(channelId: string, content: string): Promise<void> {
  const token = config.discord.botToken;
  if (!token) {
    if (!warnedNoToken) {
      console.log("[discord] DISCORD_BOT_TOKEN not set — notifications disabled");
      warnedNoToken = true;
    }
    return;
  }
  if (!channelId) return; // This channel isn't configured; skip silently.

  try {
    const resp = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${token}`,
      },
      body: JSON.stringify({
        content: content.slice(0, MAX_CONTENT),
        allowed_mentions: { parse: [] },
      }),
      // Cap the wait so a stuck request can't hang a submit/review POST.
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "<unreadable>");
      console.error(`[discord] post to ${channelId} rejected: ${resp.status} — ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.error(`[discord] post to ${channelId} failed:`, err);
  }
}

/**
 * Fire when a submission enters the staff review queue (new "Submit for review"
 * or a draft proposed). Goes to the staff channel and links to the queue item.
 */
export async function notifyNewSubmission(opts: {
  submissionId: number;
  eahId: string;
  publicId?: string;
  title: string | null;
  modelLabel: string;
  username: string;
  anon: boolean;
}): Promise<void> {
  const link = `${config.publicBaseUrl}/admin/queue/${opts.submissionId}`;
  const author = opts.anon ? "anonymous" : opts.username;
  const title = opts.title && opts.title.length > 0 ? opts.title : "(untitled)";
  const ref = opts.eahId || (opts.publicId ? `#${opts.publicId}` : "(unreviewed)");
  const content =
    `🆕 **New submission for review** — ${ref}\n` +
    `**${title}**\n` +
    `Model: ${opts.modelLabel} · submitted by ${author}\n` +
    `Review it: ${link}`;
  await postMessage(config.discord.staffChannelId, content);
}

/**
 * Fire when an entry is approved + published. Goes to the public channel and
 * links to the public entry page.
 */
export async function notifyPublished(opts: {
  eahId: string;
  publicId?: string;
  title: string | null;
  modelLabel: string;
  categoryLabel: string;
}): Promise<void> {
  const ref = opts.eahId || (opts.publicId ? `#${opts.publicId}` : "");
  const slugForLink = opts.eahId || opts.publicId || "";
  const link = `${config.publicBaseUrl}/e/${slugForLink}`;
  const title = opts.title && opts.title.length > 0 ? opts.title : "(untitled)";
  const content =
    `✅ **New entry published** — ${ref}\n` +
    `**${title}**\n` +
    `Model: ${opts.modelLabel} · ${opts.categoryLabel}\n` +
    `${link}`;
  await postMessage(config.discord.publicChannelId, content);
}

/**
 * Posted to the staff channel when a visitor reports a problem with a public
 * entry. Includes the A-number + link + complaint type + a truncated note.
 */
export async function notifyComplaint(opts: {
  eahId: string;
  complaintLabel: string;
  body: string;
  reporter: string; // "user:<username>" or "anonymous"
}): Promise<void> {
  const { eahId, complaintLabel, body, reporter } = opts;
  const link = `${config.publicBaseUrl}/e/${encodeURIComponent(eahId)}`;
  // Leave generous room under the 2000-char cap for the header lines.
  const note = clip(body, 1500);
  const content =
    `⚠️ **Complaint on ${eahId}** (${complaintLabel})\n` +
    `From: ${reporter}\n` +
    `${link}\n\n` +
    `> ${note.split("\n").join("\n> ")}`;
  await postMessage(config.discord.staffChannelId, content);
}
