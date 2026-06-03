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
 *   - Submitters with accounts use /my/submissions to track their submissions;
 *     email links now point there rather than to deprecated /track URLs.
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

/**
 * Used monthly quota, as reported by Resend in the `x-resend-monthly-quota`
 * response header. Updated after every Resend call (success or failure),
 * and seeded by a best-effort startup probe in `primeQuotaCache`.
 *
 * `null` = we haven't heard from Resend yet this process. In that case
 * `emailCapReached()` fails open (allow the send). The next Resend response
 * will update the cache; if we're actually at cap, we'll get a 422 and the
 * subsequent decision-time check will block.
 *
 * Reset to 0 silently at the start of each calendar month — the cap is a
 * monthly counter on Resend's side, and our cache mirrors that.
 */
let cachedMonthlyUsed: number | null = null;
let cachedMonthKey: string = "";

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, "0")}`;
}

/** Update the cache from a Resend response's headers. Tolerates missing values. */
function updateQuotaFromHeaders(headers: Headers): void {
  // The header is documented as "your used monthly email sending quota" —
  // an integer count. Tolerate missing-or-bad values by leaving the cache.
  const raw = headers.get("x-resend-monthly-quota");
  if (raw === null) return;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return;
  cachedMonthlyUsed = n;
  cachedMonthKey = currentMonthKey();
}

/**
 * Fire-and-forget startup probe to fetch the current quota before we've
 * sent anything. Hits GET /domains because it's idempotent, free, and
 * Resend's gateway still attaches the quota headers.
 *
 * Called from server.ts on boot. Failure is silent — first real send will
 * populate the cache instead.
 */
export async function primeQuotaCache(): Promise<void> {
  if (!config.email.resendApiKey) return;
  try {
    const resp = await fetch("https://api.resend.com/domains", {
      method: "GET",
      headers: { Authorization: `Bearer ${config.email.resendApiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    updateQuotaFromHeaders(resp.headers);
  } catch {
    // Best-effort.
  }
}

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
    // Quota headers are returned on success AND error responses. Always read.
    updateQuotaFromHeaders(resp.headers);
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

/**
 * Best-known used monthly quota. Null if we haven't observed Resend yet —
 * fall back to fail-open in that case.
 *
 * The cache resets silently at month boundaries so a long-running process
 * doesn't keep an old quota across the reset point.
 */
export function emailsSentThisMonth(): number | null {
  if (cachedMonthKey !== currentMonthKey()) {
    // New month rolled over since we last cached; Resend's count will reset.
    return null;
  }
  return cachedMonthlyUsed;
}

/**
 * True iff we know we're at or past the configured cap. False on null
 * (unknown) — first send will populate the cache and a subsequent attempt
 * will see the truth.
 */
