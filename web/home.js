// Who is signed in, on the public landing page.
//
// This page is served anonymously and is the first thing a nervous relative
// sees, so the signed-out state is what ships in the markup and works with no
// JavaScript at all. The swap happens afterwards, once /.auth/me answers.
//
// It also offers the archives that address belongs to, which it could not do
// until `/api/memberships` existed. It offers them rather than redirecting:
// someone signed in with the wrong account needs to be able to see that, and a
// page that bounces straight through gives them no opportunity to notice.
//
// All of it lives in the masthead, the same as every other page. It used to sit
// in the body under a heading, which made the one page a signed-in person is
// most likely to arrive at the one page where their account and their letters
// were somewhere different from everywhere else.

(function () {
    'use strict';

    const PROVIDERS = {
        aad: { glyph: 'fa-microsoft', name: 'Microsoft' },
        google: { glyph: 'fa-google', name: 'Google' }
    };

    async function showAccount() {
        const signedOut = document.getElementById('signed-out');
        const account = document.getElementById('account');
        const signOut = document.getElementById('sign-out');
        if (!signedOut || !account || !signOut) return;

        let principal;
        try {
            const response = await fetch('/.auth/me', { cache: 'no-store' });
            if (!response.ok) return;
            principal = (await response.json()).clientPrincipal;
        } catch {
            // Leave the signed-out state alone. A visitor who cannot reach
            // /.auth/me is no worse off being offered the sign-in button.
            return;
        }

        if (!principal) return;

        // An unrecognised provider still gets the address, just without a mark.
        const provider = PROVIDERS[principal.identityProvider];
        if (provider) {
            document.getElementById('account-icon').classList.add('fa-brands', provider.glyph);
            document.getElementById('account-provider').textContent = `Signed in with ${provider.name}: `;
        }

        document.getElementById('account-email').textContent = principal.userDetails;

        signedOut.hidden = true;
        account.hidden = false;
        signOut.hidden = false;

        await showSwitcher();
    }

    // The archives this account can read, as the same masthead dropdown every
    // other page uses.
    //
    // Nothing is drawn when there are none. That is a change from the heading
    // this replaced, which said so in a sentence -- but a sentence explaining
    // an absence needs somewhere to be said and the masthead is not it. The
    // people it was written for are the ones who have been invited and not yet
    // added, and the invitation email already tells them what happens next.
    //
    // Silent on failure, like the account line: this is a way to letters that
    // are reachable anyway, not a thing whose absence needs explaining.
    async function showSwitcher() {
        const box = document.getElementById('switcher');
        const label = document.getElementById('switcher-label');
        const list = document.getElementById('switcher-list');
        if (!box || !label || !list) return;

        let memberships;
        try {
            const response = await fetch('/api/memberships', { cache: 'no-store' });
            if (!response.ok) return;
            memberships = (await response.json()).memberships;
        } catch {
            // The account line still rendered, which is the more important
            // half. Failing quietly leaves the page exactly as it was.
            return;
        }

        if (!Array.isArray(memberships) || memberships.length === 0) return;

        // textContent throughout: the display name is typed by whoever claimed
        // the site, so it is somebody else's text on this page.
        const name = (membership) => membership.missionaryDisplayName || membership.slug;

        // Named when there is one, counted when there are several. The archive
        // pages hide the switcher for a single membership, because there it can
        // only say "you are already here"; this page is not an archive, so the
        // one name is the whole reason most people signed in.
        label.textContent = memberships.length === 1 ? name(memberships[0]) : 'Archives';

        for (const membership of memberships) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.href = `/${encodeURIComponent(membership.slug)}/`;
            link.textContent = name(membership);
            item.appendChild(link);
            list.appendChild(item);
        }

        box.hidden = false;
    }

    showAccount();
})();
