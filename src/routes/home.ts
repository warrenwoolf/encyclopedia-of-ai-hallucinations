/**
 * GET / — landing page.
 *
 * Top bar (from the layout), a one-line site description, the published-entry
 * count, and a "submit" CTA — then the browse view rendered inline (search
 * form, filters, listing, pagination) so the home page is the browse page from
 * the search section down. The browse body is shared via renderBrowseBody.
 */
import { h, raw } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { queryOne } from "../db.ts";
import { renderBrowseBody } from "./browse.ts";
import { type RouteHandler } from "./types.ts";

export const home: RouteHandler = async (req, ctx) => {
  const countRow = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM submissions WHERE status = 'reviewed'",
  );
  const total = Number(countRow?.n ?? 0);

  const intro = h`
    <div class="home-top">
      <p class="tagline"><em>A community-maintained database of real, reproducible AI hallucinations.</em></p>

      <p>There ${total === 1 ? raw("is") : raw("are")}
         currently <strong>${total}</strong> reviewed ${total === 1 ? raw("entry") : raw("entries")}.</p>

      <p><a class="cta" href="/submit">Submit a hallucination</a></p>
    </div>
  `;

  const browseBody = await renderBrowseBody(ctx);

  const body = h`
    ${intro}
    ${browseBody}
  `;

  return pageResponse(req, {
    title: "Encyclopedia of AI Hallucinations",
    body,
    user: ctx.user,
    bodyClass: "browse-page home-page",
  });
};
