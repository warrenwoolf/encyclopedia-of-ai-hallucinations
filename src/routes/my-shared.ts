/**
 * Shared rendering helpers for the submitter-facing submission pages
 * (my.ts + my-discussion.ts). Kept in its own module so both can import them
 * without a circular dependency.
 */
import { h, type SafeHtml } from "../html.ts";

const STATUS_LABELS: Record<string, string> = {
  draft: "draft",
  pending: "proposed",
  published: "published",
  rejected: "rejected",
  withdrawn: "withdrawn",
};

/** Human-facing label for a moderation status (submitter vocabulary). */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusBadge(status: string): SafeHtml {
  return h`<span class="status-badge status-${status}">${statusLabel(status)}</span>`;
}

/**
 * The full set of management actions for an owned submission, rendered as one
 * inline bar. Shown identically on every page for a submission (overview,
 * edit, history, discussion) so the controls are always reachable.
 *
 * Placement rule: this bar must sit OUTSIDE any other <form>. The propose
 * control is itself a tiny form; withdraw and delete are links to GET
 * confirmation pages (which then POST), so the bar nests safely as long as it
 * isn't dropped inside another form element.
 *
 * Actions by status (the simplified flow):
 *   - draft   → propose (draft→pending), delete (removes it)
 *   - pending → withdraw (pending→draft)
 * To both stop reviewing and discard, a user withdraws then deletes (two steps).
 */
export function actionBar(eahId: string, status: string, token: string): SafeHtml {
  const overview = h`<a href="/my/submissions/${eahId}">overview</a>`;
  const edit = h`<a href="/my/submissions/${eahId}/edit">edit</a>`;
  const discussion = h`<a href="/my/submissions/${eahId}/discussion">discussion</a>`;
  const history = h`<a href="/my/submissions/${eahId}/history">history</a>`;
  const mySubs = h`<a href="/my/submissions">my submissions</a>`;

  if (status === "draft") {
    const propose = h`<form class="inline-form" method="post" action="/my/submissions/${eahId}/propose">
        <input type="hidden" name="_csrf" value="${token}">
        <button class="linkbutton" type="submit">propose for review</button>
      </form>`;
    const del = h`<a class="del-link" href="/my/submissions/${eahId}/delete">delete</a>`;
    return h`<p class="action-bar">${overview} · ${edit} · ${discussion} · ${history} · ${propose} · ${del} · ${mySubs}</p>`;
  }
  if (status === "pending") {
    const withdraw = h`<a href="/my/submissions/${eahId}/withdraw">withdraw from review</a>`;
    return h`<p class="action-bar">${overview} · ${edit} · ${discussion} · ${history} · ${withdraw} · ${mySubs}</p>`;
  }
  if (status === "published") {
    return h`<p class="action-bar"><a href="/e/${eahId}">view public entry</a> · ${overview} · ${history} · ${mySubs}</p>`;
  }
  // rejected / withdrawn — the A-number is usually freed, so detail links 404.
  return h`<p class="action-bar">${mySubs}</p>`;
}
