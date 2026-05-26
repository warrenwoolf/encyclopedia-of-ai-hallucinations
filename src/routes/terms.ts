/**
 * GET /terms — terms of use and content policy.
 */
import { h } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { type RouteHandler } from "./types.ts";

export const terms: RouteHandler = (req, ctx) => {
    const body = h`
    <h2>Use of the site</h2>
    <p>EAH is a public reference database. You may browse entries freely.
       Submission requires an account.</p>

    <h2>Content policy</h2>
    <p>Submissions must document real, reproducible AI outputs verbatim. Do not
       submit fabricated, dramatized, or deliberately misleading content. Do not
       submit content that violates others' privacy. Entries that contain private
       personal information will be removed. Abuse of the submission system
       (spam, deliberate misinformation) will result in account suspension.</p>

    <h2>Accuracy</h2>
    <p>EAH makes no guarantee that every published entry is reproducible in
       current model versions. Entry status ("active" or "patched") reflects
       community and staff reports but may lag reality. Always verify
       independently for critical use.</p>

    <h2>Intellectual property</h2>
    <p>Submitted prompts and outputs are documented for research and educational
       purposes under principles of fair use. By submitting, you confirm you
       have the right to share the content and grant EAH a non-exclusive license
       to publish it.</p>

    <h2>Changes</h2>
    <p>We may update these terms. Continued use of the site constitutes
       acceptance.</p>
  `;

    return pageResponse(req, {
        title: "Terms of Use · EAH",
        heading: "Terms of Use",
        body,
        user: ctx.user,
    });
};