export function emailCapReached(): boolean {
  const cap = config.email.monthlyCap;
  if (cap <= 0) return false; // 0 disables the gate
  const used = emailsSentThisMonth();
  if (used === null) return false;
  return used >= cap;
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

function entryUrl(eahIdOrPublicId: string): string {
  return `${config.publicBaseUrl}/e/${encodeURIComponent(eahIdOrPublicId)}`;
}

function htmlWrap(body: string): string {
  // Trivial inline-styled wrapper. No external resources, no class hooks.
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222;max-width:48em">${body}<hr><p style="font-size:0.85em;color:#666">You're receiving this because you submitted an entry to the Encyclopedia of AI Hallucinations and gave us your email. To stop receiving these, simply don't submit further entries — we don't maintain a mailing list.</p></body></html>`;
}

/**
 * Sent when a staff reviewer posts a chat message on a pending submission.
 * The submitter follows the link to read the full thread and reply via their
 * account dashboard.
 */
export async function sendReviewerMessage(opts: {
  to: string;
  publicId: string;
  eahId?: string; // A-number, only once reproduced; "" / omitted otherwise
  modelLabel: string;
  reviewerName: string;
  bodyPreview: string;
}): Promise<void> {
  const { to, publicId, eahId, modelLabel, reviewerName, bodyPreview } = opts;
  // Owner routes are slug-addressed; lower tiers have no A-number, so always
  // link by public_id. Reference the entry by A-number when it has one, else
  // by model so the subject is never a bare "( )".
  const link = `${config.publicBaseUrl}/my/submissions/${encodeURIComponent(publicId)}/discussion`;
  const ref = eahId && eahId.length > 0 ? eahId : modelLabel;
  const subject = `ENAIH: a reviewer commented on your submission (${ref})`;
  const preview = bodyPreview.length > 600 ? bodyPreview.slice(0, 600) + "…" : bodyPreview;

  const idLineText = eahId && eahId.length > 0 ? `ENAIH ID: ${eahId}\n` : ``;
  const text =
    `A staff reviewer (${reviewerName}) posted a comment on your submission ` +
    `to the Encyclopedia of AI Hallucinations.\n\n` +
    idLineText +
    `Model: ${modelLabel}\n\n` +
    `> ${preview.split("\n").join("\n> ")}\n\n` +
    `Read the full thread and reply:\n${link}\n`;

  const idLineHtml = eahId && eahId.length > 0
    ? `<strong>ENAIH ID:</strong> <code>${escape(eahId)}</code><br>`
    : ``;
  const html = htmlWrap(
    `<p>A staff reviewer (<strong>${escape(reviewerName)}</strong>) posted a comment on your ` +
      `submission to the <strong>Encyclopedia of AI Hallucinations</strong>.</p>` +
      `<p>${idLineHtml}<strong>Model:</strong> ${escape(modelLabel)}</p>` +
      `<blockquote style="border-left:3px solid #ccc;padding-left:0.8em;color:#444;white-space:pre-wrap">${escape(preview)}</blockquote>` +
      `<p><a href="${escape(link)}">Read the full thread and reply</a></p>`,
  );

  await send({ to, subject, text, html });
}

/** Sent after admin accept/reject when submitter_email is present. */
export async function sendDecision(opts: {
  to: string;
  publicId: string;
  modelLabel: string;
  decision: "approved" | "rejected";
  staffReviewMessage: string | null;
  rejectionReason: string | null;
}): Promise<void> {
  const { to, publicId, modelLabel, decision, staffReviewMessage, rejectionReason } = opts;

  // A confirmed entry reaches the 'reviewed' tier — public, but it has no
  // A-number until staff reproduce it, so address it by its public_id slug.
  const subject =
    decision === "approved"
      ? `ENAIH: your submission passed staff review (${modelLabel})`
      : `ENAIH: your submission was not accepted`;

  const lines: string[] = [];
  if (decision === "approved") {
    lines.push(`Your submission to the Encyclopedia of AI Hallucinations was reviewed by staff and is now publicly listed.`);
    lines.push(``);
    lines.push(`Model: ${modelLabel}`);
    lines.push(`View it: ${entryUrl(publicId)}`);
  } else {
    lines.push(`Your submission to the Encyclopedia of AI Hallucinations was not accepted.`);
    lines.push(``);
    lines.push(`Model: ${modelLabel}`);
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
  if (decision === "rejected") {
    lines.push(``);
    lines.push(`See your submissions dashboard: ${config.publicBaseUrl}/my/submissions`);
  }

  const text = lines.join("\n") + "\n";

  const htmlParts: string[] = [];
  if (decision === "approved") {
    htmlParts.push(`<p>Your submission to the <strong>Encyclopedia of AI Hallucinations</strong> was reviewed by staff and is now publicly listed.</p>`);
    htmlParts.push(`<p><strong>Model:</strong> ${escape(modelLabel)}</p>`);
    htmlParts.push(`<p><a href="${escape(entryUrl(publicId))}">View the entry</a></p>`);
  } else {
    htmlParts.push(`<p>Your submission to the <strong>Encyclopedia of AI Hallucinations</strong> was not accepted.</p>`);
    htmlParts.push(`<p><strong>Model:</strong> ${escape(modelLabel)}</p>`);
    if (rejectionReason) {
      htmlParts.push(`<p><strong>Reason given:</strong></p><blockquote>${escape(rejectionReason)}</blockquote>`);
    }
  }
  if (staffReviewMessage) {
    htmlParts.push(`<p><strong>Note from the reviewer:</strong></p><blockquote>${escape(staffReviewMessage)}</blockquote>`);
  }
  if (decision === "rejected") {
    htmlParts.push(`<p><a href="${escape(config.publicBaseUrl + "/my/submissions")}">See your submissions dashboard</a></p>`);
  }

  await send({ to, subject, text, html: htmlWrap(htmlParts.join("")) });
}

/**
 * Sent to the staff contact inbox when a visitor reports a problem with a
 * public entry. Unlike the other senders this goes to *us*, not a submitter,
 * so it skips the submitter-oriented unsubscribe footer in `htmlWrap`.
 */
export async function sendComplaint(opts: {
  eahId: string;
  complaintLabel: string;
  body: string;
  reporter: string; // "user:<username>" or "anonymous"
}): Promise<void> {
  const { eahId, complaintLabel, body, reporter } = opts;
  const to = config.email.contact;
  const link = entryUrl(eahId);
  const subject = `EAH complaint: ${eahId} — ${complaintLabel}`;

  const text =
    `A visitor reported a problem with a published entry.\n\n` +
    `Entry: ${eahId}\n` +
    `Link: ${link}\n` +
    `Type: ${complaintLabel}\n` +
    `From: ${reporter}\n\n` +
    `Note:\n${body}\n`;

  const html =
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#222;max-width:48em">` +
    `<p>A visitor reported a problem with a published entry.</p>` +
    `<p><strong>Entry:</strong> <code>${escape(eahId)}</code><br>` +
    `<strong>Type:</strong> ${escape(complaintLabel)}<br>` +
    `<strong>From:</strong> ${escape(reporter)}</p>` +
    `<p><a href="${escape(link)}">View the entry</a></p>` +
    `<p><strong>Note:</strong></p>` +
    `<blockquote style="border-left:3px solid #ccc;padding-left:0.8em;color:#444;white-space:pre-wrap">${escape(body)}</blockquote>` +
    `</body></html>`;

  await send({ to, subject, text, html });
}

/**
 * Sent during email-based signup. Body contains the 6-digit code. Anyone with
 * the code can take over the half-finished account before it's verified, so
 * the cap on attempts (5) + TTL (15 min) live in auth.ts and are enforced
 * server-side; this function just delivers the digits.
 */
export async function sendVerificationCode(opts: {
  to: string;
  code: string;
  username: string;
}): Promise<void> {
  const { to, code, username } = opts;
  const subject = `ENAIH: your verification code is ${code}`;
  const text =
    `Hi ${username},\n\n` +
    `Your verification code for the Encyclopedia of AI Hallucinations is:\n\n` +
    `    ${code}\n\n` +
    `It expires in 15 minutes. Enter it on the verification page to finish ` +
    `creating your account.\n\n` +
    `If you didn't try to create an account, ignore this email — the half-` +
    `finished account will be deleted automatically.\n`;
  const html = htmlWrap(
    `<p>Hi <strong>${escape(username)}</strong>,</p>` +
      `<p>Your verification code for the <strong>Encyclopedia of AI Hallucinations</strong> is:</p>` +
      `<p style="font-size:1.6em;font-family:monospace;letter-spacing:0.2em;padding:0.6em 0;text-align:center">` +
      `${escape(code)}</p>` +
      `<p>It expires in 15 minutes. Enter it on the verification page to finish creating your account.</p>` +
      `<p><small>If you didn't try to create an account, ignore this email — the half-finished ` +
      `account will be deleted automatically.</small></p>`,
  );
  await send({ to, subject, text, html });
}

