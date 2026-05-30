/**
 * Account management.
 *
 *   GET  /admin/users        — all accounts (staff: read-only; owners: actions)
 *   GET  /admin/staff        — only privileged accounts (staff + owners)
 *   POST /admin/users/:id    — one endpoint, dispatched on the `action` field:
 *                                promote | demote | promote-owner | demote-owner
 *                                | suspend | unsuspend | delete
 *
 * Permission model:
 *   - VIEWING is open to all staff (ctx.admin). Staff who are NOT owners see a
 *     read-only listing with no action buttons — their only privilege over a
 *     normal user is managing the submission queue, not accounts.
 *   - MUTATING requires an owner (ctx.owner). Owners have all privileges,
 *     including promoting/demoting other owners.
 *
 * Why one POST endpoint instead of one-per-action: the actions all target the
 * same resource (a user row) and differ only in verb, so they share the same
 * gating, CSRF check, id parsing, and guards. The review flow
 * (src/routes/admin/review.ts) uses the same action-field shape.
 *
 * Guards:
 *   - You can't suspend or delete yourself (no locking yourself out).
 *   - You can't demote-owner or delete the last remaining owner.
 *   - "time out" (suspend) does NOT revoke sessions: a timed-out user can still
 *     log in and browse, they just can't submit (enforced in submit.ts).
 *   - delete is two-step: the first POST renders a confirmation page; only a
 *     POST with confirm=1 actually deletes (mirrors myWithdraw).
 */
import { h, raw, type SafeHtml } from "../../html.ts";
import { layout } from "../../layout.ts";
import { query, queryOne, execute } from "../../db.ts";
import { tokenForRequest, verifyCsrf } from "../../csrf.ts";
import { htmlResponse, parseForm, sanitizeText, type RouteContext } from "../types.ts";

// Allowlisted suspension windows. Keyed by the form value; value is the
// duration in milliseconds. An unknown key is rejected — we never feed an
// arbitrary number into an INTERVAL.
const SUSPEND_DURATIONS: Record<string, { ms: number; label: string }> = {
  "1h": { ms: 60 * 60 * 1000, label: "1 hour" },
  "1d": { ms: 24 * 60 * 60 * 1000, label: "1 day" },
  "3d": { ms: 3 * 24 * 60 * 60 * 1000, label: "3 days" },
  "7d": { ms: 7 * 24 * 60 * 60 * 1000, label: "7 days" },
  "30d": { ms: 30 * 24 * 60 * 60 * 1000, label: "30 days" },
};

// The two pages this router serves. Used to validate the `return_to` field so
// an action redirects back to the page it was triggered from (and nowhere a
// crafted form could point it).
const RETURN_TARGETS = new Set(["/admin/users", "/admin/staff"]);

interface UserRow {
  id: number;
  username: string;
  email: string;
  email_verified: number;
  is_admin: number;
  is_owner: number;
  created_at: Date | null;
  last_login_at: Date | null;
  suspended_until: Date | null;
  suspended_reason: string | null;
}

function roleLabel(u: UserRow): string {
  if (u.is_owner === 1) return "owner";
  if (u.is_admin === 1) return "staff";
  return "user";
}

