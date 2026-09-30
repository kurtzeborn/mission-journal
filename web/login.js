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
//
// It also gets most people past this page without reading it. The platform's
// session is short, its length is neither published nor ours to set, and
// owning it would mean validating tokens inside every Function -- the one
// simplification the whole private-content design rests on. But Google's and
// Microsoft's own sessions are long and both have already been consented to,
// so the trip back out to whichever one was used last returns without asking
// anything at all. The only thing ever missing was which one that was, and
// this page is where that gets learned.
(function () {
    'use strict';

    const PROVIDERS = {
        aad: { button: 'signin-aad', route: '/.auth/login/aad' },
        google: { button: 'signin-google', route: '/.auth/login/google' }
    };

    // The name of a door, not a credential and not a session. Nothing here is
    // worth anything to anybody who already has the browser it is stored in.
    const CHOSE = 'mj.provider';

    // One silent attempt per destination. Without it, a trip out that comes
    // back still unauthenticated meets the same 401 and goes out again, which
    // is a loop rather than a sign-in.
    const TRIED = 'mj.returning';

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

    // Both directions guarded: some browsers are configured to refuse storage
    // and throw on the attempt, and being shown this page is not a failure.
    function remember(name) {
        try {
            localStorage.setItem(CHOSE, name);
        } catch {
            // They choose again next time, which is this page doing its job.
        }
    }

    function forget() {
        try {
            localStorage.removeItem(CHOSE);
        } catch {
            // Then nothing was ever stored to remove.
        }
    }

    function recall() {
        try {
            return PROVIDERS[localStorage.getItem(CHOSE)] ?? null;
        } catch {
            return null;
        }
    }

    /** True the second time a destination is tried, and wherever storage is refused. */
    function tried(where) {
        try {
            if (sessionStorage.getItem(TRIED) === where) return true;
            sessionStorage.setItem(TRIED, where);
            return false;
        } catch {
            return true;
        }
    }

    const params = new URLSearchParams(window.location.search);
    const asked = params.get('post_login_redirect_uri');
    const target = safeReturn(asked) ?? safeReturn(window.location.pathname) ?? HOME;

    for (const [name, { button, route }] of Object.entries(PROVIDERS)) {
        const link = document.getElementById(button);
        if (!link) continue;

        link.href = `${route}?post_login_redirect_uri=${encodeURIComponent(target)}`;
        link.addEventListener('click', () => remember(name));
    }

    // Signing out has to mean it. Remembered, the next archive they opened
    // would send them silently back to the account they just left, which is
    // the exact opposite of what "try another account" offers.
    if (params.has('signedout')) {
        forget();
        return;
    }

    const provider = recall();
    if (provider && !tried(target)) {
        // replace(), so Back from the letter does not land on a page whose
        // only behavior is to throw them forward again.
        window.location.replace(`${provider.route}?post_login_redirect_uri=${encodeURIComponent(target)}`);
    }
})();
