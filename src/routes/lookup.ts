/**
 * GET /lookup — form asking for an email.
 * POST /lookup — emails the requester a list of all their submissions, with
 * tracking links. To prevent email enumeration we always return the same
 * "if we have any submissions on file for that address, we've emailed you"
 * page regardless of whether rows matched.
 *
 * We do NOT show the tracking codes on the page. They go only via email.
 */
import { h } from "../html.ts";
import { layout } from "../layout.ts";
import { query } from "../db.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { check as rateCheck } from "../ratelimit.ts";
import { sendLookupDigest } from "../email.ts";
import { formatEahId } from "../eah-id.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteHandler } from "./types.ts";

const EMAIL_MAX = 254;

/** Same regex used by submit.ts. Pragmatic, not RFC-strict. */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,63}$/;

function explainer() {
  return h`
    <p>If you submitted entries with an email address, paste that address
       here and we'll send you a single email with tracking links to all of
       them — so you can check status, see reviewer notes, or withdraw
       pending ones.</p>
    <p><small>To keep this from leaking which addresses are on file, we
       respond the same way whether or not we have any submissions for the
       address you give us. Check your inbox (and spam folder).</small></p>
  `;
}

function lookupForm(csrf: string, value: string) {
  return h`
    <form method="post" action="/lookup" class="track-form">
      <input type="hidden" name="_csrf" value="${csrf}">
      <label for="email">Email address</label>
      <input id="email" name="email" type="email" maxlength="${EMAIL_MAX}"
             value="${value}" autocomplete="off" required>
      <button type="submit">Send me my submissions</button>
    </form>
  `;
}

function confirmationPage(ctx: { admin: any }, setCookie?: string | null): Response {
  const body = h`
    <p>If we have any submissions on file for that email address, we've sent
       you an email with tracking links for each of them.</p>
    <p>Check your inbox (and spam folder). It may take a minute or two.</p>
    <p><a href="/">Home</a> · <a href="/track">Track by code instead</a></p>
  `;
  return htmlResponse(
    layout({ title: "Lookup · EAH", heading: "Check your inbox", body, admin: ctx.admin }),
    { setCookie: setCookie ?? null },
  );
}

export const lookupGet: RouteHandler = (req, ctx) => {
  const { token, setCookie } = tokenForRequest(req);
  const body = h`
    ${explainer()}
    ${lookupForm(token, "")}
  `;
  return htmlResponse(
    layout({ title: "Lookup by email · EAH", heading: "Lookup by email", body, admin: ctx.admin }),
    { setCookie },
  );
};

export const lookupPost: RouteHandler = async (req, ctx) => {
  // Rate-limit BEFORE parsing the form: we don't want an attacker to be able
  // to make us POST to Resend even at 1/sec.
  const rl = rateCheck("lookup", ctx.ip);
  if (!rl.allowed) {
    const body = h`<p>Too many lookup requests. Please retry in ${rl.retryAfterSec ?? 60} seconds.</p>`;
    return htmlResponse(
      layout({ title: "Rate limited · EAH", heading: "Slow down", body, admin: ctx.admin }),
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } },
    );
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    const body = h`<p>Invalid CSRF token. Reload the form and try again.</p>`;
    return htmlResponse(
      layout({ title: "Forbidden · EAH", heading: "Forbidden", body, admin: ctx.admin }),
      { status: 403 },
    );
  }

  const email = sanitizeText(form.get("email") ?? "").trim().toLowerCase();

  // Soft validation only — we don't tell the user the email was malformed,
  // because that's an enumeration leak. We just show the same confirmation.
  if (email.length === 0 || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) {
    return confirmationPage(ctx);
  }

  // submissions.notify_token holds the plaintext tracking code when (and
  // only when) an email was given at submit time. Rows that predate the
  // email feature have a null notify_token and we silently skip them — those
  // submitters have to use the tracking-code path.
  let rows: Array<{
    public_id: string;
    eah_number: number | null;
    title: string | null;
    notify_token: string | null;
    ai_model: string;
    submitted_at: Date;
    status: string;
  }>;
  try {
    rows = await query(
      `SELECT public_id, eah_number, title, notify_token, ai_model, submitted_at, status
         FROM submissions
        WHERE submitter_email = ?
        ORDER BY submitted_at DESC`,
      [email],
    );
  } catch (err) {
    console.error("[lookup] query failed:", err);
    return confirmationPage(ctx);
  }

  const submissions = rows
    .filter((r) => r.notify_token !== null && r.notify_token.length > 0)
    .map((r) => ({
      eahId: formatEahId(r.eah_number),
      trackingCode: r.notify_token as string,
      modelLabel: r.ai_model,
      title: r.title,
      status: r.status,
      submittedAt: new Date(r.submitted_at),
    }));

  if (submissions.length > 0) {
    // Fire and forget — sendLookupDigest never throws.
    await sendLookupDigest({ to: email, submissions });
  }

  return confirmationPage(ctx);
};
