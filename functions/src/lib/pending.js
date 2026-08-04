// Letters for a site that does not exist yet.
//
// A missionary who BCCs `post@` before anyone has set up their site is doing
// the most natural thing in the world, and until now it produced the worst
// outcome in the file: `classify` resolves a slug from their own address, the
// direct branch consults no ACL, and the letter published to a slug with no
// `acl.json` and no `profile.json` -- rendered, stored, readable by nobody,
// and cleaned up by nothing. Nobody would ever have been told.
//
// So the letters are held instead. Nothing is rendered, no `posts.json` is
// written, and no photos are extracted, because none of that can be shown to
// anyone until somebody has claimed the site and proved they should see it.
//
// This is the accumulation half of the pending-site design. The claim email,
// the `/claim/{token}` page, and promotion into `raw/` are Phase 7 and are
// deliberately absent -- but accumulation is the half that has to exist
// *first*, because it is the half that loses letters if it is missing. A
// claim flow can be built next week against letters already safely held; it
// cannot recover letters that were dropped while it was being built.

import { CONFLICT_RETRIES, isConflict } from './conflict.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Rolling windows, measured from the last message rather than the first. A
// site receiving weekly letters never expires, because each arrival is fresh
// evidence the slug is real and in use. Sixty days once the missionary has
// written to us directly, because that is a person we can actually invite;
// fourteen while the site is forward-only.
export const PENDING_DAYS = { direct: 60, forwardOnly: 14 };

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');

export const pendingRawName = (ulid) => `${ulid}.eml`;

/**
 * Hold a message for a slug that has no site.
 *
 * The raw message is written before the manifest, so a crash between the two
 * leaves a letter on disk with no record of it rather than a record pointing
 * at nothing. The first is recoverable by listing the container; the second
 * would have to be discovered by a human noticing an absence.
 *
 * @param {object} input
 * @param {object} input.store
 * @param {string} input.slug      already validated by the caller
 * @param {string} input.ulid
 * @param {Buffer} input.raw
 * @param {boolean} [input.hasDirect]
 * @param {function} input.now
 * @param {object} [input.log]
 */
export async function holdPending({ store, slug, ulid, raw, hasDirect = false, now, log }) {
    await store.writeBlob('pending', `${slug}/${pendingRawName(ulid)}`, raw, {
        contentType: 'message/rfc822'
    });

    const manifest = await touchClaim({ store, slug, hasDirect, now });

    log?.info?.('ingest: held pending', {
        ulid,
        slug,
        messageCount: manifest.messageCount,
        hasDirect: manifest.hasDirect,
        expiresAt: manifest.expiresAt
    });

    return manifest;
}

// Read-modify-write under an ETag, for the same reason `posts.json` is: a
// missionary forwarding a backlog in one sitting produces several messages
// racing each other, and an unguarded write would lose all but one -- taking
// the message count and, worse, the rolling expiry with it.
async function touchClaim({ store, slug, hasDirect, now }) {
    const name = `${slug}/claim.json`;
    const at = now().toISOString();

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const current = await store.readBlob('pending', name);
        const existing = current
            ? JSON.parse(Buffer.from(current.bytes).toString('utf8'))
            : null;

        // Once direct, always direct. A forward arriving after the
        // missionary's own message must not shorten the window back to
        // fourteen days and strand a site that was about to be claimed.
        const direct = Boolean(existing?.hasDirect) || hasDirect;
        const days = direct ? PENDING_DAYS.direct : PENDING_DAYS.forwardOnly;

        const manifest = {
            slug,
            createdAt: existing?.createdAt ?? at,
            lastMessageAt: at,
            expiresAt: new Date(Date.parse(at) + days * DAY_MS).toISOString(),
            hasDirect: direct,
            messageCount: (existing?.messageCount ?? 0) + 1
            // Phase 7 adds the claim token hash and the list of addresses
            // already emailed. Only a hash is ever stored, so read access to
            // this blob will not confer the ability to claim the site.
        };

        try {
            await store.writeBlob('pending', name, utf8(manifest), {
                contentType: 'application/json',
                ...(current ? { ifMatch: current.etag } : { ifNoneMatch: '*' })
            });
            return manifest;
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }

    throw new Error(`pending: could not update claim.json for ${slug}`);
}
