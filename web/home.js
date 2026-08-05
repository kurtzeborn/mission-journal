// Who is signed in, on the public landing page.
//
// This page is served anonymously and is the first thing a nervous relative
// sees, so the signed-out state is what ships in the markup and works with no
// JavaScript at all. The swap happens afterwards, once /.auth/me answers.
//
// It now goes one step further and offers the archives that address belongs
// to, which it could not do until `/api/memberships` existed. It offers them
// rather than redirecting: someone signed in with the wrong account needs to
// be able to see that, and a page that bounces straight through gives them no
// opportunity to notice. The list is also the only thing that tells a person
// with no archives that they have none, which is the state most likely to
// send them looking for help.

(function () {
    'use strict';

    const PROVIDERS = {
        aad: { glyph: 'fa-microsoft', name: 'Microsoft' },
        google: { glyph: 'fa-google', name: 'Google' }
    };

    async function showAccount() {
        const signedOut = document.getElementById('signed-out');
        const signedIn = document.getElementById('signed-in');
        if (!signedOut || !signedIn) return;

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
        signedIn.hidden = false;

        await showSites();
    }

    async function showSites() {
        const block = document.getElementById('my-sites');
        const list = document.getElementById('my-sites-list');
        if (!block || !list) return;

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

        if (!Array.isArray(memberships)) return;

        if (memberships.length === 0) {
            // Said plainly, because the alternative is a signed-in person
            // staring at a page that looks like it should have their letters
            // on it and concluding they have lost them.
            document.getElementById('my-sites-title').textContent = 'No archives yet';
            const item = document.createElement('li');
            item.className = 'note';
            item.textContent =
                'This address has not been added to an archive. Whoever set one up has to add you by name.';
            list.appendChild(item);
            block.hidden = false;
            return;
        }

        document.getElementById('my-sites-title').textContent =
            memberships.length === 1 ? 'Your archive' : 'Your archives';

        for (const membership of memberships) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.href = `/${membership.slug}/`;
            // textContent throughout: the display name is typed by whoever
            // claimed the site, so it is somebody else's text on this page.
            link.textContent = membership.missionaryDisplayName || membership.slug;
            item.appendChild(link);
            list.appendChild(item);
        }

        block.hidden = false;
    }

    showAccount();
})();
