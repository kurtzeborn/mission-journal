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
import { setSiteProfile, sitesBySlug } from './sites.js';
import { promotePending } from './promote.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { ROLE } from './acl.js';
import { validSlug } from './paths.js';
import { MISSIONARY_CLAIM } from './claimverb.js';
import { RELAY_CLAIM } from './relay.js';

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

/** The pending manifest, or nothing. For callers that only want to read it. */
export async function claimManifest(store, slug) {
    return (await readClaimBlob(store, slug))?.manifest ?? null;
}

async function readMissionaryBlob(store, slug) {
    const safe = validSlug(slug);
    if (!safe) return null;
    const blob = await store.readBlob('config', `${safe}/${MISSIONARY_CLAIM}`);
    if (!blob) return null;
    return { record: JSON.parse(Buffer.from(blob.bytes).toString('utf8')), etag: blob.etag };
}

async function readRelayBlob(store, slug) {
    const safe = validSlug(slug);
    if (!safe) return null;
    const blob = await store.readBlob('config', `${safe}/${RELAY_CLAIM}`);
    if (!blob) return null;
    return { record: JSON.parse(Buffer.from(blob.bytes).toString('utf8')), etag: blob.etag };
}

/**
 * Which grant is this token for?
 *
 * The three kinds are deliberately indistinguishable from the token itself --
 * all are `issueClaimToken({ slug, key, expiresAt })`, and putting the kind in
 * the payload would mean a signed assertion about its own privilege level
 * travelling through a stranger's mailbox. That matters most for the relay
 * grant, whose whole design has it pass through one. The stored hash is what
 * decides, which keeps the answer server-side and unforgeable.
 *
 * The missionary record is checked first. If a slug somehow has a live hash in
 * more than one, the one that proves control of the missionary mailbox is the
 * stronger evidence and should win.
 *
 * The trailing fallbacks are what let a spent or superseded token be told
 * apart from a slug that never existed.
 */
