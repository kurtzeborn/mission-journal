// Carries the page the visitor was actually trying to reach through the
// sign-in detour.
//
// Static Web Apps serves this page *in place of* whatever protected page was
// asked for, leaving the address bar alone, so the wanted path is simply
// `location.pathname` and nothing has to be threaded through a query string.
//
// That is deliberate rather than incidental. The platform's `.referrer` token
// is substituted on its own auth endpoints but not on a redirect to an
// ordinary page -- measured against the live site, it arrives as the literal
// string `.referrer` -- so a redirect-based chooser would have quietly dropped
// every deep link and dumped people on the home page instead of the letter
// they followed a link to.
//
// The query string is still honoured, because app.js sends people here that
// way when a session expires mid-visit and the address bar is already correct.
(function () {
    'use strict';

    const PROVIDERS = {
        'signin-aad': '/.auth/login/aad',
        'signin-google': '/.auth/login/google'
    };

    // Arriving at the chooser itself, or at the home page, means there is
    // nowhere in particular to go back to -- and returning to this page after
    // signing in would be a loop.
    const NOWHERE = new Set(['/', '/login.html']);

    /**
     * A return address is only usable if it points back into this site.
     *
     * Whatever arrives in the query string is attacker-controlled -- anyone can
     * send a relative of yours a link to this page carrying any value they like
     * -- and it is handed to the platform as a post-login redirect. Left
     * unchecked that is an open redirect wearing our domain and our sign-in
     * page, which is about the most persuasive phishing page anyone could ask
     * for. So: a path, rooted, and not a protocol-relative URL.
     */
    function safeReturn(value) {
        if (!value || value === '.referrer') return null;
        if (!value.startsWith('/')) return null;

        // `//evil.test` and `/\evil.test` are both read as a different origin
        // by browsers, despite starting with a slash.
        if (value.startsWith('//') || value.startsWith('/\\')) return null;
        if (NOWHERE.has(value)) return null;

        return value;
    }

    const asked = new URLSearchParams(window.location.search).get('post_login_redirect_uri');
    const target = safeReturn(asked) ?? safeReturn(window.location.pathname);

    for (const [id, path] of Object.entries(PROVIDERS)) {
        const link = document.getElementById(id);
        if (!link) continue;

        link.href = target
            ? `${path}?post_login_redirect_uri=${encodeURIComponent(target)}`
            : path;
    }
})();
