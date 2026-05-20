/**
 * GET /track — look up a submission by tracking code.
 * POST /track/withdraw — withdraw a pending submission.
 *
 * We never confirm whether a code exists; a wrong code just says "no submission".
 */
import { createHash } from "node:crypto";
import { h } from "../html.ts";
import { layout } from "../layout.ts";
import { queryOne, execute } from "../db.ts";
import { tokenForRequest, verifyCsrf } from "../csrf.ts";
import { check as rateCheck } from "../ratelimit.ts";
import { categoryLabel } from "../categories.ts";
import { htmlResponse, parseForm, type RouteHandler } from "./types.ts";

const CODE_MAXLEN = 100;

interface SubmissionRow {
  public_id: string;
  ai_model: string;
  category: string;
  submitted_at: Date;
  status: string;
  rejection_reason: string | null;
}

function ymd(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function trackExplainer() {
  return h`
    <p>A <strong>tracking code</strong> is a short string you receive after
       submitting a hallucination. Paste it below to:</p>
    <ul>
      <li>check whether your submission has been reviewed,</li>
      <li>see the rejection reason if it was rejected, or</li>
      <li>withdraw the submission while it's still pending.</li>
    </ul>
    <p>If you didn't save your code when you submitted, there's no way to
       recover it — just resubmit the entry.</p>
  `;
}

function lookupForm(opts: { csrf: string; code: string }) {
  return h`
    <form action="/track" method="get" class="track-form">
      <label for="code">Tracking code</label>
      <input id="code" name="code" type="text" maxlength="${CODE_MAXLEN}"
             value="${opts.code}" autocomplete="off" required>
      <button type="submit">Look up</button>
    </form>
  `;
}

export const trackGet: RouteHandler = async (req, ctx) => {
  const { token, setCookie } = tokenForRequest(req);
  const code = (ctx.url.searchParams.get("code") ?? "").trim();

  // No code yet — show the explainer and the lookup form.
  if (!code) {
    const body = h`
      ${trackExplainer()}
      ${lookupForm({ csrf: token, code: "" })}
    `;
    return htmlResponse(
      layout({ title: "Track · EAH", heading: "Track a submission", body, admin: ctx.admin }),
      { setCookie },
    );
  }

  if (code.length > CODE_MAXLEN) {
    const body = h`
      ${lookupForm({ csrf: token, code: "" })}
      <p>No submission with that code.</p>
    `;
    return htmlResponse(
      layout({ title: "Track · EAH", heading: "Track a submission", body, admin: ctx.admin }),
      { setCookie },
    );
  }

  const hash = createHash("sha256").update(code).digest();
  const row = await queryOne<SubmissionRow>(
    `SELECT public_id, ai_model, category, submitted_at, status, rejection_reason
       FROM submissions
       WHERE tracking_hash = ?`,
    [hash],
  );

  if (!row) {
    const body = h`
      ${lookupForm({ csrf: token, code })}
      <p>No submission with that code.</p>
    `;
    return htmlResponse(
      layout({ title: "Track · EAH", heading: "Track a submission", body, admin: ctx.admin }),
      { setCookie },
    );
  }

  // Status-specific section.
  let statusSection;
  if (row.status === "pending") {
    statusSection = h`
      <p>Your submission is in the review queue.</p>
      <form method="post" action="/track/withdraw" class="withdraw-form">
        <input type="hidden" name="_csrf" value="${token}">
        <input type="hidden" name="code" value="${code}">
        <button type="submit">Withdraw this submission</button>
      </form>
    `;
  } else if (row.status === "published") {
    statusSection = h`
      <p>Your submission has been published:
        <a href="/e/${row.public_id}"><code>${row.public_id}</code></a>.</p>
    `;
  } else if (row.status === "rejected") {
    statusSection = h`
      <p>Your submission was rejected.</p>
      ${row.rejection_reason
        ? h`<p><strong>Reason:</strong> ${row.rejection_reason}</p>`
        : h`<p><em>No reason given.</em></p>`}
    `;
  } else if (row.status === "withdrawn") {
    statusSection = h`<p>This submission has been withdrawn.</p>`;
  } else {
    statusSection = h`<p>Status: ${row.status}</p>`;
  }

  const body = h`
    ${lookupForm({ csrf: token, code })}

    <dl class="entry-meta">
      <dt>Public ID</dt><dd><code>${row.public_id}</code></dd>
      <dt>AI Model</dt><dd>${row.ai_model}</dd>
      <dt>Category</dt><dd>${categoryLabel(row.category)}</dd>
      <dt>Submitted</dt><dd>${ymd(row.submitted_at)}</dd>
      <dt>Status</dt><dd><strong>${row.status}</strong></dd>
    </dl>

    ${statusSection}
  `;

  return htmlResponse(
    layout({ title: "Track · EAH", heading: "Track a submission", body, admin: ctx.admin }),
    { setCookie },
  );
};

export const trackWithdrawPost: RouteHandler = async (req, ctx) => {
  const rl = rateCheck("withdraw", ctx.ip);
  if (!rl.allowed) {
    const body = h`<p>Too many withdrawal requests. Please retry in ${rl.retryAfterSec ?? 60} seconds.</p>`;
    return htmlResponse(
      layout({ title: "Rate limited · EAH", heading: "Slow down", body, admin: ctx.admin }),
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } },
    );
  }

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    const body = h`<p>Request too large.</p>`;
    return htmlResponse(
      layout({ title: "Error · EAH", heading: "Error", body, admin: ctx.admin }),
      { status: 413 },
    );
  }

  if (!verifyCsrf(req, form.get("_csrf"))) {
    const body = h`<p>Invalid CSRF token. Reload the form and try again.</p>`;
    return htmlResponse(
      layout({ title: "Forbidden · EAH", heading: "Forbidden", body, admin: ctx.admin }),
      { status: 403 },
    );
  }

  const code = (form.get("code") ?? "").trim();
  if (!code || code.length > CODE_MAXLEN) {
    // Treat as a no-op redirect so we don't leak anything.
    return new Response(null, { status: 303, headers: { Location: "/track" } });
  }

  const hash = createHash("sha256").update(code).digest();
  const row = await queryOne<{ id: number; status: string }>(
    "SELECT id, status FROM submissions WHERE tracking_hash = ?",
    [hash],
  );

  if (row && row.status === "pending") {
    await execute(
      "UPDATE submissions SET status = 'withdrawn' WHERE id = ? AND status = 'pending'",
      [row.id],
    );
  }

  // Redirect back regardless — view will show the new status (or "no submission").
  const target = `/track?code=${encodeURIComponent(code)}`;
  return new Response(null, { status: 303, headers: { Location: target } });
};
