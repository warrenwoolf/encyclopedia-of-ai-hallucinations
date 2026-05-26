/**
 * GET /guide — submission guide, FAQ, and category reference.
 */
import { h } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { CATEGORIES } from "../categories.ts";
import { type RouteHandler } from "./types.ts";

export const guide: RouteHandler = (req, ctx) => {
    const categoryList = h`
    <dl>
      ${CATEGORIES.map((c) => h`
        <dt><strong>${c.label}</strong></dt>
        <dd>${c.description}</dd>
      `)}
    </dl>
  `;

    const body = h`
    <h2>What qualifies as an entry?</h2>
    <p>Entries must be:</p>
    <ul>
      <li><strong>Real.</strong> Produced by an actual, named AI system — not a
          hypothetical or a roleplay.</li>
      <li><strong>Reproducible.</strong> Anyone running the same prompt should
          have a reasonable chance of seeing similar behavior, OR there is a
          shared chat link demonstrating the session. Entries that were
          reproducible at submission time but later patched by the AI company
          remain in EAH permanently under the "patched" status.</li>
      <li><strong>Documented.</strong> The prompt and the model's response are
          recorded verbatim.</li>
      <li><strong>Verifiable as wrong OR Misleading/Overconfident.</strong>
          Either there is a clear ground-truth fact against which the output is
          false, OR the output presents contested, subjective claims as settled
          fact.</li>
      <li><strong>Reviewed.</strong> A human staff member checks every
          submission before it appears publicly.</li>
    </ul>
    <p>We do not accept fabricated, dramatized, or made-up hallucinations.</p>

    <h2>How to submit</h2>
    <p>Go to <a href="/submit">/submit</a>. Paste the prompt, the model's
       response, the model name, a category, and ideally a shared chat link.
       You can submit for immediate review or save as a draft and propose later
       from <a href="/my/submissions">/my/submissions</a>. You may have at most
       5 submissions awaiting review at once (drafts are unlimited).</p>

    <h2>How review works</h2>
    <p>Each submission is read by a human staff reviewer. Accepted entries are
       assigned a permanent A-number identifier (e.g. <code>A000123</code>),
       borrowed from the OEIS numbering scheme. You can chat with the reviewer
       in a thread attached to your submission.</p>

    <h2>Categories</h2>
    ${categoryList}

    <h2>How to cite an entry</h2>
    <p><em>Encyclopedia of AI Hallucinations</em>, entry A000123 ("Entry
       Title"), submitted YYYY-MM-DD.
       https://eah.warrenwoolf.com/e/A000123</p>
    <p>Adjust to match your venue's style. The A-number and URL are the stable
       parts.</p>

    <h2>FAQ</h2>

    <p><strong>What if the hallucination got patched?</strong><br>
       It stays in the database permanently under "patched" status. Users can
       report a hallucination as patched using the report button on the entry
       page, and a staff member will update the status. Historical record is the
       point.</p>

    <p><strong>Can I submit anonymously?</strong><br>
       Yes. When submitting, check the "Make this submission anonymous to the
       public" box. Your username will not appear on the public entry — only
       staff can see who submitted it.</p>

    <p><strong>Can I submit something from Twitter/X or Reddit?</strong><br>
       Yes, as long as the prompt and output are documented verbatim and the
       hallucination is reproducible or has a shared chat link.</p>

    <p><strong>How are duplicates handled?</strong><br>
       First-submitted wins. If two entries have the same prompt and output, the
       earlier one gets published. The system also flags potential duplicates to
       reviewers automatically.</p>
  `;

    return pageResponse(req, {
        title: "Submission Guide · EAH",
        heading: "Submission Guide & FAQ",
        body,
        user: ctx.user,
    });
};
