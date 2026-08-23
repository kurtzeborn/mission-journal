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

// How many letter subjects the claim page gets to show. Enough for someone to
// recognise their missionary's voice and believe the link is real; few enough
// that a stolen link does not hand over a summary of the whole archive.
export const SAMPLE_SUBJECTS = 3;

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
export async function holdPending({ store, slug, ulid, raw, envelope = {}, subject = '', sender = '', forwarder = '', messageId = '', hasDirect = false, now, log }) {
    // The envelope rides along with the bytes. It is not recoverable from the
    // message -- it is what the sending server said, not what the message
    // claims -- and promotion writes it into the archive months later, so
    // losing it here would mean losing it permanently.
    await store.writeBlob('pending', `${slug}/${pendingRawName(ulid)}`, raw, {
        contentType: 'message/rfc822',
        metadata: {
            envelopeto: encodeURIComponent(envelope.to ?? ''),
            envelopefrom: encodeURIComponent(envelope.from ?? '')
        }
    });

    const manifest = await touchClaim({ store, slug, hasDirect, subject, sender, forwarder, messageId, now });

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
async function touchClaim({ store, slug, hasDirect, subject = '', sender = '', forwarder = '', messageId = '', now }) {
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

        // The earliest subjects, not the latest. Someone deciding whether a
        // claim link is genuine is best served by the letters they are most
        // likely to have already seen forwarded around the family.
        const sampleSubjects = [...(existing?.sampleSubjects ?? [])];
        if (subject && sampleSubjects.length < SAMPLE_SUBJECTS) sampleSubjects.push(subject);

        const manifest = {
            slug,
            createdAt: existing?.createdAt ?? at,
            lastMessageAt: at,
            expiresAt: new Date(Date.parse(at) + days * DAY_MS).toISOString(),
            hasDirect: direct,
            messageCount: (existing?.messageCount ?? 0) + 1,
            sampleSubjects,
            // The address the letters came from, shown on the claim page so a
            // recipient can tell whose archive they are being offered.
            sender: existing?.sender ?? sender,
            // Who forwarded it, which on a bootstrap is the only address a
            // claim link may go to -- `sender` above is the missionary the
            // letters are about, and is the one person who must not be sent
            // one. The first forwarder, not the latest: they hold the link.
            forwarder: existing?.forwarder || forwarder || null,
            // The newest held letter's own `Message-ID`, kept so the claim
            // email can thread as a reply to it. The newest rather than the
            // first: the recipient wrote it most recently, so it is the one
            // their mail client still has open in a thread rather than one
            // they have to go looking for. Null when the sender's client
            // omitted the header, which threads nothing and breaks nothing.
            lastMessageId: messageId || existing?.lastMessageId || null,
            // Written by the claim flow, declared here so the whole shape of
            // the record is visible in one place. Only ever a hash: read
            // access to this blob must not confer the ability to claim the
            // site it describes.
            claimTokenHash: existing?.claimTokenHash ?? null,
            claimEmailSentAt: existing?.claimEmailSentAt ?? null,
            claimEmailCount: existing?.claimEmailCount ?? 0,
            emailedAddresses: existing?.emailedAddresses ?? [],
            claimedAt: existing?.claimedAt ?? null,
            claimedBy: existing?.claimedBy ?? null
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

const decodeMeta = (value) => {
    try {
        return decodeURIComponent(value ?? '');
    } catch {
        return '';
    }
};

/**
 * Where a claim link for a pending site should go.
 *
 * In order of how much we actually know. The last address offered comes
 * first, because minting supersedes and that person is holding the link this
 * one replaces. Then the recorded forwarder. `sender` is only ever right on a
 * direct site -- on a forwarded one it is the missionary, who must not be
 * handed a credential for an archive they never asked for.
 *
 * The envelope of the newest held letter is the last resort, for sites held
 * before the forwarder was written down. It is what the sending server said
 * rather than what the message claims, so it is the better guess of the two
 * even though it comes last.
 */
export async function pendingRecipient({ store, slug, manifest }) {
    const emailed = manifest?.emailedAddresses ?? [];
    if (emailed.length) return emailed[emailed.length - 1];
    if (manifest?.forwarder) return manifest.forwarder;
    if (manifest?.hasDirect && manifest.sender) return manifest.sender;

    const held = (await store.listBlobs('pending', `${slug}/`)).filter((name) => name.endsWith('.eml')).sort();
    if (!held.length) return '';

    const blob = await store.readBlob('pending', held[held.length - 1]);
    return decodeMeta(blob?.metadata?.envelopefrom);
}

/**
 * Every site holding letters nobody has claimed.
 *
 * Unreadable manifests are reported rather than skipped, which is the
 * opposite of what the purge and reminder sweeps do. They decline to act on
 * what they cannot read; this is a page whose whole purpose is to show an
 * operator what is stuck, and a manifest nobody can parse is the most stuck
 * thing there is.
 */
export async function listPending({ store, log = console }) {
    const names = await store.listBlobs('pending', '');
    const sites = [];

    for (const name of names.filter((entry) => entry.endsWith('/claim.json'))) {
        const slug = name.slice(0, -'/claim.json'.length);

        let manifest;
        try {
            const blob = await store.readBlob('pending', name);
            manifest = blob ? JSON.parse(Buffer.from(blob.bytes).toString('utf8')) : null;
        } catch (error) {
            log.error?.('pending: unreadable manifest', { slug, error: error.message });
            sites.push({ slug, unreadable: true });
            continue;
        }

        if (!manifest || manifest.claimedAt) continue;

        sites.push({
            slug,
            sender: manifest.sender ?? '',
            recipient: await pendingRecipient({ store, slug, manifest }),
            messageCount: manifest.messageCount ?? 0,
            hasDirect: Boolean(manifest.hasDirect),
            createdAt: manifest.createdAt ?? null,
            expiresAt: manifest.expiresAt ?? null,
            offeredAt: manifest.claimEmailSentAt ?? null,
            offerCount: manifest.claimEmailCount ?? 0
        });
    }

    return sites.sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
}
