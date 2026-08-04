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
