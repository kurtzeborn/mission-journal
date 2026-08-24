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
// The query string is still honored, because app.js sends people here that
// way when a session expires mid-visit and the address bar is already correct.
(function () {
    'use strict';

    const PROVIDERS = {
        'signin-aad': '/.auth/login/aad',
        'signin-google': '/.auth/login/google'
    };

    // Arriving at the chooser itself means there is nowhere in particular to go
    // back to. It must not be used as a return address: signing in would land
    // straight back on the chooser, which looks exactly like a failed sign-in
    // even though it worked.
    const NOWHERE = new Set(['/login.html']);

    // Where to go when nothing better is known. The provider link is never left
    // bare, because with no return address the platform sends people back to
    // wherever they came from -- and where they came from is this page.
    const HOME = '/';

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

        // The platform's own auth endpoints answer 401 when their short-lived
        // context cookie is missing, and a 401 is exactly what puts this page
        // on screen. Returning to one would 401 again and redraw this page
        // again -- a loop that looks precisely like a sign-in that silently
        // refuses to work.
        if (value.startsWith('/.auth/')) return null;

        if (NOWHERE.has(value)) return null;

        return value;
    }

    const asked = new URLSearchParams(window.location.search).get('post_login_redirect_uri');
    const target = safeReturn(asked) ?? safeReturn(window.location.pathname) ?? HOME;

    for (const [id, path] of Object.entries(PROVIDERS)) {
        const link = document.getElementById(id);
        if (!link) continue;

        link.href = `${path}?post_login_redirect_uri=${encodeURIComponent(target)}`;
    }
})();
