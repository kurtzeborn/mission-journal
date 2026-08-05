// Turning a link in an email into ownership of an archive.
//
// This is the only place in the system where someone with no account, no
// session and no prior relationship to us acquires access to a family's
// letters. Everything here is written on the assumption that the link will
// eventually be replayed by someone it was not sent to -- forwarded by
// accident, recovered from a backup, scraped out of a mailbox years later --
// and must fail safely when it is.
//
// The order of writes is the whole design:
//
//   1. Mark the token spent on `claim.json`, guarded by its ETag.
//   2. Create `acl.json` with `If-None-Match: *`.
//   3. Record the membership.
//   4. Promote the backlog.
//
// Spending before granting means a crash costs the claimant a retry, while
// granting before spending would leave a live token against a site that
// already has an owner. The `If-None-Match` on step 2 is a second, independent
// guard: even if two requests somehow both believed they had spent the token,
// exactly one of them can create the ACL, and the other finds the site owned.
//
// Steps 1 and 2 are both idempotent *for the same principal*, so a claimant
// whose request died between them can simply follow the link again and
// resume. For a different principal they are absolute: the first person to
// spend the token is the owner, permanently.

import { verifyClaimToken, issueClaimToken } from './claimtoken.js';
import { recordMembership } from './memberships.js';
import { promotePending } from './promote.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { ROLE } from './acl.js';
import { validSlug } from './paths.js';

const CLAIM = 'claim.json';
const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
const lower = (email) => String(email ?? '').trim().toLowerCase();

async function readClaimBlob(store, slug) {
    const safe = validSlug(slug);
    if (!safe) return null;
    const blob = await store.readBlob('pending', `${safe}/${CLAIM}`);
    if (!blob) return null;
    return { manifest: JSON.parse(Buffer.from(blob.bytes).toString('utf8')), etag: blob.etag };
}

/**
 * Mint a claim token for a pending site and record its hash.
 *
 * The token inherits the pending site's own rolling expiry rather than
 * carrying one of its own: a link that outlives the letters it points at is a
 * link that leads to an empty page and an explanation nobody can act on.
 *
 * Minting again replaces the previous hash, which invalidates the earlier
 * link. That is deliberate -- "send me a new link" has to mean the old one
 * stops working, or a reminder email doubles the number of live credentials
 * every time it is sent.
 */
export async function attachClaimToken({ store, slug, key, emailTo, now = () => new Date() }) {
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const found = await readClaimBlob(store, slug);
        if (!found) return null;
        if (found.manifest.claimedAt) return { status: 'claimed' };

        const issued = issueClaimToken({ slug, key, expiresAt: found.manifest.expiresAt });

        const emailed = new Set(found.manifest.emailedAddresses ?? []);
        if (emailTo) emailed.add(lower(emailTo));

        const manifest = {
            ...found.manifest,
            claimTokenHash: issued.hash,
            claimEmailSentAt: now().toISOString(),
            claimEmailCount: (found.manifest.claimEmailCount ?? 0) + 1,
            emailedAddresses: [...emailed]
        };

        try {
            await store.writeBlob('pending', `${slug}/${CLAIM}`, utf8(manifest), {
                contentType: 'application/json',
                ifMatch: found.etag
            });
            return { status: 'issued', token: issued.token, expiresAt: issued.expiresAt, manifest };
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }
    throw new Error(`claim: could not attach a token for ${slug}`);
}

/**
 * What the landing page may show before anyone signs in.
 *
 * Everything returned here is visible to whoever holds the link, so it is
 * limited to what the recipient needs in order to believe the page: whose
 * letters these are, how many are waiting, and a few subject lines they may
 * recognise. Not the letters themselves, and never the addresses the claim
 * email was sent to.
 */
