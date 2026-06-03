/**
 * GET /privacy — privacy policy page.
 */
import { config } from "../config.ts";
import { h } from "../html.ts";
import { pageResponse } from "../layout.ts";
import { type RouteHandler } from "./types.ts";

export const privacy: RouteHandler = (req, ctx) => {
  const privacyEmail = config.email.privacy;
  const body = h`
    <p>This policy describes what data the Encyclopedia of AI Hallucinations
       ("ENAIH", "we") collects when you use the site, how we use it, and what
       choices you have. There are no advertising networks, no analytics
       services, and no tracking pixels.</p>

    <h2>What we collect</h2>

    <p><strong>When you create an account</strong> — submission requires an
       account. We store a username and an email address (from the signup form or
       from Google sign-in). Passwords are stored only as an argon2id hash, never
       in plaintext; if you sign in with Google we store your Google account
       identifier instead of a password. Your email address is stored in plaintext
       so we can send the messages described under "How we use it" below; it is
       visible only to the site owner, never shown publicly, and never to other
       users.</p>

    <p><strong>On submission</strong> — when you fill out the submit form, we
       store:</p>
    <ul>
      <li><em>Required:</em> the prompt text, the model output, and the AI model
          name (or, for a link submission, the source URL and a summary).</li>
      <li><em>Optional:</em> a category, tags, a short summary, additional notes,
          and a link to a shared chat session (shown publicly on the entry if
          provided).</li>
      <li>Whether the entry should be attributed to your username publicly or
          posted anonymously.</li>
    </ul>
    <p>By default your username is shown as the author of an entry you submit. If
       you mark a submission anonymous, your username is hidden from the public
       entry and only the site owner can see that you filed it.</p>

    <p><strong>Automatically:</strong> we store a salted SHA-256 hash of your
       IP address (salted with a server-side secret). We do not store your raw
       IP address. The hash is used only by site admins for spam triage; it is
       not used to track individuals across sessions.</p>

    <h2>How we use it</h2>
    <ul>
      <li>Submission content (prompt, output, model, category, tags, summary,
          notes, shared-chat URL) is published on the site. Publishing an entry
          makes it public immediately as <em>unreviewed</em>; staff then vet
          it and it moves up the trust ladder (see the
          <a href="/guide">submission guide</a>). Drafts stay private to you.</li>
      <li>We send transactional email to your account address via Resend (see
          "Third parties" below): a verification code when you sign up, messages
          from reviewers about your submissions, and a notification when a
          submission's status changes. We do not send marketing email and we do
          not maintain a mailing list.</li>
      <li>The IP hash is available to site staff for spam and abuse triage only.
          It is never exported or sold.</li>
    </ul>

    <h2>Legal bases (EU/UK users)</h2>
    <p>If you are in the European Economic Area or the United Kingdom, we process
       your personal data under the following bases:</p>
    <ul>
      <li><strong>Performance of a contract</strong> (GDPR Art. 6(1)(b)) — your
          email address, username, and password hash, used to create and operate
          your account and to send the transactional messages described above. We
          cannot run an account without these.</li>
      <li><strong>Legitimate interests</strong> (GDPR Art. 6(1)(f)) — the salted
          IP-address hash, used solely to prevent spam and abuse. We consider this
          minimal and unlikely to override your rights, as we never store raw IPs
          and never use the hash to profile or track you.</li>
      <li><strong>Consent</strong> (GDPR Art. 6(1)(a)) — when you choose to publish
          a submission, you are asking us to make that content public. You can
          withdraw drafts and unreviewed submissions yourself, or request removal
          of published entries (see "Your choices").</li>
    </ul>

    <h2>Cookies</h2>
    <p>ENAIH sets two cookies:</p>
    <ul>
      <li><strong>eah_session</strong> — set when you log in (with any account,
          not just staff). HttpOnly, Secure, SameSite=Lax, 7-day expiry. Holds a
          random session token; not set for logged-out visitors.</li>
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
      <li><strong>Resend</strong> — your account email address and the
          transactional email content (verification codes, reviewer messages,
          status notifications) are processed by Resend as our transactional
          email service provider. See
          <a href="https://resend.com/legal/privacy-policy" rel="noopener">Resend's privacy policy</a>.</li>
    </ul>
    <p>There are no other third-party services. The Content Security Policy
       forbids third-party scripts and resources.</p>
    <p><strong>International transfers.</strong> Cloudflare and Resend are
       US-based providers, so if you are in the EEA or UK your data is transferred
       to and processed in the United States. These providers offer transfer
       safeguards (Standard Contractual Clauses and, where applicable, the EU–US
       Data Privacy Framework) as described in their privacy policies linked
       above.</p>

    <h2>Data retention</h2>
    <p>Submissions are kept indefinitely unless you withdraw them (see "Your
       choices" below) or request deletion. We do not automatically purge old
       records. Encrypted database backups are retained on a short rotation and
       age out automatically; when you request deletion we remove your data from
       the live database immediately, and any copy still present in a backup is
       not restored to live use and expires with that backup's rotation.</p>

    <h2>Your choices</h2>
    <p><strong>Drafts</strong> are private and can be edited or deleted at any
       time from your <a href="/my/submissions">submissions page</a>.
       <strong>Pending-review submissions</strong> can be withdrawn back to a
       draft from the same page.</p>
    <p><strong>Entries that have advanced past pending review</strong> (pending
       acceptance or active), or requests to delete
       your account and the email address attached to it, must be handled
       manually. Email the maintainer at the address in the "Contact" section
       below with the entry's A-number or URL, or a description of your
       submission.</p>

    <p><strong>Your rights.</strong> If you are in the EEA or UK, you have the
       right to access, correct, export, or delete your personal data, to object
       to or restrict processing, and to withdraw consent for anything based on
       it. To exercise any of these, email the address in "Contact" below. You
       also have the right to lodge a complaint with your local data-protection
       supervisory authority. California residents may likewise request access to,
       or deletion of, the personal information we hold about them.</p>

    <h2>Contact</h2>
    <p>Privacy-related requests: <a href="mailto:${privacyEmail}">${privacyEmail}</a>.</p>

    <h2>Changes to this policy</h2>
    <p>If we make material changes to data practices, we will update this page.
       The date below reflects the last revision.</p>

    <p class="muted">Last updated: 2026-06-02.</p>
  `;
  return pageResponse(req, {
    title: "Privacy · ENAIH",
    heading: "Privacy",
    bodyClass: "text-page",
    body,
    user: ctx.user,
  });
};
