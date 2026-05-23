/* Google Identity Services helper.
 * Keeps the GIS callback out of inline script so CSP can stay strict.
 */
(function () {
  function readCsrf() {
    var el = document.getElementById("g_id_onload");
    return el ? el.getAttribute("data-csrf") || "" : "";
  }

  async function postCredential(credential) {
    var csrf = readCsrf();
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

  window.handleGisCredential = function (resp) {
    var credential = resp && resp.credential;
    if (!credential) {
      window.location.href = "/login";
      return;
    }
    postCredential(credential).catch(function () {
      window.location.href = "/login";
    });
  };
})();
