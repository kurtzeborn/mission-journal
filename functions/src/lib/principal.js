// Decoding the caller's identity from the Static Web Apps session.
//
// The API performs no token validation of its own, and that is deliberate:
// Static Web Apps terminates authentication at the edge and hands the decoded
// principal to the backend as a header. Re-validating a token here would mean
// abandoning SWA auth entirely (see the plan's "Sessions expire" section).
//
// The header is therefore trusted -- but only because nothing except Static
// Web Apps can reach this app. Linking the Function App to the static web app
// installs an Easy Auth identity provider that gives SWA exclusive access, so
// a direct call to the Function App's own hostname is rejected before any
// handler runs. If that link is ever removed, this header becomes attacker-
// controlled and every endpoint below becomes public.

/**
 * @param {string|null} header the raw x-ms-client-principal value
 * @returns {{email: string, provider: string|null, userId: string|null}|null}
 */
export function readPrincipal(header) {
    if (!header) return null;

    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    } catch {
        return null;
    }

    // `userDetails` is the email address for both providers this service
    // uses. Lowercased here, once, because the ACL is matched case-insensitively
    // and doing it at each call site is how one of them gets forgotten.
    const email = typeof parsed?.userDetails === 'string' ? parsed.userDetails.toLowerCase() : null;
    if (!email) return null;

    return {
        email,
        provider: parsed.identityProvider ?? null,
        userId: parsed.userId ?? null
    };
}

/**
 * The stable handle for one sign-in, or null when the provider gave us none.
 *
 * The provider is part of the key rather than decoration. Static Web Apps
 * mints `userId` per identity provider, so the same human signing in through
 * Google and through Microsoft is two identities and must not collide into
 * one. See identity.js for what is done with it.
 */
export function identityKey(principal) {
    const provider = String(principal?.provider ?? '').trim().toLowerCase();
    const userId = String(principal?.userId ?? '').trim().toLowerCase();
    if (!provider || !userId) return null;
    return `${provider}:${userId}`;
}
