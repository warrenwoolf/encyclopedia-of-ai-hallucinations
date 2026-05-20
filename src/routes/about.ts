/**
 * GET /about — static explanatory page.
 */
import { h } from "../html.ts";
import { layout } from "../layout.ts";
import { CATEGORIES } from "../categories.ts";
import { htmlResponse, type RouteHandler } from "./types.ts";

export const about: RouteHandler = (_req, ctx) => {
  const body = h`
    <p>The <strong>Encyclopedia of AI Hallucinations</strong> (EAH) is an
       OEIS-style catalog of confident-but-wrong outputs from large language
       models. The goal is to make these failures searchable, citable, and
       comparable across models — instead of disappearing into screenshots
       on social media.</p>

    <p><strong>Anyone can submit.</strong> No account is required. You paste
       the exact prompt you sent, the model's response, the model name, and a
       short categorization. A staff reviewer checks each submission before
       it appears publicly, to keep the catalog signal-rich and to filter out
       obviously-fake or unreproducible material.</p>

    <p><strong>Tracking codes.</strong> When you submit, you get a one-time
       tracking code. Save it — we never show it again. It lets you check
       your submission's review status, see any rejection reason, or withdraw
       a pending submission.</p>

    <p><strong>Categories</strong> currently include:
       ${CATEGORIES.map((c, i) => h`${i > 0 ? ", " : ""}${c.label}`)}.
       The category list is intentionally short and may evolve as patterns
       become clearer.</p>

    <p><strong>This site is in development.</strong> The schema, the URL
       structure, and the rules may change. Don't rely on any specific entry
       persisting yet. When things stabilize this notice will come down.</p>

    <p class="muted">Initial scaffolding written by Claude (Anthropic), May 2026.</p>
  `;
  return htmlResponse(layout({
    title: "About · EAH",
    heading: "About",
    body,
    admin: ctx.admin,
  }));
};
