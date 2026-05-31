/**
 * GET /contact — single point of contact for everything that doesn't have its
 * own form: bug reports, patch/correction notices, suggestions, problem
 * reports, and staff applications. One inbox (contact@enaih.org) keeps it
 * simple; Cloudflare Email Routing forwards it to the maintainers.
 */
import { h } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { type RouteHandler } from "./types.ts";

const CONTACT_EMAIL = "contact@enaih.org";

export const contact: RouteHandler = (req, ctx) => {
  const mailto = h`<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;
  const body = h`
    <p>Reach the maintainers at ${mailto}. One inbox covers everything below —
       just say which it is in the subject line so we can route it quickly.</p>

    <h2>What to write about</h2>
    <dl>
      <dt><strong>Bug reports</strong></dt>
      <dd>Something on the site is broken, looks wrong, or behaves oddly. Tell us
          what you did, what you expected, and what happened (a screenshot and the
          page URL help a lot).</dd>

      <dt><strong>Patches &amp; corrections</strong></dt>
      <dd>An entry is out of date — the model no longer reproduces the
          hallucination, or a detail is wrong. Include the entry's A-number and
          what should change.</dd>

      <dt><strong>Problems with a submission</strong></dt>
      <dd>An entry looks fabricated, miscategorized, duplicated, or otherwise
          shouldn't be live. Send the A-number and what's wrong.</dd>

      <dt><strong>Suggestions</strong></dt>
      <dd>Ideas for features, categories, or anything that would make ENAIH more
          useful. We read all of them.</dd>

      <dt><strong>Staff applications</strong></dt>
      <dd>Want to help review the submission queue? Tell us a bit about yourself
          and why you'd be a good reviewer.</dd>
    </dl>

    <p class="muted">For submitting a hallucination, use the
       <a href="/submit">submission form</a> instead — it captures the structured
       fields reviewers need.</p>
  `;
  return pageResponse(req, {
    title: "Contact · ENAIH",
    heading: "Contact",
    bodyClass: "text-page",
    body,
    user: ctx.user,
  });
};
