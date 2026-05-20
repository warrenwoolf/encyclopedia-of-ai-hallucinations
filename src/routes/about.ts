/**
 * GET /about — static explanatory page.
 */
import { h } from "../html.ts";
import { layout } from "../layout.ts";
import { CATEGORIES } from "../categories.ts";
import { htmlResponse, type RouteHandler } from "./types.ts";

export const about: RouteHandler = (_req, ctx) => {
  const body = h`
    <p>The <strong>Encyclopedia of AI Hallucinations</strong> (EAH) is a catalog of confident-but-wrong outputs from large language models. Our goal is to make it easy to find real-world examples of such misbehavior in order to help people understand when to trust and when to distrust these models.</p>

    <p><strong>Anyone can submit.</strong> Simply paste the prompt you sent, the model's response, the model name, a category, and an optional chat link. A staff reviewer checks each submission before it appears publicly, to keep out fake or unreproducible examples.</p>

    <p><strong>Tracking codes.</strong> When you submit, you get a one-time
       tracking code. Save it — the website never shows it again. It lets you
       check your submission's review status, see reviewer notes, or withdraw
       a pending submission via <a href="/track">/track</a>.</p>

    <p><strong>Email (optional).</strong> You may give an email address with
       your submission. If you do:</p>
    <ul>
      <li>We send a confirmation email right away, containing the tracking
          link (so you don't have to save the code by hand).</li>
      <li>We send a second email when staff accept or reject your
          submission, including any reviewer notes.</li>
      <li>You can use <a href="/lookup">/lookup</a> any time to be emailed
          tracking links for all your submissions at once — handy if you've
          submitted more than one entry and don't want to keep track of
          multiple codes.</li>
    </ul>
    <p>See the <a href="/privacy">privacy policy</a> for what we do with
       email addresses.</p>

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
