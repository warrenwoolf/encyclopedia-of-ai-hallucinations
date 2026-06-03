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
          remain in ENAIH permanently under the "patched" status.</li>
      <li><strong>Documented.</strong> The prompt and the model's response are
          recorded verbatim.</li>
      <li><strong>Verifiable as wrong OR Misleading/Overconfident.</strong>
          Either there is a clear ground-truth fact against which the output is
          false, OR the output presents contested, subjective claims as settled
          fact.</li>
    </ul>
    <p>We do not accept fabricated, dramatized, or made-up hallucinations.</p>

    <h2>How to submit</h2>
    <p>Go to <a href="/submit">/submit</a>. Paste the prompt, the model's
       response, the model name, optionally a category and tags, and ideally a
       shared chat link. You can <strong>submit it for review</strong> — which
       puts the entry live immediately (see the trust ladder below) — or
       <strong>save it as a draft</strong> and submit it later from
       <a href="/my/submissions">/my/submissions</a>. You may have at most 5
       submissions still pending review at once (drafts are unlimited).</p>

    <h2>The trust ladder</h2>
    <p>Entries climb a trust ladder as staff vet them. Each rung is shown as a
       badge on the entry. Every submission gets its permanent A-number (e.g.
       <code>A000123</code>, borrowed from the OEIS numbering scheme) the moment
       you submit it for review — but only <strong>active</strong> entries
       appear in the default listings:</p>
    <ul>
      <li><strong>Pending review.</strong> Public immediately, but reachable
          only by its link or A-number — hidden from the default listings until
          staff confirm it.</li>
      <li><strong>Pending acceptance.</strong> A human staff member has confirmed
          it's a genuine, reproducible hallucination and assigned a category.
          Still hidden from the default listings while staff work to reproduce
          and accept it.</li>
      <li><strong>Active.</strong> Staff reproduced the behavior themselves and
          accepted it into the canon. This is the top tier, and the only one
          shown in the normal listings.</li>
      <li><strong>Rejected.</strong> Staff reviewed it but rejected it (including
          entries they couldn't reproduce); it stays addressable as a reported
          sighting.</li>
    </ul>
    <p>Link submissions — a link to a third-party post (Reddit, X, etc.) instead
       of a pasted transcript — cap at <strong>pending acceptance</strong>:
       staff can't re-run someone else's shared session, so they're never
       reproduced and never become active. You can chat with the reviewer in a
       thread attached to your submission at any stage.</p>

    <h2>Categories</h2>
    ${categoryList}

    <h2>How to cite an entry</h2>
    <p><em>Encyclopedia of AI Hallucinations</em>, entry A000123 ("Entry
       Title"), submitted YYYY-MM-DD.
       https://enaih.org/e/A000123</p>
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
       earlier one is kept. The system also flags potential duplicates to
       reviewers automatically.</p>
  `;

    return pageResponse(req, {
        title: "Submission Guide · ENAIH",
        heading: "Submission Guide & FAQ",
        bodyClass: "text-page",
        body,
        user: ctx.user,
    });
};
