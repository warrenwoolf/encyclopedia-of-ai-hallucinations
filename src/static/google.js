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
    var form = new FormData();
    form.append("credential", credential);
    form.append("_csrf", csrf);

    var res = await fetch("/oauth/google/verify", {
      method: "POST",
      body: form,
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
