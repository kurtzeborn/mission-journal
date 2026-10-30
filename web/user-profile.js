// Copy the provider's name claims into the application's presentation profile.
//
// `/.auth/me` exposes claims to the browser, while the principal header sent
// to Functions deliberately omits them. The protected endpoint supplies the
// address and provider from that header; this script supplies only name data.

(function () {
    'use strict';

    const SYNCED = 'user-profile-synced';
    let principalRequest = null;

    const claim = (principal, ...types) =>
        (principal?.claims ?? []).find((candidate) => types.includes(candidate.typ))?.val ?? '';

    function profileOf(principal) {
        return {
            displayName: claim(
                principal,
                'name',
                'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
            ),
            givenName: claim(
                principal,
                'given_name',
                'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'
            ),
            familyName: claim(
                principal,
                'family_name',
                'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'
            )
        };
    }

    async function sync(principal) {
        const profile = profileOf(principal);
        if (!principal?.userDetails || !profile.displayName) return profile;

        const marker = JSON.stringify({
            provider: principal.identityProvider ?? '',
            userId: principal.userId ?? '',
            ...profile
        });
        try {
            if (sessionStorage.getItem(SYNCED) === marker) return profile;
        } catch {
            // Storage is an optimization. A browser that refuses it can still
            // keep the server profile current.
        }

        try {
            const response = await fetch('/api/profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(profile)
            });
            if (response.ok) {
                try {
                    sessionStorage.setItem(SYNCED, marker);
                } catch {
                    // The profile was saved; remembering that locally is not
                    // important enough to turn success into an error.
                }
            }
        } catch {
            // Presentation data must never keep somebody from their letters.
        }

        return profile;
    }

    async function readPrincipal() {
        principalRequest ??= (async () => {
            try {
                const response = await fetch('/.auth/me', { cache: 'no-store' });
                if (!response.ok) return null;
                const principal = (await response.json()).clientPrincipal ?? null;
                if (principal) void sync(principal);
                return principal;
            } catch {
                return null;
            }
        })();
        return principalRequest;
    }

    window.UserProfile = { profileOf, readPrincipal, sync };
    readPrincipal();
})();
