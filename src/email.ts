/**
 * Email sending via Resend (https://resend.com).
 *
 * Free tier on the user's account. We POST directly to api.resend.com so we
 * don't take an SDK dep.
 *
 * Design notes:
 *   - All entry points return Promise<void> and NEVER throw. Email is a
 *     best-effort side channel; a delivery failure must not break submit or
 *     review. Errors are logged with the destination redacted.
 *   - If RESEND_API_KEY is not set, every function logs once at module load
 *     and then no-ops. This keeps local dev working without a key.
 *   - All bodies are plaintext + a minimal HTML version. No tracking pixels,
 *     no images, no link wrapping. CSP on the site is strict for a reason and
 *     the emails should match the vibe.
 *   - The submitter-facing emails contain raw tracking codes (24 chars,
 *     URL-safe). Anyone with the code can withdraw the submission while it's
 *     pending; that's the same trust model the /track page has had since v1.
 */
import { config } from "./config.ts";
import { escape } from "./html.ts";

interface SendArgs {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let warnedNoKey = false;

async function send(args: SendArgs): Promise<void> {
  if (!config.email.resendApiKey) {
    if (!warnedNoKey) {
      console.log("[email] RESEND_API_KEY not set — email sending disabled");
      warnedNoKey = true;
    }
    return;
  }

  const body = {
    from: config.email.from,
    to: [args.to],
    subject: args.subject,
    text: args.text,
    html: args.html,
    headers: {
      "List-Unsubscribe": `<mailto:${config.email.replyTo}?subject=unsubscribe>`,
    },
    reply_to: config.email.replyTo,
  };

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.email.resendApiKey}`,
      },
      body: JSON.stringify(body),
      // Cap the wait so a stuck request can't hang an admin review POST.
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "<unreadable>");
      console.error(
        `[email] resend rejected: ${resp.status} — ${redactEmail(args.to)} — ${text.slice(0, 300)}`,
      );
    }
  } catch (err) {
    console.error(`[email] send failed for ${redactEmail(args.to)}:`, err);
  }
}

/** Show 'b***@example.com' in logs so a stray log dump doesn't leak addresses. */
function redactEmail(addr: string): string {
  const at = addr.indexOf("@");
  if (at < 1) return "<redacted>";
  const local = addr.slice(0, at);
  const domain = addr.slice(at);
  if (local.length <= 2) return `${local[0]}*${domain}`;
  return `${local[0]}${"*".repeat(Math.max(1, local.length - 2))}${local[local.length - 1]}${domain}`;
}

function trackUrl(trackingCode: string): string {
  // The tracking code goes in a query parameter; tracking codes are base64url
  // and safe to embed, but encode defensively.
  return `${config.publicBaseUrl}/track?code=${encodeURIComponent(trackingCode)}`;
}

function entryUrl(eahIdOrPublicId: string): string {
  return `${config.publicBaseUrl}/e/${encodeURIComponent(eahIdOrPublicId)}`;
}

function htmlWrap(body: string): string {
  // Trivial inline-styled wrapper. No external resources, no class hooks.
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222;max-width:48em">${body}<hr><p style="font-size:0.85em;color:#666">You're receiving this because you submitted an entry to the Encyclopedia of AI Hallucinations and gave us your email. To stop receiving these, simply don't submit further entries — we don't maintain a mailing list.</p></body></html>`;
}

