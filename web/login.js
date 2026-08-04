// Carries the page the visitor was actually trying to reach through the
// sign-in detour.
//
// Static Web Apps answers an unauthenticated request with a redirect here, and
// substitutes the magic value `.referrer` for the URL that was asked for. That
// substitution is documented on the auth endpoints; whether it also happens on
// a redirect to an ordinary page like this one is not, so this is written to
// work either way -- if the platform hands back the literal string, the return
// address is simply dropped and the visitor lands on the home page rather than
// on a broken link.
(function () {
    'use strict';

    const PROVIDERS = {
        'signin-aad': '/.auth/login/aad',
        'signin-google': '/.auth/login/google'
    };

    /**
     * A return address is only usable if it points back into this site.
     *
     * Whatever ends up in the query string is attacker-controlled -- anyone can
     * send a relative of yours a link to this page with any value they like --
     * and it is handed to the platform as a post-login redirect. Left
     * unchecked that is an open redirect wearing our domain and our sign-in
     * page, which is the most persuasive phishing page an attacker could ask
     * for. So: a path, rooted, and not a protocol-relative URL.
     */
    function safeReturn(value) {
        if (!value || value === '.referrer') return null;

        // `//evil.test` and `/\evil.test` are both read as another origin by
        // browsers, despite starting with a slash.
        if (!value.startsWith('/')) return null;
        if (value.startsWith('//') || value.startsWith('/\\')) return null;

        return value;
    }

    const asked = new URLSearchParams(window.location.search).get('post_login_redirect_uri');
    const target = safeReturn(asked);

    for (const [id, path] of Object.entries(PROVIDERS)) {
        const link = document.getElementById(id);
        if (!link) continue;

        link.href = target
            ? `${path}?post_login_redirect_uri=${encodeURIComponent(target)}`
            : path;
    }
})();
