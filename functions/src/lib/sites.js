// What a site is called, when its mission began, and when it last saw a letter.
//
// Both of these belong to the *site*, and both were originally copied onto
// every membership row -- which meant that keeping them current required
// finding every member of a slug and writing to each one. That is a
// cross-partition operation, on the ingest path, on every post. So in
// practice neither was ever updated: the display name froze at whatever the
// claimant typed, and `lastPostAt` froze at the moment somebody joined,
// quietly turning "most recently updated" into "most recently added".
//
// One row per site fixes both. Ingest writes a single entity per post, in the
// slug's own partition, and the read side pays a point read per site the
// signed-in person actually belongs to -- one or two for a family, a handful
// for the most connected grandparent imaginable.
//
// It is a separate table rather than a reserved partition inside
// `memberships` because `rebuildMemberships` prunes by scanning for rows
// whose `rowKey` is the slug and whose partition is not on the ACL. A site
// row keyed that way would match that description exactly, and the repair
// path would delete it. Two tables cannot make that mistake.

import { TABLES } from './tables.js';

// Every site is its own partition, so the write ingest performs is a
// single-partition upsert that never contends with another site's traffic.
const ROW = 'activity';

/**
 * Record that a site has a new most-recent letter.
 *
 * Deliberately not read-modify-write. Two letters committed at once would
 * race, and the loser would write a slightly older timestamp -- which costs
 * nothing, because the only consumer is a sort order between whole archives.
 * An ETag loop here would buy correctness nobody can perceive at the price of
 * a retry on the ingest path.
 */
export async function touchSiteActivity({ tables, slug, lastPostAt }) {
    if (!slug || !lastPostAt) return;

    await tables.upsertEntity(TABLES.sites, {
        partitionKey: slug,
        rowKey: ROW,
        lastPostAt
    });
}

/**
 * Set or change the things an owner chooses about a site.
 *
 * Separate from activity so that renaming a site does not have to know when
 * its last letter arrived, and so that ingest does not have to know its name.
 *
 * `missionStartDate` is written only when it is offered, which is what lets
 * the claim flow keep calling this with a name alone. The upsert merges, so an
 * omitted column is left as it was rather than blanked -- and the owner
 * clearing the field in settings passes an empty string, which is offered and
 * therefore does overwrite. Undefined means "I have no opinion"; empty means
 * "there is no date", and the two must not collapse into each other.
 */
export async function setSiteProfile({ tables, slug, missionaryDisplayName, missionStartDate }) {
    if (!slug) return;

    await tables.upsertEntity(TABLES.sites, {
        partitionKey: slug,
        rowKey: ROW,
        missionaryDisplayName: missionaryDisplayName ?? '',
        ...(missionStartDate === undefined ? {} : { missionStartDate })
    });
}

/**
 * Look up several sites at once.
 *
 * Point reads rather than a query, because the caller already knows exactly
 * which slugs it wants and a query would scan. A missing row is not an error
 * -- a site can exist with no letters and no name yet -- so it resolves to
 * empty values and the caller falls back to the slug.
 *
 * @returns {Promise<Map<string, {lastPostAt: string, missionaryDisplayName: string,
 *   missionStartDate: string}>>}
 */
export async function sitesBySlug({ tables, slugs }) {
    const found = new Map();

    for (const slug of new Set(slugs)) {
        const row = await tables.getEntity(TABLES.sites, slug, ROW);
        found.set(slug, {
            lastPostAt: row?.lastPostAt ?? '',
            missionaryDisplayName: row?.missionaryDisplayName ?? '',
            missionStartDate: row?.missionStartDate ?? ''
        });
    }

    return found;
}

/**
 * The parts of a site row that a `posts.json` response repeats back.
 *
 * Exists so that the two places which compute a content validator -- the
 * archive response and the If-Match check on an owner's edit -- cannot drift
 * apart in what they consider a change. They must salt identically or the
 * salt becomes a source of phantom conflicts, and a rule that lives in one
 * function is a rule that cannot be half-applied.
 *
 * The separator is a NUL because neither field can contain one, which is what
 * keeps a name ending in a digit from colliding with a date.
 */
export const siteFacts = (row) =>
    `${row?.missionaryDisplayName ?? ''}\u0000${row?.missionStartDate ?? ''}`;
