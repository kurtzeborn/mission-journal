// Tying a membership to a sign-in rather than to a string somebody typed.
//
// An ACL entry has always been keyed on the email address an owner typed into
// the invitation form. That works right up until the address stops being the
// person: a Gmail user who signs in as `first.last@` one day and `firstlast@`
// the next, a Microsoft account whose primary address is changed at work, a
// family that moves off an ISP domain. In every one of those the archive has
// not changed hands, but the ACL no longer recognizes anybody.
//
// So each entry also carries the identity that walked through the door --
// `provider:userId`, taken from the Static Web Apps principal. It is stamped
// on the first time somebody signs in, and from then on it is what survives
// the address changing underneath it.
//
// **The identity is an additional key, not a replacement.** An entry matches
// on its identity *or* its address, and adding one never takes access away
// from anyone. That is a deliberate trade. Refusing the address once an
// identity is bound would harden the ACL against a recycled mailbox, which is
// remote, at the cost of locking out anyone who signs in with the other
// provider using the same address, which is likely. This is a family archive
// with a guest list an owner typed by hand; the accident is the thing worth
// defending against.
//
// **Operators are not in this file at all.** Service-wide operator rights are
// matched on the address and nothing else, deliberately, so that the same
// person is the same operator through either provider. See operators.js.

import { createHash } from 'node:crypto';
import { ROLE } from './acl.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { forgetMembership, membershipsFor, recordMembership } from './memberships.js';
import { identityKey } from './principal.js';
import { TABLES } from './tables.js';
import { validSlug } from './paths.js';

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
const lower = (value) => String(value ?? '').trim().toLowerCase();

// Hashed for the same two reasons as `optouts` and `deliveries`: it keeps an
// opaque provider subject out of a row key that turns up in logs and traces,
// and it sidesteps the characters Table storage forbids there.
export const identityRow = (key) => createHash('sha256').update(String(key), 'utf8').digest('hex');

const ACL = (slug) => `${slug}/acl.json`;

const stronger = (a, b) => (a === ROLE.owner || b === ROLE.owner ? ROLE.owner : ROLE.reader);

/**
 * Point one site's ACL at this identity, and at the address it is using now.
 *
 * Finds the entry by identity first and by the previous address second, which
 * is what makes this safe to run twice: once the stamp is on, the address it
 * was found by no longer matters.
 *
 * @returns {Promise<string|null>} the role the entry ended up with, or null
 *                                 when there was no entry to stamp
 */
async function stamp({ store, slug, key, was, now }) {
    const safe = validSlug(slug);
    if (!safe) return null;

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const existing = await store.readBlob('config', ACL(safe));
        if (!existing) return null;

        const acl = JSON.parse(Buffer.from(existing.bytes).toString('utf8'));
        const members = Array.isArray(acl.members) ? acl.members : [];

        const mine = members.find((m) => m.identity === key) ??
            members.find((m) => lower(m.email) === was);
        if (!mine) return null;

        // Already exactly right, which is the case every time somebody signs
        // in without having changed anything. Nothing is written.
        if (mine.identity === key && lower(mine.email) === now) return mine.role;

        // The address they have moved to may already be on this ACL under an
        // entry of its own -- invited twice, years apart, under both. Merging
        // rather than renaming is what stops an owner being shown the same
        // person twice with no way to tell which row is live.
        const twin = members.find((m) => m !== mine && lower(m.email) === now);

        const merged = {
            ...(twin ?? {}),
            ...mine,
            email: now,
            identity: key,
            role: twin ? stronger(mine.role, twin.role) : mine.role,
            verifiedMissionary: Boolean(mine.verifiedMissionary || twin?.verifiedMissionary)
        };

        const next = members
            .filter((m) => m !== twin)
            .map((m) => (m === mine ? merged : m));

        try {
            await store.writeBlob('config', ACL(safe), utf8({ ...acl, slug: safe, members: next }), {
                contentType: 'application/json',
                ifMatch: existing.etag
            });
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
            continue;
        }

        return merged.role;
    }

    return null;
}

/**
 * Reconcile one signed-in principal against everything keyed on their address.
 *
 * Called from the memberships endpoint, which is the nearest thing this API
 * has to a sign-in hook: asked once per page load, by somebody who has just
 * proved who they are, and by nobody else.
 *
 * Three outcomes, and the first is overwhelmingly the common one:
 *
 *   `known`   -- we have seen this identity at this address. One point read
 *                and nothing else, which is what makes this affordable on a
 *                path that runs on every page load.
 *   `bound`   -- first sign-in for this identity. Its stamp goes onto every
 *                ACL the address is already on.
 *   `renamed` -- same identity, different address. The ACLs and the
 *                membership index are both moved across.
 *
 * `sites` is the membership list the caller has already fetched for the
 * current address, passed in rather than re-queried.
 *
 * Failures are logged and swallowed. This runs alongside the answer the page
 * actually came for, and a family should not lose their site list because a
 * bookkeeping write lost a race.
 *
 * @returns {Promise<{status: string, slugs: string[]}>}
 */
export async function reconcileIdentity({
    store,
    tables,
    principal,
    sites = [],
    now = () => new Date(),
    log = console
}) {
    const key = identityKey(principal);
    const email = lower(principal?.email);
    if (!key || !email) return { status: 'anonymous', slugs: [] };

    const rowKey = identityRow(key);

    try {
        const row = await tables.getEntity(TABLES.identities, 'identity', rowKey);
        const was = lower(row?.email);

        if (was === email) return { status: 'known', slugs: [] };

        // On a rename the sites worth visiting are the ones the *old* address
        // belongs to; the new one is, by definition, on none of them yet.
        const slugs = was
            ? (await membershipsFor({ tables, email: was })).map((m) => m.slug)
            : sites.map((m) => m.slug);

        const moved = [];
        for (const slug of slugs) {
            const role = await stamp({ store, slug, key, was: was || email, now: email });
            if (!role) continue;
            moved.push(slug);

            if (!was) continue;

            // The ACL has already changed hands; the index is repaired after
            // it and never before, the same way members.js orders these two.
            await recordMembership({ tables, email, slug, role, now });
            await forgetMembership({ tables, email: was, slug });
        }

        await tables.upsertEntity(TABLES.identities, {
            partitionKey: 'identity',
            rowKey,
            email,
            at: now().toISOString()
        });

        if (was) {
            log?.warn?.('identity.renamed', { from: was, to: email, sites: moved.length });
        }

        return { status: was ? 'renamed' : 'bound', slugs: moved };
    } catch (error) {
        log?.error?.('identity: could not reconcile', { email, error: error.message });
        return { status: 'failed', slugs: [] };
    }
}
