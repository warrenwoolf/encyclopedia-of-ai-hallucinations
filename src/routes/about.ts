/**
 * GET /about — who we are, founders, vision, contact.
 */
import { h, raw } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { type RouteHandler } from "./types.ts";

export const about: RouteHandler = (req, ctx) => {
    const body = h`
    <h2>What is ENAIH?</h2>
    <p>The <strong>Encyclopedia of AI Hallucinations</strong> is a
       community-maintained database of real, reproducible AI hallucinations —
       confident-but-wrong (or misleading) outputs produced by real, named AI
       systems. ENAIH aims to be the OEIS of AI failures: a permanent, citable,
       structured record. Just as the
       <a href="https://oeis.org/">On-Line Encyclopedia of Integer Sequences</a>
       became the go-to reference for integer sequences, ENAIH aims to be the
       go-to reference for documented AI hallucinations. Useful for researchers,
       journalists, AI developers, and anyone who wants calibrated intuition
       about when to trust AI.</p>

    <h2>Our vision</h2>
    <p>ENAIH started because hallucinations were scattered across social media,
       screenshots, and papers with no central place to find, cite, or browse
       them. The long-term vision:</p>
    <ul>
      <li>A citable database researchers can reference in papers.</li>
      <li>A resource journalists can link to for concrete examples.</li>
      <li>A dataset AI companies can use to improve training.</li>
      <li>A place anyone can visit to understand AI failure modes.</li>
    </ul>

    <h2>Who we are</h2>
    <dl>
      <dt><strong>Rudra Jadhav</strong> — Founder</dt>
      <dd>Leads product vision and research direction. OTIS alumnus, Non-Trivial
          research program graduate.
          <a href="https://linkedin.com/in/rudra-jadhav-math">LinkedIn</a></dd>
      <dt><strong>Warren Woolf</strong> — Founder</dt>
      <dd>Leads technical development and infrastructure. Incoming CS student
          at Stanford University.
          <a href="https://www.linkedin.com/in/warren-woolf-049828367/">LinkedIn</a></dd>
    </dl>

    <h2>Source code</h2>
    <p>The site is open source:
       <a href="https://github.com/warrenwoolf/encyclopedia-of-ai-hallucinations">github.com/warrenwoolf/encyclopedia-of-ai-hallucinations</a>.</p>
    <p class="muted">Initial scaffolding written by Claude (Anthropic), May 2026.</p>
  `;
    return pageResponse(req, {
        title: "About · ENAIH",
        heading: "About",
        bodyClass: "text-page",
        body,
        user: ctx.user,
    });
};
