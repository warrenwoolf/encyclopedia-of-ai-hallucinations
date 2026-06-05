/**
 * GET /about — who we are, founders, vision, FAQ, and contact. The former
 * /faq and /contact pages were folded in here to keep the site to fewer pages.
 */
import { h } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { type RouteHandler } from "./types.ts";

const CONTACT_EMAIL = "contact@enaih.org";
const DISCORD_INVITE = "https://discord.gg/F7g2fqCKyN";

export const about: RouteHandler = (req, ctx) => {
    const mailto = h`<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;
    const discord = h`<a href="${DISCORD_INVITE}" rel="noopener">our Discord server</a>`;
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
      <li>A place anyone can visit to understand AI failure modes.</li>
    </ul>

    <h2>Who we are</h2>
    <dl>
      <dt><strong>Rudra Jadhav</strong> — Founder</dt>
      <dd>Leads product vision and research direction. OTIS alumnus, Non-Trivial
          research program graduate.
          <a href="https://linkedin.com/in/rudra-jadhav-math">LinkedIn</a></dd>
      <dt><strong>Warren Woolf</strong> — Founder</dt>
      <dd>Leads technical development and infrastructure. Incoming student
          at Stanford University.
          <a href="https://www.linkedin.com/in/warren-woolf-049828367/">LinkedIn</a></dd>
    </dl>

    <h2 id="faq">Frequently asked questions</h2>
    <p>Answers to the questions we hear most often. Still stuck? See the
       <a href="/guide">submission guide</a> or <a href="#contact">get in touch</a>.</p>
    <dl class="faq-list">
      <dt>What counts as an AI hallucination — and what should I submit?</dt>
      <dd>We use "hallucination" broadly — it covers more than just made-up
          facts. Anything where a real, named AI system fails in a documentable
          way is fair game: fabricated citations, confidently wrong facts or math,
          invented code and APIs, temporal confusion, ignored instructions, and
          misleading or overconfident answers, as well as adjacent failure modes
          like spiraling, looping, or thrashing (the model degenerating into
          repetition or runaway tangents). Browse the
          <a href="/browse">categories</a> to see the full range. Whatever the
          type, the best submissions are <strong>reproducible</strong>: include the
          exact prompt (or full conversation), the model's response, and which AI
          model and version produced it, so others can verify and cite it. You can
          capture a single prompt-and-response pair or a multi-turn conversation.
          See the <a href="/guide">submission guide</a> for the structured fields
          reviewers look for.</dd>

      <dt>Do I need an account to submit, and can my entry be anonymous?</dt>
      <dd>Yes, submitting requires an account — it lets you track your submissions,
          respond to reviewer messages, and edit your entries. You can sign up with
          an email address (we send a 6-digit verification code) or with Google. If
          you'd rather not have your name attached publicly, you can mark a
          submission as anonymous when you submit it; your account stays private and
          the public entry won't show who filed it.</dd>

      <dt>How are submissions reviewed, and how long does it take?</dt>
      <dd>When you submit, your entry goes public right away as <em>pending
          review</em> — reachable by anyone but hidden behind an opt-in toggle
          until staff vet it. Every submission gets its permanent
          A-number (like <code>A000042</code>) at this point, so you can cite it
          immediately. From there it climbs a trust ladder. Staff first
          <em>confirm</em> it's a genuine submission, after which
           it becomes <em>pending acceptance</em> — still hidden from the
          default listings. Next they try to reproduce it themselves: if they
          succeed it becomes <em>active</em> — the top tier — and appears in the
          normal listings; if they can't, it's rejected and kept as a reported
          sighting. (Link submissions stop at <em>pending acceptance</em>, since
          staff can't re-run someone else's session.) You can message reviewers
          from your dashboard at any stage, and you'll be notified when the status
          changes. We're a small team, so timing varies — there's no fixed
          turnaround. Submissions that aren't genuine are rejected with a reason,
          and you can revise and resubmit.</dd>
    </dl>

    <h2 id="contact">Contact</h2>
    <p>Reach the maintainers at ${mailto}. One inbox covers everything below —
       just say which it is in the subject line so we can route it quickly.</p>
    <p>Prefer to chat? Join ${discord} to talk with the maintainers and community.</p>
    <dl>
      <dt><strong>Bug reports</strong></dt>
      <dd>Something on the site is broken, looks wrong, or behaves oddly. Tell us
          what you did, what you expected, and what happened (a screenshot and the
          page URL help a lot).</dd>

      <dt><strong>Patches &amp; corrections</strong></dt>
      <dd>An entry is out of date — the model no longer reproduces the
          hallucination, or a detail is wrong. Include the entry's A-number (or
          its URL, if it doesn't have one yet) and what should change.</dd>

      <dt><strong>Problems with a submission</strong></dt>
      <dd>An entry looks fabricated, miscategorized, duplicated, or otherwise
          shouldn't be live. Send the A-number or entry URL and what's wrong.</dd>

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

    <h2>Terms and privacy</h2>
    <p>See our <a href="/terms">terms of service</a> and <a href="/privacy">privacy policy</a>.</p>

    <h2>Source code</h2>
    <p>The site is open source:
       <a href="https://github.com/warrenwoolf/encyclopedia-of-ai-hallucinations">github.com/warrenwoolf/encyclopedia-of-ai-hallucinations</a>.</p>
    <p class="muted">Site built primarily by Claude Opus 4.7/4.8.</p>
  `;
    return pageResponse(req, {
        title: "About · ENAIH",
        heading: "About",
        bodyClass: "text-page",
        body,
        user: ctx.user,
    });
};
