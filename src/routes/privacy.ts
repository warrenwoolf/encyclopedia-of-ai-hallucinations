/**
 * GET /privacy — privacy policy page.
 */
import { config } from "../config.ts";
import { h } from "../html.ts";
import { layout } from "../layout.ts";
import { htmlResponse, type RouteHandler } from "./types.ts";

export const privacy: RouteHandler = (_req, ctx) => {
  const privacyEmail = config.email.privacy;
  const body = h`
    <p>This policy describes what data the Encyclopedia of AI Hallucinations
       ("EAH", "we") collects when you use the site, how we use it, and what
       choices you have. EAH is a small personal project; there are no
       advertising networks, no analytics services, and no tracking pixels.</p>

    <h2>What we collect</h2>

    <p><strong>On submission</strong> — when you fill out the submit form, we
       store:</p>
    <ul>
      <li><em>Required:</em> the prompt text, the model output, and the AI model
          name.</li>
      <li><em>Required:</em> a category and at least one tag.</li>
      <li><em>Optional:</em> a short summary, additional notes, your name (shown
          publicly on the entry if provided), a link to a shared chat session
          (shown publicly if provided), and your email address.</li>
    </ul>
    <p>The email address, if given, is stored in plaintext and is used only to
       (a) send you a confirmation email immediately after submission, with a
       link to track or withdraw it; (b) notify you when staff accept or
       reject your submission, including any reviewer notes; and (c) email
       you tracking links for your submissions when you request them via
       <a href="/lookup">/lookup</a>. It is not used for any other purpose
       and is not shown publicly.</p>

    <p><strong>Automatically:</strong> we store a salted SHA-256 hash of your
       IP address (salted with a server-side secret). We do not store your raw
       IP address. The hash is used only by site admins for spam triage; it is
       not used to track individuals across sessions.</p>

    <h2>How we use it</h2>
    <ul>
      <li>Submission content (prompt, output, model, category, tags, summary,
          notes, public name, shared-chat URL) is reviewed by staff and, if
          accepted, published on the site.</li>
      <li>If you provided an email address, we send transactional email via
          Resend (see "Third parties" below): a confirmation when you
          submit, a decision email when staff review your submission, and a
          digest of your submissions' tracking links if you request one at
          <a href="/lookup">/lookup</a>. We do not send marketing email and
          we do not maintain a mailing list.</li>
      <li>The IP hash is available to admins for spam and abuse triage only.
          It is never exported or sold.</li>
    </ul>

    <h2>Cookies</h2>
    <p>EAH sets two cookies:</p>
    <ul>
      <li><strong>eah_session</strong> — set only when an admin logs in.
          HttpOnly, Secure, SameSite=Lax, 7-day expiry. Not set for regular
          visitors.</li>
      <li><strong>eah_csrf</strong> — set on pages that contain forms. It
          holds an HMAC-signed token used to prevent cross-site request
          forgery. It is not a tracker; it contains no personal information
          and is not read by third parties.</li>
    </ul>
    <p>No advertising cookies, fingerprinting, or persistent identifiers are
       set for non-admin visitors.</p>

    <h2>Third parties</h2>
    <ul>
      <li><strong>Cloudflare</strong> — this site is served through a
          Cloudflare tunnel, which acts as a TLS edge proxy. Cloudflare sees
          network-level data (IP addresses, request metadata) as part of
          providing that service. See
          <a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">Cloudflare's privacy policy</a>.</li>
      <li><strong>Resend</strong> — if you provide an email address, your
          address and the notification email content are processed by Resend
          as a transactional email service provider. See
          <a href="https://resend.com/legal/privacy-policy" rel="noopener">Resend's privacy policy</a>.</li>
    </ul>
    <p>There are no other third-party services. The Content Security Policy
       forbids third-party scripts and resources.</p>

    <h2>Data retention</h2>
    <p>Submissions are kept indefinitely unless you withdraw them (see "Your
       choices" below) or request deletion. We do not automatically purge old
       records.</p>

    <h2>Your choices</h2>
    <p><strong>Pending submissions</strong> can be withdrawn at any time using
       the tracking code you received on submission, via the
       <a href="/track">track</a> page, or via the tracking link in any of
       the emails we sent you (if you provided an email address).</p>
    <p><strong>Published or rejected submissions,</strong> or requests to
       delete a stored email address, must be handled manually. Email the
       maintainer at the address in the "Contact" section below with the entry
       ID or a description of your submission.</p>

    <h2>Contact</h2>
    <p>Privacy-related requests: <a href="mailto:${privacyEmail}">${privacyEmail}</a>.</p>

    <h2>Changes to this policy</h2>
    <p>If we make material changes to data practices, we will update this page.
       The date below reflects the last revision.</p>

    <p class="muted">Last updated: 2026-05-20.</p>
  `;
  return htmlResponse(layout({
    title: "Privacy · EAH",
    heading: "Privacy",
    body,
    admin: ctx.admin,
  }));
};
