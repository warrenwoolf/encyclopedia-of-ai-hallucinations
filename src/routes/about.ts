/**
 * GET /about — static explanatory page.
 */
import { h } from "../html.ts";
import { layout } from "../layout.ts";
import { CATEGORIES } from "../categories.ts";
import { htmlResponse, type RouteHandler } from "./types.ts";

export const about: RouteHandler = (_req, ctx) => {
  const body = h`
    <p><strong>What is EAH?</strong> The <strong>Encyclopedia of AI
       Hallucinations</strong> is a community-maintained database of real,
       reproducible AI hallucinations — confident-but-wrong outputs produced
       by real, named AI systems. It exists because these failures are
       scattered across social media, papers, and screenshots, and there is
       no single place to look them up, cite them, or browse them by kind.
       Our goal is to make it easy to find concrete examples so that
       researchers, journalists, and ordinary users can build calibrated
       intuition about when to trust these models and when not to.</p>

    <p><strong>What qualifies as an entry?</strong> Entries must be:</p>
    <ul>
      <li><strong>Real.</strong> Produced by an actual, named AI system —
          not a hypothetical or a roleplay.</li>
      <li><strong>Reproducible.</strong> Anyone running the same prompt
          against the same model should have a reasonable chance of seeing
          similar behavior, or there should be a shared chat link
          demonstrating the original session.</li>
      <li><strong>Documented.</strong> The prompt and the model's response
          are recorded verbatim.</li>
      <li><strong>Verifiable as wrong.</strong> There is a clear
          ground-truth fact against which the output is false.</li>
      <li><strong>Reviewed.</strong> A human staff member checks every
          submission before it appears publicly.</li>
    </ul>
    <p>We do not accept fabricated, dramatized, or made-up "hallucinations."
       The point is to catalog what these systems actually do, not what we
       imagine they might.</p>

    <p><strong>Why the strawberry?</strong> The logo is a strawberry — a nod
       to the once-famous failure where many large language models, asked
       how many R's are in "strawberry," confidently answered two. It is a
       small, vivid example of the kind of error this site exists to
       document.</p>

    <p><strong>How to submit.</strong> Anyone can submit. Go to
       <a href="/submit">/submit</a> and paste the prompt, the model's
       response, the model name, a category, and (ideally) a shared chat
       link so reviewers can confirm the session. You may include an email
       address; see below.</p>

    <p><strong>How review works.</strong> Each submission goes into a queue
       and is read by a human staff reviewer. Accepted entries are assigned
       a permanent identifier of the form <code>A000123</code> — the
       numbering scheme is borrowed from the
       <a href="https://oeis.org/">On-Line Encyclopedia of Integer
       Sequences</a> (OEIS), which we admire. A-numbers are assigned at
       submission time and are reserved while the draft is pending; if a
       submission is rejected, its A-number is freed and may be reused by a
       later entry. Each submitter may have at most <strong>four
       pending drafts</strong> per email address at any time. While a draft
       is in review you can chat with the reviewer in a shared thread
       attached to the submission — useful for clarifying questions about
       reproducibility or scope.</p>

    <p><strong>Tracking codes.</strong> When you submit, you get a one-time
       tracking code. Save it — the website never shows it again. It lets
       you check your submission's review status, see reviewer notes, or
       withdraw a pending submission via <a href="/track">/track</a>.</p>

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

    <p><strong>How to cite an entry.</strong> Citations are informal. A
       reasonable format is:</p>
    <p class="muted"><em>Encyclopedia of AI Hallucinations</em>, entry
       A000123 ("Entry Title"), submitted YYYY-MM-DD.
       https://eah.warrenwoolf.com/e/A000123</p>
    <p>Adjust to match your venue's style. The A-number and the URL are
       the stable parts.</p>

    <p><strong>Categories</strong> currently include:
       ${CATEGORIES.map((c, i) => h`${i > 0 ? ", " : ""}${c.label}`)}.
       The category list is intentionally short and may evolve as patterns
       become clearer.</p>

    <p><strong>Who we are.</strong> Founded in 2026 by Rudra Jadhav and
       Warren Woolf.</p>

    <p><strong>Joining the staff team.</strong> We do not yet have a formal
       application process. If you would like to help review submissions,
       email the contact address listed on the
       <a href="/privacy">privacy page</a>.</p>

    <p><strong>Source code.</strong> The site is open source:
       <a href="https://github.com/warrenwoolf/encyclopedia-of-ai-hallucinations">github.com/warrenwoolf/encyclopedia-of-ai-hallucinations</a>.</p>

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
