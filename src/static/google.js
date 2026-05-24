/* Google Identity Services helper.
 * Keeps the GIS callback out of inline script so CSP can stay strict.
 */
(function () {
  function getMount() {
    return document.querySelector(".oauth-google-button");
  }

  function readOptions(mount) {
    return {
      clientId: mount.getAttribute("data-client-id") || "",
      csrf: mount.getAttribute("data-csrf") || "",
    };
  }

  async function postCredential(credential, csrf) {
    // Send as application/x-www-form-urlencoded (URLSearchParams) — NOT
    // FormData. The server's parseForm() parses the body with URLSearchParams,
    // which only understands urlencoded bodies; a multipart FormData body would
    // leave _csrf/credential unparsed, the CSRF check would fail, and the POST
    // would 403 (silently, since that branch doesn't log) back to /login.
    var body = new URLSearchParams();
    body.append("credential", credential);
    body.append("_csrf", csrf);

    var res = await fetch("/oauth/google/verify", {
      method: "POST",
      body: body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      credentials: "same-origin",
    });

    if (res.ok || res.redirected) {
      window.location.href = "/";
      return;
    }

    window.location.href = "/login";
  }

  function render() {
    var mount = getMount();
    if (!mount || !window.google || !google.accounts || !google.accounts.id) return;

    var options = readOptions(mount);
    if (!options.clientId) return;

    google.accounts.id.initialize({
      client_id: options.clientId,
      callback: function (resp) {
        var credential = resp && resp.credential;
        if (!credential) {
          window.location.href = "/login";
          return;
        }
        postCredential(credential, options.csrf).catch(function () {
          window.location.href = "/login";
        });
      },
    });

    google.accounts.id.renderButton(mount, {
      theme: "outline",
      size: "large",
      type: "standard",
      text: "signin_with",
      shape: "rectangular",
      logo_alignment: "left",
      width: 260,
    });
  }

  function start() {
    if (document.readyState === "complete") {
      render();
      return;
    }
    window.addEventListener("load", render, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