async function grantFor({ store, slug, hash }) {
    const missionary = await readMissionaryBlob(store, slug);
    if (missionary && missionary.record.claimTokenHash === hash) {
        return { kind: 'missionary', ...missionary };
    }
    const relay = await readRelayBlob(store, slug);
    if (relay && relay.record.claimTokenHash === hash) {
        return { kind: 'relay', ...relay };
    }
    const pending = await readClaimBlob(store, slug);
    if (pending) return { kind: 'pending', ...pending };
    if (missionary) return { kind: 'missionary', ...missionary };
    return relay ? { kind: 'relay', ...relay } : null;
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
 *
 * **This records only that a token exists, never that anyone was told.** The
 * two used to happen in one write, and that was wrong in a way that only
 * showed up once the purge timer was built: `claimEmailCount` is the evidence
 * behind "expired without ever being offered", and incrementing it before the
 * send meant a failed send left a manifest claiming the offer had been made.
 * The letters would then be deleted on schedule, silently, by the very job
 * written to shout about that exact case. See `recordClaimEmailSent`.
 */
export async function attachClaimToken({ store, slug, key, now = () => new Date() }) {
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const found = await readClaimBlob(store, slug);
        if (!found) return null;
        if (found.manifest.claimedAt) return { status: 'claimed' };

        const issued = issueClaimToken({ slug, key, expiresAt: found.manifest.expiresAt });

        const manifest = { ...found.manifest, claimTokenHash: issued.hash };

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
 * Record that a claim email actually went out.
 *
 * Called only after the provider has accepted the message. Everything here is
 * bookkeeping -- nobody's access depends on it -- so the caller is expected to
 * treat a failure as loggable rather than fatal. The one thing it must never
 * do is run when nothing was sent.
 */
export async function recordClaimEmailSent({ store, slug, emailTo, now = () => new Date() }) {
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const found = await readClaimBlob(store, slug);
        if (!found) return null;

        const emailed = new Set(found.manifest.emailedAddresses ?? []);
        if (emailTo) emailed.add(lower(emailTo));

        const manifest = {
            ...found.manifest,
            claimEmailSentAt: now().toISOString(),
            claimEmailCount: (found.manifest.claimEmailCount ?? 0) + 1,
            emailedAddresses: [...emailed]
        };

        try {
            await store.writeBlob('pending', `${slug}/${CLAIM}`, utf8(manifest), {
                contentType: 'application/json',
                ifMatch: found.etag
            });
            return manifest;
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }
    throw new Error(`claim: could not record a claim email for ${slug}`);
}

/**
 * What the landing page may show before anyone signs in.
 *
 * Everything returned here is visible to whoever holds the link, so it is
 * limited to what the recipient needs in order to believe the page: whose
 * letters these are, how many are waiting, and a few subject lines they may
 * recognize. Not the letters themselves, and never the addresses the claim
 * email was sent to.
 */
export async function describeClaim({ store, tables, token, key, now = () => new Date() }) {
    const verified = verifyClaimToken({ token, key, now });
    if (!verified.valid && verified.reason !== 'expired') return { status: 'invalid' };

    const grant = await grantFor({ store, slug: verified.slug, hash: verified.hash });

    // The token is well-formed but the site is gone -- purged after expiry, or
    // already claimed and promoted. Both look the same from here and both are
    // told the same thing, because distinguishing them would let a stale link
    // report whether a given slug now exists.
    if (!grant) return { status: 'gone', slug: verified.slug };

    if (grant.kind === 'missionary') {
        return describeMissionaryGrant({ store, tables, grant, verified });
    }

    if (grant.kind === 'relay') {
        return describeRelayGrant({ store, grant, verified });
    }

    const found = grant;

    if (found.manifest.claimedAt) return { status: 'claimed', slug: verified.slug };
    if (verified.reason === 'expired') return { status: 'expired', slug: verified.slug };

    // A superseded token: correctly signed, unexpired, but no longer the token
    // this site is expecting because a newer link was issued.
    if (found.manifest.claimTokenHash !== verified.hash) {
        return { status: 'superseded', slug: verified.slug };
    }

    return {
        status: 'ready',
        kind: 'pending',
        slug: verified.slug,
        sender: found.manifest.sender ?? '',
        messageCount: found.manifest.messageCount ?? 0,
        sampleSubjects: found.manifest.sampleSubjects ?? [],
        expiresAt: found.manifest.expiresAt
    };
}

/**
 * The same questions asked of a verified-missionary grant, which answers two
 * of them differently.
 *
 * A spent grant is `ready`, not `claimed`. The pending path treats redemption
 * as final because the first person through the link becomes the sole owner
 * and a second one would be an eviction. Here redemption is additive and the
 * redeemer has already proved control of the mailbox, so their own retry --
 * or a second personal account -- is a reasonable thing to want, and refusing
 * it would strand somebody who closed the tab at the wrong moment.
 *
 * Nothing about the letters is returned. The pending description exists to let
 * a recipient recognize mail they were not expecting; this recipient asked for
 * the link and needs no convincing, so the safest payload is the smallest one.
 *
 * Two facts are returned that the pending description has no use for, because
 * this link lands on a site that may already be running and the page cannot
 * tell the truth without them. `alreadyOwned` is the difference between
 * setting an archive up and being let into one, which the button, the heading
 * and the closing summary all get wrong when they assume the former.
 * `displayName` is whatever the site is currently called, so the form can
 * offer it back rather than asking a question that has already been answered.
 *
 * Neither is a new disclosure of consequence: the holder of this token is
 * already told the missionary's full address, which identifies the site far
 * more sharply than the name on it or the fact that somebody is looking after
 * it.
 */
async function describeMissionaryGrant({ store, tables, grant, verified }) {
    if (grant.record.claimTokenHash !== verified.hash) {
        return { status: 'superseded', slug: verified.slug };
    }
    if (verified.reason === 'expired') return { status: 'expired', slug: verified.slug };

    const slug = verified.slug;
    const acl = await store.readBlob('config', `${slug}/acl.json`);
    const sites = await sitesBySlug({ tables, slugs: [slug] });

    return {
        status: 'ready',
        kind: 'missionary',
        slug,
        sender: grant.record.sender ?? '',
        alreadyOwned: Boolean(acl),
        displayName: sites.get(slug)?.missionaryDisplayName ?? '',
        messageCount: 0,
        sampleSubjects: [],
        expiresAt: grant.record.expiresAt
    };
}

/**
 * The same questions asked of a relay grant, which is neither of the others.
 *
 * There is no pending site behind it and there are no letters to describe: the
 * grant was created because a letter could *not* be accepted, and the family
 * member will forward their stack again once they are on the ACL. So the page
 * has nothing to convince anyone with except the two addresses, which is
 * exactly right for a link whose holder was told what it was for in the
 * message that carried it.
 *
 * `owned` is folded into `claimed` rather than given a status of its own. It
 * means the archive came into being some other way while this link sat in a
 * mailbox -- another family member got a verifiable forward through, or the
 * missionary claimed it themselves -- and what that page already says is the
 * right advice: it exists, ask whoever runs it to add you. A relay grant is
 * deliberately not a way into an archive that already has an owner.
 */
async function describeRelayGrant({ store, grant, verified }) {
    const slug = verified.slug;

    if (grant.record.claimTokenHash !== verified.hash) return { status: 'superseded', slug };
    if (verified.reason === 'expired') return { status: 'expired', slug };

    // Not a refusal on its own: the redeemer's own retry looks like this, and
    // `redeemClaim` lets it through to be checked against the principal. The
    // kind has to travel with it, or the retry is dispatched to the pending
    // path and told the letters are gone.
    if (grant.record.claimedAt) return { status: 'claimed', kind: 'relay', slug };

    // Raced by some other route into existence. Terminal, and deliberately not
    // dispatched anywhere: spending this token would burn it against a site
    // the holder cannot be given.
    const acl = await store.readBlob('config', `${slug}/acl.json`);
    if (acl) return { status: 'owned', slug };

    return {
        status: 'ready',
        kind: 'relay',
        slug,
        sender: grant.record.author ?? '',
        messageCount: 0,
        sampleSubjects: [],
        expiresAt: grant.record.expiresAt
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

    const described = await describeClaim({ store, tables, token, key, now });

    // `claimed` is not necessarily a refusal: it is also what the claimant's
    // own retry looks like. Everything else here is final.
    if (described.status !== 'ready' && described.status !== 'claimed') return described;

    const slug = validSlug(described.slug);
    if (!slug) return { status: 'invalid' };

    if (described.kind === 'missionary') {
        // `currentName` comes from the description rather than a second read of
        // the sites table: it is the same value the form was prefilled with, so
        // comparing against it answers the question that actually matters --
        // did they change what they were shown -- rather than the question a
        // fresh read would answer, which is whether anything moved underneath
        // them in the seconds since.
        return redeemMissionaryGrant({
            store, tables, token, key, email, displayName,
            currentName: described.displayName ?? '',
            slug, now, log
        });
    }

    if (described.kind === 'relay') {
        return redeemRelayGrant({ store, tables, token, key, email, displayName, slug, now, log });
    }

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
        now
    });

    // The name the claimant typed belongs to the site, not to their
    // membership of it: everyone added later should see the same name, and
    // changing it later should not mean rewriting one row per reader.
    //
    // Guarded, because by this point the ACL exists and the person is already
    // the owner. Failing the whole claim over a display name would hand them
    // an error for a site they have in fact just been given, and the name is
    // the one thing here that costs nothing to fix afterwards.
    try {
        await setSiteProfile({
            tables,
            slug,
            missionaryDisplayName: spent.missionaryDisplayName ?? displayName ?? ''
        });
    } catch (error) {
        log.error?.('claim: site name write failed', { slug, error: error.message });
    }

    // --- 4. publish ------------------------------------------------------
    const promoted = await promotePending({ store, tables, slug, now, log });

    log.info?.('claim: redeemed', {
        slug,
        promoted: promoted.promoted,
        duplicates: promoted.duplicates,
        failed: promoted.failed.length
    });

    return { status: 'ok', slug, promoted };
}

/**
 * Redeem a relay grant: the missionary vouched, and this is the person they
 * vouched for.
 *
 * Written against the pending path rather than the missionary one, because the
 * central write is the pending path's. `acl.json` is created with
 * `If-None-Match: *` and an ACL that already exists means somebody got there
 * first -- the opposite of the missionary grant, where joining an archive a
 * parent has been running for months is the expected case.
 *
 * The redeemer becomes an owner **without** the verified-missionary flag. What
 * reaching here proves is that a link we mailed to a missionary was opened;
 * the missionary chose to pass it on, which is exactly the authorisation this
 * flow was built to collect, and it is not evidence about who is holding it
 * now. The flag confers removal protection and belongs only to somebody who
 * proved control of the mailbox itself.
 *
 * Nothing is promoted that was not already held. The letter that started all
 * this was refused at ingest and never stored, so the backlog here is normally
 * empty and the family member re-forwards their stack afterwards -- which now
 * works, because they are on the ACL and membership is what the forward path
 * checks.
 */
async function redeemRelayGrant({ store, tables, token, key, email, displayName, slug, now, log }) {
    const verified = verifyClaimToken({ token, key, now });
    const at = now().toISOString();

    // --- 1. spend --------------------------------------------------------
    let spent = null;
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const found = await readRelayBlob(store, slug);
        if (!found) return { status: 'gone', slug };
        if (found.record.claimTokenHash !== verified.hash) return { status: 'superseded', slug };

        if (found.record.claimedAt) {
            if (lower(found.record.claimedBy) !== email) return { status: 'claimed', slug };
            // Our own earlier attempt. Fall through and finish the job.
            spent = found.record;
            break;
        }

        const record = { ...found.record, claimedAt: at, claimedBy: email };

        try {
            await store.writeBlob('config', `${slug}/${RELAY_CLAIM}`, utf8(record), {
                contentType: 'application/json',
                ifMatch: found.etag
            });
            spent = record;
            break;
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }
    if (!spent) return { status: 'claimed', slug };

    // --- 2. grant --------------------------------------------------------
    const acl = {
        slug,
        members: [{ email, role: ROLE.owner, verifiedMissionary: false, addedAt: at }]
    };

    let created = false;
    try {
        await store.writeBlob('config', `${slug}/acl.json`, utf8(acl), {
            contentType: 'application/json',
            ifNoneMatch: '*'
        });
        created = true;
    } catch (error) {
        if (!isConflict(error)) throw error;
        // Either our own retry or a genuine race. The ACL, not the grant, is
        // the authority on which -- and either way this person is not being
        // added to a site that already has an owner.
        const existing = await store.readBlob('config', `${slug}/acl.json`);
        const members = existing
            ? (JSON.parse(Buffer.from(existing.bytes).toString('utf8')).members ?? [])
            : [];
        if (!members.some((m) => lower(m.email) === email)) {
            log.warn?.('claim: relay grant lost the race for an acl', { slug, email });
            return { status: 'owned', slug };
        }
    }

    // --- 3. index --------------------------------------------------------
    await recordMembership({ tables, email, slug, role: ROLE.owner, now });

    const wanted = String(displayName ?? '').trim();
    if (wanted) {
        try {
            await setSiteProfile({ tables, slug, missionaryDisplayName: wanted });
        } catch (error) {
            log.error?.('claim: site name write failed', { slug, error: error.message });
        }
    }

    // --- 4. publish ------------------------------------------------------
    const promoted = await promotePending({ store, tables, slug, now, log });

    log.info?.('claim: relay grant redeemed', { slug, created, promoted: promoted.promoted });

    return { status: 'ok', slug, created, promoted };
}

/**
 * Redeem a verified-missionary grant.
 *
 * Separate from the pending path rather than a flag inside it, because the
 * central write is the opposite one. There, `acl.json` is created with
 * `If-None-Match: *` and an ACL that already exists means somebody got there
 * first. Here an ACL that already exists is the *expected* case -- a parent has
 * been running the site for months -- and the job is to join it.
 *
 * **Claiming never demotes anyone.** The existing members are read, the
 * missionary is added or upgraded in place, and nobody is removed. That is a
 * policy decision from the plan and not merely an implementation detail: in the
 * overwhelmingly common case the missionary wants access to their own letters
 * while a parent continues to run the site, and evicting the parent would be
 * hostile.
 */
async function redeemMissionaryGrant({ store, tables, token, key, email, displayName, currentName, slug, now, log }) {
    const verified = verifyClaimToken({ token, key, now });
    const at = now().toISOString();

    // --- 1. spend --------------------------------------------------------
    // Before granting, on the same reasoning as the pending path: a crash
    // between the two costs the missionary a fresh email, while granting first
    // would leave a live link against a site that is already theirs.
    let record = null;
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const found = await readMissionaryBlob(store, slug);
        if (!found) return { status: 'gone', slug };
        if (found.record.claimTokenHash !== verified.hash) return { status: 'superseded', slug };

        // Unlike a pending claim, a redeemed grant is not refused -- see
        // `describeMissionaryGrant`. It is simply redeemed again, and the
        // redeemer list grows.
        const redeemedBy = new Set(found.record.redeemedBy ?? []);
        redeemedBy.add(email);

        const next = {
            ...found.record,
            claimTokenHash: null,
            redeemedAt: at,
            redeemedBy: [...redeemedBy]
        };

        try {
            await store.writeBlob('config', `${slug}/${MISSIONARY_CLAIM}`, utf8(next), {
                contentType: 'application/json',
                ifMatch: found.etag
            });
            record = next;
            break;
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }
    if (!record) return { status: 'superseded', slug };

    // --- 2. grant --------------------------------------------------------
    const member = {
        email,
        role: ROLE.owner,
        // The one place in the system permitted to set this true. It confers
        // removal protection, so the evidence behind it has to be control of
        // the missionary mailbox itself -- which is exactly what reaching this
        // function proves, and what following a forwarded link does not.
        verifiedMissionary: true,
        addedAt: at
    };

    let created = false;
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const existing = await store.readBlob('config', `${slug}/acl.json`);

        if (!existing) {
            try {
                await store.writeBlob('config', `${slug}/acl.json`, utf8({ slug, members: [member] }), {
                    contentType: 'application/json',
                    ifNoneMatch: '*'
                });
                created = true;
                break;
            } catch (error) {
                if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
                continue;
            }
        }

        const acl = JSON.parse(Buffer.from(existing.bytes).toString('utf8'));
        const members = acl.members ?? [];
        const mine = members.findIndex((m) => lower(m.email) === email);

        // Already an owner, already verified: this is a retry, and rewriting
        // the blob would only move `addedAt` backwards.
        if (mine >= 0 && members[mine].verifiedMissionary && members[mine].role === ROLE.owner) break;

        const next = [...members];
        if (mine >= 0) {
            // Upgrade in place. `addedAt` is kept, because they have been on
            // this site since whenever a family member added them and the flag
            // does not restart that.
            next[mine] = { ...next[mine], role: ROLE.owner, verifiedMissionary: true };
        } else {
            next.push(member);
        }

        try {
            await store.writeBlob('config', `${slug}/acl.json`, utf8({ ...acl, slug, members: next }), {
                contentType: 'application/json',
                ifMatch: existing.etag
            });
            break;
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }

    // --- 3. index --------------------------------------------------------
    await recordMembership({ tables, email, slug, role: ROLE.owner, now });

    // This used to fire only when the claim created the site, on the grounds
    // that the name on an archive somebody else had been running was theirs to
    // change. That reasoning was written for a stranger holding a forwarded
    // link. It does not survive contact with the person who reaches *this*
    // function, who proved control of the missionary mailbox and, of everyone
    // involved, has the strongest claim to what they are called.
    //
    // So the form shows a verified missionary the current name, prefilled, and
    // an edit is honored. Submitting the prefilled value writes nothing,
    // because it is not a change. An emptied box is ignored rather than read as
    // "erase the name": nothing on the page offers clearing as an action, so a
    // blank arriving here is far likelier to be a stray keystroke than an
    // intention, and blanking a live archive is the more expensive mistake.
    const wanted = String(displayName ?? '').trim();
    if (wanted && wanted !== (currentName ?? '')) {
        try {
            await setSiteProfile({ tables, slug, missionaryDisplayName: wanted });
        } catch (error) {
            log.error?.('claim: site name write failed', { slug, error: error.message });
        }
    }

    // --- 4. publish ------------------------------------------------------
    // Harmless when there is nothing held: a site that was already live has an
    // empty backlog, and `promotePending` reports zero.
    const promoted = await promotePending({ store, tables, slug, now, log });

    log.info?.('claim: missionary grant redeemed', {
        slug,
        created,
        promoted: promoted.promoted,
        failed: promoted.failed.length
    });

    // `created` goes back to the page. Without it the closing screen announces
    // that an archive has been set up and that zero letters were published,
    // which is a strange thing to tell someone who was just let into an archive
    // that has been running for months.
    return { status: 'ok', slug, verifiedMissionary: true, created, promoted };
}
