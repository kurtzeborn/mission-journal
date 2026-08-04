// Who is signed in, on the public landing page.
//
// This page is served anonymously and is the first thing a nervous relative
// sees, so the signed-out state is what ships in the markup and works with no
// JavaScript at all. The swap happens afterwards, once /.auth/me answers.
//
// It stops at saying who they are. The obvious next step -- "go to your
// letters" -- needs an address-to-site lookup that does not exist yet, so
// offering it here would be a button that cannot be honoured. Until the site
// switcher arrives, this page's job is narrower: stop telling someone who is
// already signed in to sign in.

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
    }

    showAccount();
})();
