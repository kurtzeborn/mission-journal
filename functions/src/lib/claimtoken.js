// Claim tokens: proving you were sent a link, without a session.
//
// A claim link is handed to someone who has never signed in, may never have
// heard of this service, and is being asked to take ownership of a stranger's
// letters. There is no account to authenticate against yet -- possession of
// the link *is* the credential -- so the token has to carry its own proof.
//
// Two independent checks, because they fail in different ways:
//
//   1. **The signature.** The token says which slug it is for and when it
//      stops working, in the clear, and carries an HMAC over both. A forged
//      or edited token is refused arithmetically, before any storage lookup,
//      so an attacker cannot use the claim endpoint to probe which slugs
//      exist by timing or by error message.
//
//   2. **The spend record.** A valid signature is not enough, because a link
//      that works twice is a link that can be replayed out of a mailbox
//      months later. `claim.json` stores the token's *hash*, and redemption
//      marks it spent. Only the hash is stored, so read access to that blob
//      never confers the ability to claim the site.
//
// Neither check subsumes the other. The signature stops forgery without
// touching storage; the hash stops replay of a token that was genuinely
// issued. Dropping either one leaves a real attack.
//
// The payload is deliberately readable. There is nothing secret in "this
// link is for elder.example and expires in November" -- the recipient was
// just told both in the email -- and making it opaque would only make the
// failure page unable to say anything useful.

import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

// URL-safe base64 without padding. These end up in a path segment that gets
// pasted into mail clients, chat apps and, eventually, someone's phone
// keyboard, so `+`, `/` and `=` are all worth avoiding.
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const unb64url = (text) => Buffer.from(String(text), 'base64url');

const NONCE_BYTES = 24;

/**
 * The value stored in `claim.json`, never the token itself.
 *
 * SHA-256 with no salt and no stretching is right here and would be wrong for
 * a password: the input is 24 bytes of `randomBytes`, so there is no
 * dictionary to attack and nothing a work factor would buy.
 */
export function claimTokenHash(token) {
    return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

const sign = (payloadText, key) =>
    createHmac('sha256', key).update(payloadText, 'utf8').digest();

/**
 * Mint a token for a pending site.
 *
 * @param {object} input
 * @param {string} input.slug
 * @param {string|Buffer} input.key       HMAC key, from Key Vault
 * @param {string} input.expiresAt        RFC3339; normally the pending site's own rolling expiry
 * @returns {{token: string, hash: string, expiresAt: string}}
 */
export function issueClaimToken({ slug, key, expiresAt }) {
    if (!slug) throw new Error('claim token: slug is required');
    if (!key) throw new Error('claim token: signing key is required');
    if (!expiresAt) throw new Error('claim token: expiresAt is required');

    const payload = { slug, exp: expiresAt, n: b64url(randomBytes(NONCE_BYTES)) };
    const payloadText = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const token = `${payloadText}.${b64url(sign(payloadText, key))}`;

    return { token, hash: claimTokenHash(token), expiresAt };
}

/**
 * Check a token's signature and expiry. Says nothing about whether it has
 * been spent -- that is a storage question and belongs to the caller.
 *
 * Every failure returns a reason rather than throwing, because the caller
 * renders a page from it and the difference between "expired" and "not a real
 * link" is the difference between offering a fresh email and not.
 *
 * @returns {{valid: boolean, slug?: string, expiresAt?: string, hash?: string, reason?: string}}
 */
export function verifyClaimToken({ token, key, now = () => new Date() }) {
    const text = String(token ?? '');
    const dot = text.indexOf('.');
    if (dot <= 0 || dot === text.length - 1) return { valid: false, reason: 'malformed' };

    const payloadText = text.slice(0, dot);
    const provided = unb64url(text.slice(dot + 1));
    const expected = sign(payloadText, key);

    // Compare before parsing. `timingSafeEqual` throws on a length mismatch,
    // which is itself a length oracle, so the lengths are checked first and
    // both paths return the same undifferentiated answer.
    if (provided.length !== expected.length) return { valid: false, reason: 'bad-signature' };
    if (!timingSafeEqual(provided, expected)) return { valid: false, reason: 'bad-signature' };

    // Only now is the payload trusted enough to parse. Reaching here means
    // the bytes are ours, so a parse failure is a bug on our side rather than
    // an attack, but it still must not throw into the request handler.
    let payload;
    try {
        payload = JSON.parse(unb64url(payloadText).toString('utf8'));
    } catch {
        return { valid: false, reason: 'malformed' };
    }

    if (!payload?.slug || !payload?.exp) return { valid: false, reason: 'malformed' };

    if (Date.parse(payload.exp) <= now().getTime()) {
        // The slug comes back anyway. An expired link is a real link that was
        // sent to a real person, and the page they land on should be able to
        // offer them a fresh one.
        return { valid: false, reason: 'expired', slug: payload.slug, expiresAt: payload.exp };
    }

    return {
        valid: true,
        slug: payload.slug,
        expiresAt: payload.exp,
        hash: claimTokenHash(text)
    };
}