/** Sent immediately after a successful submit, only if email was provided. */
export async function sendSubmissionReceived(opts: {
  to: string;
  eahId: string;
  publicId: string;
  trackingCode: string;
  modelLabel: string;
  title: string;
}): Promise<void> {
  const { to, eahId, trackingCode, modelLabel, title } = opts;
  const link = trackUrl(trackingCode);
  const subject = `EAH: submission received (${eahId})`;
  const text =
    `Thanks for your submission to the Encyclopedia of AI Hallucinations.\n\n` +
    `Title: ${title}\n` +
    `Model: ${modelLabel}\n` +
    `EAH ID: ${eahId}\n\n` +
    `A staff reviewer will look at your submission before it appears publicly.\n` +
    `You'll get another email when a reviewer comments, and again when it's\n` +
    `accepted or rejected. If it's rejected or you withdraw, the A-number\n` +
    `(${eahId}) is returned to the pool for the next incoming draft.\n\n` +
    `Track, chat with reviewers, or withdraw this submission:\n${link}\n\n` +
    `Your tracking code: ${trackingCode}\n` +
    `(Save this — anyone with it can act on the submission while it's pending.)\n`;
  const html = htmlWrap(
    `<p>Thanks for your submission to the <strong>Encyclopedia of AI Hallucinations</strong>.</p>` +
      `<p><strong>Title:</strong> ${escape(title)}<br>` +
      `<strong>Model:</strong> ${escape(modelLabel)}<br>` +
      `<strong>EAH ID:</strong> <code>${escape(eahId)}</code></p>` +
      `<p>A staff reviewer will look at your submission before it appears publicly. ` +
      `You'll get another email when a reviewer comments and again when it's accepted ` +
      `or rejected. If it's rejected or you withdraw it, the A-number is returned to ` +
      `the pool for the next incoming draft.</p>` +
      `<p><a href="${escape(link)}">Track, chat with reviewers, or withdraw this submission</a></p>` +
      `<p><strong>Tracking code:</strong> <code>${escape(trackingCode)}</code><br>` +
      `<small>Save this — anyone with it can act on the submission while it's pending.</small></p>`,
  );
  await send({ to, subject, text, html });
}

/**
 * Sent when a staff reviewer posts a chat message on a pending submission.
 * The submitter follows the tracking link to read the full thread and reply.
 */
export async function sendReviewerMessage(opts: {
  to: string;
  eahId: string;
  trackingCode: string;
  modelLabel: string;
  reviewerName: string;
  bodyPreview: string;
}): Promise<void> {
  const { to, eahId, trackingCode, modelLabel, reviewerName, bodyPreview } = opts;
  const link = trackUrl(trackingCode);
  const subject = `EAH: a reviewer commented on your submission (${eahId})`;
  const preview = bodyPreview.length > 600 ? bodyPreview.slice(0, 600) + "…" : bodyPreview;

  const text =
    `A staff reviewer (${reviewerName}) posted a comment on your submission ` +
    `to the Encyclopedia of AI Hallucinations.\n\n` +
    `EAH ID: ${eahId}\n` +
    `Model: ${modelLabel}\n\n` +
    `> ${preview.split("\n").join("\n> ")}\n\n` +
    `Read the full thread and reply:\n${link}\n`;

  const html = htmlWrap(
    `<p>A staff reviewer (<strong>${escape(reviewerName)}</strong>) posted a comment on your ` +
      `submission to the <strong>Encyclopedia of AI Hallucinations</strong>.</p>` +
      `<p><strong>EAH ID:</strong> <code>${escape(eahId)}</code><br>` +
      `<strong>Model:</strong> ${escape(modelLabel)}</p>` +
      `<blockquote style="border-left:3px solid #ccc;padding-left:0.8em;color:#444;white-space:pre-wrap">${escape(preview)}</blockquote>` +
      `<p><a href="${escape(link)}">Read the full thread and reply</a></p>`,
  );

  await send({ to, subject, text, html });
}

