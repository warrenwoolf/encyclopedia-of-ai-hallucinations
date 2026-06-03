/**
 * Shared rendering helpers for the submitter-facing submission pages
 * (my.ts + my-discussion.ts). Kept in its own module so both can import them
 * without a circular dependency.
 */
import { h, type SafeHtml } from "../html.ts";

const STATUS_LABELS: Record<string, string> = {
  draft: "draft",
  pending: "pending acceptance",
  published: "active",
  unreviewed: "pending review",
  reviewed: "reviewed",
  rejected: "rejected",
  withdrawn: "withdrawn",
  // legacy values (no live rows after the tier migration, kept for safety)
};

/** Human-facing label for a moderation status (submitter vocabulary). */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusBadge(status: string): SafeHtml {
  return h`<span class="status-badge status-${status}">${statusLabel(status)}</span>`;
}

/** True for the hidden pre-review tier. */
export function isPendingReview(status: string): boolean {
  return status === "unreviewed" || status === "pending";
}

/** True for the hidden post-review, pre-acceptance tier. */
export function isPendingAcceptance(status: string, reproStatus: string): boolean {
  return status === "reviewed" && reproStatus === "pending";
}

/** True for the public canonical tier. */
export function isPublicByDefault(status: string, reproStatus: string): boolean {
  return status === "reviewed" && reproStatus === "reproduced";
}

function tierClass(status: string, reproStatus: string): string {
  if (status === "draft") return "draft";
  if (status === "withdrawn") return "withdrawn";
  if (status === "rejected" || reproStatus === "failed") return "rejected";
  if (isPendingReview(status)) return "pending-review";
  if (isPendingAcceptance(status, reproStatus)) return "pending-acceptance";
  if (isPublicByDefault(status, reproStatus) || status === "published") return "active";
  return status;
}

/**
 * Combined tier label across both axes (status + repro_status), the submitter-
 * facing name for the trust ladder.
 */
export function tierLabel(status: string, reproStatus: string): string {
  if (status === "draft") return "draft";
  if (status === "withdrawn") return "withdrawn";
  if (isPendingReview(status)) return "pending review";
  if (isPendingAcceptance(status, reproStatus)) return "pending acceptance";
  if (isPublicByDefault(status, reproStatus) || status === "published") return "active";
  if (status === "rejected" || reproStatus === "failed") return "rejected";
  return statusLabel(status);
}

/** Badge variant of {@link tierLabel}; CSS class keys off the combined tier. */
export function tierBadge(status: string, reproStatus: string): SafeHtml {
  const tier = tierClass(status, reproStatus);
  return h`<span class="status-badge status-${tier}">${tierLabel(status, reproStatus)}</span>`;
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
 * Actions by status (the tiered flow):
 *   - draft      → submit for review (draft→pending review), delete (removes it)
 *   - unreviewed → withdraw (pending review→draft)
 *   - reviewed   → view entry (read-only here)
 * To both leave the queue and discard, a user withdraws then deletes (two steps).
 *
 * `slug` is the submission's public_id (owner routes are addressed by slug now,
 * since A-numbers only exist once an entry is reproduced). `eahId` is the
 * formatted A-number for the public-entry link, or "" — the entry page resolves
 * the slug too, so we fall back to it.
 */
export function actionBar(slug: string, status: string, token: string, eahId = ""): SafeHtml {
  const overview = h`<a href="/my/submissions/${slug}">overview</a>`;
  const edit = h`<a href="/my/submissions/${slug}/edit">edit</a>`;
  const discussion = h`<a href="/my/submissions/${slug}/discussion">discussion</a>`;
  const history = h`<a href="/my/submissions/${slug}/history">history</a>`;
  const mySubs = h`<a href="/my/submissions">my submissions</a>`;

  if (status === "draft") {
    const propose = h`<form class="inline-form" method="post" action="/my/submissions/${slug}/propose">
        <input type="hidden" name="_csrf" value="${token}">
        <button class="linkbutton" type="submit">submit for review</button>
      </form>`;
    const del = h`<a class="del-link" href="/my/submissions/${slug}/delete">delete</a>`;
    return h`<p class="action-bar">${overview} · ${edit} · ${discussion} · ${history} · ${propose} · ${del} · ${mySubs}</p>`;
  }
  if (status === "unreviewed") {
    const withdraw = h`<a href="/my/submissions/${slug}/withdraw">withdraw</a>`;
    return h`<p class="action-bar">${overview} · ${edit} · ${discussion} · ${history} · ${withdraw} · ${mySubs}</p>`;
  }
  if (status === "reviewed") {
    return h`<p class="action-bar"><a href="/e/${eahId || slug}">view entry</a> · ${overview} · ${history} · ${mySubs}</p>`;
  }
  // rejected / withdrawn — terminal, just a way back.
  return h`<p class="action-bar">${mySubs}</p>`;
}