function authRedirect(): Response {
  return new Response(null, { status: 303, headers: { Location: "/login" } });
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function isSuspended(u: UserRow): boolean {
  return !!u.suspended_until && new Date(u.suspended_until).getTime() > Date.now();
}

async function badRequest(message: string, status = 400): Promise<Response> {
  const body = await layout({
    title: "Bad request",
    heading: "Bad request",
    body: h`<p>${message} <a href="/admin/users">Back to users</a>.</p>`,
  });
  return htmlResponse(body, { status });
}

// ─── rendering ────────────────────────────────────────────────────────────────

function actionForm(
  userId: number,
  action: string,
  label: string,
  csrf: string,
  returnTo: string,
  opts: { danger?: boolean } = {},
): SafeHtml {
  return h`<form class="inline-form" method="post" action="/admin/users/${userId}">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="action" value="${action}">
    <input type="hidden" name="return_to" value="${returnTo}">
    <button class="linkbutton ${opts.danger ? raw("btn-danger") : raw("")}" type="submit">${label}</button>
  </form>`;
}

function suspendForm(u: UserRow, csrf: string, returnTo: string): SafeHtml {
  return h`<form class="inline-form suspend-form" method="post" action="/admin/users/${u.id}">
    <input type="hidden" name="_csrf" value="${csrf}">
    <input type="hidden" name="action" value="suspend">
    <input type="hidden" name="return_to" value="${returnTo}">
    <select name="duration">
      ${Object.entries(SUSPEND_DURATIONS).map(
        ([key, { label }]) => h`<option value="${key}">${label}</option>`,
      )}
    </select>
    <input type="text" name="reason" maxlength="500" placeholder="reason (shown to the user)">
    <button class="linkbutton" type="submit">time out</button>
  </form>`;
}

function rowActions(u: UserRow, selfId: number, csrf: string, returnTo: string): SafeHtml {
  if (u.id === selfId) return h`<span class="muted">(you)</span>`;

  const staffAction = u.is_admin === 1
    ? actionForm(u.id, "demote", "remove staff", csrf, returnTo)
    : actionForm(u.id, "promote", "make staff", csrf, returnTo);

  const ownerAction = u.is_owner === 1
    ? actionForm(u.id, "demote-owner", "remove owner", csrf, returnTo, { danger: true })
    : actionForm(u.id, "promote-owner", "make owner", csrf, returnTo);

  const suspendControl = isSuspended(u)
    ? actionForm(u.id, "unsuspend", "lift timeout", csrf, returnTo)
    : suspendForm(u, csrf, returnTo);

  const deleteControl = actionForm(u.id, "delete", "delete", csrf, returnTo, { danger: true });

  return h`${staffAction} · ${ownerAction} · ${suspendControl} · ${deleteControl}`;
}

function statusCell(u: UserRow): SafeHtml {
  if (!isSuspended(u)) return raw("active");
  return h`timed out until ${fmtDate(u.suspended_until)}${
    u.suspended_reason ? h` — “${u.suspended_reason}”` : raw("")
  }`;
}

function renderTable(
  rows: UserRow[],
  selfId: number,
  csrf: string,
  returnTo: string,
  canManage: boolean,
): SafeHtml {
  if (rows.length === 0) return h`<p><em>No accounts.</em></p>`;
  return h`
    <table class="all">
      <thead>
        <tr>
          <th>id</th>
          <th>username</th>
          <th>email</th>
          <th>verified</th>
          <th>role</th>
          <th>created</th>
          <th>last login</th>
          <th>status</th>
          ${canManage ? h`<th>actions</th>` : raw("")}
        </tr>
      </thead>
      <tbody>
        ${rows.map((u) => h`
          <tr>
            <td>${u.id}</td>
            <td>${u.username}</td>
            <td>${u.email}</td>
            <td>${u.email_verified === 1 ? raw("✓") : raw("—")}</td>
            <td>${roleLabel(u)}</td>
            <td>${fmtDate(u.created_at)}</td>
            <td>${fmtDate(u.last_login_at)}</td>
            <td>${statusCell(u)}</td>
            ${canManage ? h`<td>${rowActions(u, selfId, csrf, returnTo)}</td>` : raw("")}
          </tr>
        `)}
      </tbody>
    </table>
  `;
}

async function renderListing(
  req: Request,
  ctx: RouteContext,
  opts: { staffOnly: boolean },
): Promise<Response> {
  const { token: csrf, setCookie } = tokenForRequest(req);
  const returnTo = opts.staffOnly ? "/admin/staff" : "/admin/users";
  const canManage = !!ctx.owner;

  const rows = await query<UserRow>(
    `SELECT id, username, email, email_verified, is_admin, is_owner,
            created_at, last_login_at, suspended_until, suspended_reason
       FROM users
       ${opts.staffOnly ? "WHERE is_admin = 1 OR is_owner = 1" : ""}
       ORDER BY is_owner DESC, is_admin DESC, created_at ASC`,
  );

  const heading = opts.staffOnly ? "staff" : "users";
  const readOnlyNote = canManage
    ? raw("")
    : h`<p class="muted"><em>Read-only.</em> Only owners can manage accounts.</p>`;
  const blurb = opts.staffOnly
    ? h`<p class="muted">Privileged accounts (staff and owners). Owners have all privileges,
        including managing other owners; staff can only manage the submission queue.</p>`
    : h`<p class="muted">All accounts. <a href="/admin/staff">View privileged accounts only →</a></p>`;

  const body = h`
    ${blurb}
    ${readOnlyNote}
    ${renderTable(rows, ctx.user!.userId, csrf, returnTo, canManage)}
  `;

  const html = await layout({
    title: `${heading} · ENAIH`,
    heading,
    body,
    user: ctx.user,
    csrfToken: csrf,
    bodyClass: "admin-wide",
  });
  return htmlResponse(html, { setCookie });
}

export async function getUsers(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();
  return renderListing(req, ctx, { staffOnly: false });
}

export async function getStaff(req: Request, ctx: RouteContext): Promise<Response> {
  if (!ctx.admin) return authRedirect();
  return renderListing(req, ctx, { staffOnly: true });
}

// ─── actions ────────────────────────────────────────────────────────────────

async function ownerCount(): Promise<number> {
  const row = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE is_owner = 1");
  return Number(row?.n ?? 0);
}

export async function postUserAction(req: Request, ctx: RouteContext): Promise<Response> {
  // Mutating accounts requires owner. Staff (admins who aren't owners) can view
  // the listing but get no buttons; a crafted POST from them is rejected here.
  if (!ctx.owner) return badRequest("Only owners can manage accounts.", 403);

  const idStr = ctx.params.id;
  const id = idStr && /^\d+$/.test(idStr) ? parseInt(idStr, 10) : NaN;
  if (!Number.isFinite(id) || id <= 0) return badRequest("Invalid user id.", 404);

  let form: URLSearchParams;
  try {
    form = await parseForm(req, 8 * 1024);
  } catch {
    return badRequest("Form too large or malformed.", 413);
  }
  if (!verifyCsrf(req, form.get("_csrf"))) return badRequest("Invalid CSRF token.", 403);

  const action = form.get("action") ?? "";
  const returnToRaw = form.get("return_to") ?? "/admin/users";
  const returnTo = RETURN_TARGETS.has(returnToRaw) ? returnToRaw : "/admin/users";
  const redirectBack = () => new Response(null, { status: 303, headers: { Location: returnTo } });

  const target = await queryOne<{ id: number; username: string; is_admin: number; is_owner: number }>(
    "SELECT id, username, is_admin, is_owner FROM users WHERE id = ?",
    [id],
  );
  if (!target) return badRequest("User not found.", 404);

  const isSelf = target.id === ctx.owner.userId;

  switch (action) {
    case "promote": {
      await execute("UPDATE users SET is_admin = 1 WHERE id = ?", [id]);
      return redirectBack();
    }

    case "demote": {
      await execute("UPDATE users SET is_admin = 0 WHERE id = ?", [id]);
      return redirectBack();
    }

    case "promote-owner": {
      await execute("UPDATE users SET is_owner = 1 WHERE id = ?", [id]);
      return redirectBack();
    }

    case "demote-owner": {
      if (target.is_owner === 1 && (await ownerCount()) <= 1) {
        return badRequest("Can't remove the last remaining owner.");
      }
      await execute("UPDATE users SET is_owner = 0 WHERE id = ?", [id]);
      return redirectBack();
    }

    case "suspend": {
      if (isSelf) return badRequest("You can't time yourself out.");
      const dur = SUSPEND_DURATIONS[form.get("duration") ?? ""];
      if (!dur) return badRequest("Invalid suspension duration.");
      const reason = sanitizeText(form.get("reason") ?? "").trim().slice(0, 500);
      const until = new Date(Date.now() + dur.ms);
      // No session kick: a timed-out user can stay logged in and browse; the
      // submit/propose handlers are what actually block them.
      await execute(
        "UPDATE users SET suspended_until = ?, suspended_reason = ? WHERE id = ?",
        [until, reason.length > 0 ? reason : null, id],
      );
      return redirectBack();
    }

    case "unsuspend": {
      await execute("UPDATE users SET suspended_until = NULL, suspended_reason = NULL WHERE id = ?", [id]);
      return redirectBack();
    }

    case "delete": {
      if (isSelf) return badRequest("You can't delete your own account here.");
      if (target.is_owner === 1 && (await ownerCount()) <= 1) {
        return badRequest("Can't delete the last remaining owner.");
      }
      if (form.get("confirm") !== "1") {
        // Two-step: render a confirmation page. FK rules detach the account's
        // submissions (owner_user_id → NULL) rather than deleting them.
        const { token: csrf, setCookie } = tokenForRequest(req);
        const body = h`
          <p>Delete account <strong>${target.username}</strong> (id ${target.id})? This is permanent.
          Their submissions are kept but unlinked from the account; their sessions are revoked.</p>
          <form method="post" action="/admin/users/${target.id}">
            <input type="hidden" name="_csrf" value="${csrf}">
            <input type="hidden" name="action" value="delete">
            <input type="hidden" name="confirm" value="1">
            <input type="hidden" name="return_to" value="${returnTo}">
            <button type="submit" class="btn-danger">Delete account</button>
          </form>
          <p><a href="${returnTo}">Cancel</a></p>
        `;
        return htmlResponse(
          await layout({ title: "Delete account · ENAIH", heading: "Delete account", body, user: ctx.user, csrfToken: csrf }),
          { setCookie },
        );
      }
      // FK ON DELETE CASCADE clears user_sessions; SET NULL detaches
      // submissions / messages / version rows. Safe single statement.
      await execute("DELETE FROM users WHERE id = ?", [id]);
      return redirectBack();
    }

    default:
      return badRequest("Unknown action.");
  }
}
