// Which sites does this person belong to?
//
// `acl.json` answers "may this address read this slug" in one blob read, and
// that is the question the content API asks on every request. It cannot
// answer the reverse -- "which slugs does this address belong to" -- without
// reading every ACL in the account, and that is the question the root page
// has to answer for someone who has just signed in and wants to get to their
// letters.
//
// So this index exists, and it is *only* an index. Nothing here grants
// access. A row saying you are an owner of a site whose `acl.json` does not
// list you gets you nothing except a link that then refuses you, which is the
// correct failure: a stale index costs a confusing redirect, while a
// trusted one would cost a stranger's letters.

import { TABLES } from './tables.js';

const lower = (email) => String(email ?? '').trim().toLowerCase();

/**
 * Record that an address belongs to a site.
 *
 * Written immediately after the ACL, never before and never instead. If the
 * process dies between the two, the ACL is the one that survived and the
 * person can still reach the site by its URL -- they just will not be
 * redirected there. `rebuildMemberships` repairs that.
 */
export async function recordMembership({
    tables,
    email,
    slug,
    role,
    missionaryDisplayName = '',
    lastPostAt = '',
    now = () => new Date()
}) {
    const partitionKey = lower(email);
    if (!partitionKey || !slug) throw new Error('membership: email and slug are required');

    await tables.upsertEntity(TABLES.memberships, {
        partitionKey,
        rowKey: slug,
        role,
        missionaryDisplayName,
        addedAt: now().toISOString(),
        lastPostAt
    });
}

export async function forgetMembership({ tables, email, slug }) {
    await tables.deleteEntity(TABLES.memberships, lower(email), slug);
}

/**
 * Every site an address belongs to, newest activity first.
 *
 * The sort is what makes the root redirect land somewhere sensible for a
 * relative who follows two missionaries. A site with no posts yet sorts last
 * rather than first, because an empty archive is the least useful place to
 * put someone who just signed in.
 */
export async function membershipsFor({ tables, email }) {
    const rows = await tables.listEntities(TABLES.memberships, { partitionKey: lower(email) });

    return rows
        .map((row) => ({
            slug: row.rowKey,
            role: row.role,
            missionaryDisplayName: row.missionaryDisplayName ?? '',
            addedAt: row.addedAt ?? '',
            lastPostAt: row.lastPostAt ?? ''
        }))
        .sort((a, b) => {
            if (a.lastPostAt !== b.lastPostAt) return a.lastPostAt < b.lastPostAt ? 1 : -1;
            return a.slug < b.slug ? -1 : 1;
        });
}

/**
 * Rebuild one site's rows from its ACL.
 *
 * The index is derived, so it must be reconstructible: a failed write, a
 * hand-edited ACL, or a table restored from an older backup all leave it
 * wrong, and none of them should need a human to reason about which rows are
 * missing. Rows for addresses no longer on the ACL are removed, because a
 * membership that outlives its ACL entry is exactly the stale redirect this
 * module promises not to leave behind.
 */
export async function rebuildMemberships({ tables, slug, acl, missionaryDisplayName = '', lastPostAt = '', now }) {
    const members = acl?.members ?? [];
    const wanted = new Set(members.map((m) => lower(m.email)));

    for (const member of members) {
        await recordMembership({
            tables,
            email: member.email,
            slug,
            role: member.role,
            missionaryDisplayName,
            lastPostAt,
            now
        });
    }

    // Cross-partition scan. Acceptable only because this is a repair path run
    // for one slug at a time, never on a request.
    const all = await tables.listEntities(TABLES.memberships);
    for (const row of all) {
        if (row.rowKey === slug && !wanted.has(row.partitionKey)) {
            await tables.deleteEntity(TABLES.memberships, row.partitionKey, slug);
        }
    }
}