/** Sent after admin accept/reject when submitter_email is present. */
export async function sendDecision(opts: {
  to: string;
  eahId: string;
  publicId: string;
  trackingCode: string;
  modelLabel: string;
  decision: "approved" | "rejected";
  staffReviewMessage: string | null;
  rejectionReason: string | null;
}): Promise<void> {
  const { to, eahId, trackingCode, modelLabel, decision, staffReviewMessage, rejectionReason } = opts;

  const subject =
    decision === "approved"
      ? `EAH: your submission was published (${eahId})`
      : `EAH: your submission was not accepted`;

  const lines: string[] = [];
  if (decision === "approved") {
    lines.push(`Your submission to the Encyclopedia of AI Hallucinations was approved and is now public.`);
    lines.push(``);
    lines.push(`EAH ID: ${eahId}`);
    lines.push(`Model: ${modelLabel}`);
    lines.push(`View it: ${entryUrl(eahId)}`);
  } else {
    lines.push(`Your submission to the Encyclopedia of AI Hallucinations was not accepted.`);
    lines.push(``);
    lines.push(`Model: ${modelLabel}`);
    lines.push(`(The A-number that had been reserved for this draft has been ` +
      `returned to the pool.)`);
    if (rejectionReason) {
      lines.push(``);
      lines.push(`Reason given: ${rejectionReason}`);
    }
  }
  if (staffReviewMessage) {
    lines.push(``);
    lines.push(`Note from the reviewer:`);
    lines.push(staffReviewMessage);
  }
  lines.push(``);
  lines.push(`Track or withdraw: ${trackUrl(trackingCode)}`);

  const text = lines.join("\n") + "\n";

  const htmlParts: string[] = [];
  if (decision === "approved") {
    htmlParts.push(`<p>Your submission to the <strong>Encyclopedia of AI Hallucinations</strong> was approved and is now public.</p>`);
    htmlParts.push(`<p><strong>EAH ID:</strong> <code>${escape(eahId)}</code><br>` +
      `<strong>Model:</strong> ${escape(modelLabel)}</p>`);
    htmlParts.push(`<p><a href="${escape(entryUrl(eahId))}">View the published entry</a></p>`);
  } else {
    htmlParts.push(`<p>Your submission to the <strong>Encyclopedia of AI Hallucinations</strong> was not accepted.</p>`);
    htmlParts.push(`<p><strong>Model:</strong> ${escape(modelLabel)}</p>`);
    htmlParts.push(`<p><small>The A-number that had been reserved for this draft has been returned to the pool.</small></p>`);
    if (rejectionReason) {
      htmlParts.push(`<p><strong>Reason given:</strong></p><blockquote>${escape(rejectionReason)}</blockquote>`);
    }
  }
  if (staffReviewMessage) {
    htmlParts.push(`<p><strong>Note from the reviewer:</strong></p><blockquote>${escape(staffReviewMessage)}</blockquote>`);
  }
  htmlParts.push(`<p><a href="${escape(trackUrl(trackingCode))}">Track this submission</a></p>`);

  await send({ to, subject, text, html: htmlWrap(htmlParts.join("")) });
}

/**
 * Sent in response to a /lookup request — one email containing tracking links
 * for every submission that matches the email address. To prevent email
 * enumeration the caller MUST call this regardless of whether rows exist
 * (well, with rows=[] the caller can just skip — the route always shows the
 * same 'if we know you, we sent it' page). This function is the rows-present
 * path.
 */
export async function sendLookupDigest(opts: {
  to: string;
  submissions: Array<{ eahId: string; trackingCode: string; modelLabel: string; title: string | null; status: string; submittedAt: Date }>;
}): Promise<void> {
  const { to, submissions } = opts;
  if (submissions.length === 0) return;

  const subject = `EAH: your submissions`;
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

  const lines: string[] = [];
  lines.push(`Here are the submissions we have on file for this email address.`);
  lines.push(``);
  for (const s of submissions) {
    const titlePart = s.title && s.title.length > 0 ? ` — "${s.title}"` : "";
    const idPart = s.eahId.length > 0 ? `${s.eahId} ` : "";
    lines.push(`- ${idPart}[${s.status}] ${s.modelLabel}${titlePart} — submitted ${fmtDate(s.submittedAt)}`);
    lines.push(`  ${trackUrl(s.trackingCode)}`);
  }
  lines.push(``);
  lines.push(`Click any link to track status, see reviewer notes, or withdraw a pending submission.`);
  const text = lines.join("\n") + "\n";

  const items = submissions
    .map((s) => {
      const titlePart = s.title && s.title.length > 0 ? ` — "${escape(s.title)}"` : "";
      const idPart = s.eahId.length > 0 ? `<code>${escape(s.eahId)}</code> ` : "";
      return (
        `<li>${idPart}<span style="font-family:monospace">[${escape(s.status)}]</span> ` +
        `${escape(s.modelLabel)}${titlePart} — submitted ${escape(fmtDate(s.submittedAt))}<br>` +
        `<a href="${escape(trackUrl(s.trackingCode))}">${escape(trackUrl(s.trackingCode))}</a></li>`
      );
    })
    .join("");
  const html = htmlWrap(
    `<p>Here are the submissions we have on file for this email address.</p>` +
      `<ul>${items}</ul>` +
      `<p><small>Click any link to track status, see reviewer notes, or withdraw a pending submission.</small></p>`,
  );

  await send({ to, subject, text, html });
}