export async function describeClaim({ store, token, key, now = () => new Date() }) {
    const verified = verifyClaimToken({ token, key, now });
    if (!verified.valid && verified.reason !== 'expired') return { status: 'invalid' };

    const found = await readClaimBlob(store, verified.slug);

    // The token is well-formed but the site is gone -- purged after expiry, or
    // already claimed and promoted. Both look the same from here and both are
    // told the same thing, because distinguishing them would let a stale link
    // report whether a given slug now exists.
    if (!found) return { status: 'gone', slug: verified.slug };

    if (found.manifest.claimedAt) return { status: 'claimed', slug: verified.slug };
    if (verified.reason === 'expired') return { status: 'expired', slug: verified.slug };

    // A superseded token: correctly signed, unexpired, but no longer the token
    // this site is expecting because a newer link was issued.
    if (found.manifest.claimTokenHash !== verified.hash) {
        return { status: 'superseded', slug: verified.slug };
    }

    return {
        status: 'ready',
        slug: verified.slug,
        sender: found.manifest.sender ?? '',
        messageCount: found.manifest.messageCount ?? 0,
        sampleSubjects: found.manifest.sampleSubjects ?? [],
        expiresAt: found.manifest.expiresAt
    };
}

/**
 * Spend the token, create the site, and publish everything held for it.
 *
 * @param {object} input
 * @param {string} input.principal    the signed-in address; ownership is bound to it
 * @param {string} [input.displayName] what the missionary should be called on the site
 */
export async function redeemClaim({
    store,
    tables,
    token,
    key,
    principal,
    displayName = '',
    now = () => new Date(),
    log = console
}) {
    const email = lower(principal);
    if (!email) return { status: 'unauthenticated' };

    const described = await describeClaim({ store, token, key, now });

    // `claimed` is not necessarily a refusal: it is also what the claimant's
    // own retry looks like. Everything else here is final.
    if (described.status !== 'ready' && described.status !== 'claimed') return described;

    const slug = validSlug(described.slug);
    if (!slug) return { status: 'invalid' };

    const at = now().toISOString();

    // --- 1. spend --------------------------------------------------------
    let spent = null;
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const found = await readClaimBlob(store, slug);
        if (!found) return { status: 'gone', slug };

        if (found.manifest.claimedAt) {
            if (lower(found.manifest.claimedBy) !== email) return { status: 'claimed', slug };
            // Our own earlier attempt. Fall through and finish the job.
            spent = found.manifest;
            break;
        }

        const manifest = {
            ...found.manifest,
            claimedAt: at,
            claimedBy: email,
            missionaryDisplayName: displayName || found.manifest.missionaryDisplayName || ''
        };

        try {
            await store.writeBlob('pending', `${slug}/${CLAIM}`, utf8(manifest), {
                contentType: 'application/json',
                ifMatch: found.etag
            });
            spent = manifest;
            break;
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }
    if (!spent) return { status: 'claimed', slug };

    // --- 2. grant --------------------------------------------------------
    const acl = {
        slug,
        members: [
            {
                email,
                role: ROLE.owner,
                // False, and only the `claim@` mailbox flow may set it true.
                // Following a link out of a forwarded email proves you were
                // sent the link; it does not prove you are the missionary,
                // and the removal protection that flag confers is too strong
                // to hand out on that evidence.
                verifiedMissionary: false,
                addedAt: at
            }
        ]
    };

    try {
        await store.writeBlob('config', `${slug}/acl.json`, utf8(acl), {
            contentType: 'application/json',
            ifNoneMatch: '*'
        });
    } catch (error) {
        if (!isConflict(error)) throw error;
        // The site already has an ACL. Either this is our own retry, or
        // somebody got there first -- and the ACL, not the claim record, is
        // the authority on which.
        log.warn?.('claim: acl already existed', { slug, email });
    }

    // --- 3. index --------------------------------------------------------
    await recordMembership({
        tables,
        email,
        slug,
        role: ROLE.owner,
        missionaryDisplayName: spent.missionaryDisplayName ?? displayName ?? '',
        now
    });

    // --- 4. publish ------------------------------------------------------
    const promoted = await promotePending({ store, slug, now, log });

    log.info?.('claim: redeemed', {
        slug,
        promoted: promoted.promoted,
        duplicates: promoted.duplicates,
        failed: promoted.failed.length
    });

    return { status: 'ok', slug, promoted };
}
