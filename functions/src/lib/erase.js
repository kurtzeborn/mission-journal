// Day thirty: making "permanently erased" true.
//
// Named `erase` rather than `purge` because purge.js is already taken, by the
// unrelated business of letting go of pending sites nobody ever claimed. The
// two are worth keeping apart in the head as well as on disk: that one ends a
// promise we made without being asked, this one keeps a promise an owner asked
// us to make.
//
// Everything here is written on the assumption it will be read again by
// somebody trying to work out where a family's letters went, so the two things
// worth knowing first:
//
// **It refuses far more readily than it deletes.** Every guard below fails
// towards leaving data alone. Blobs that should have gone cost money and can be
// removed by hand; blobs that should not have gone cannot be brought back by
// anybody.
//
// **The slug is not reserved after a deletion**, which is a deliberate product
// decision and the source of the one genuinely dangerous case in this file.
// Deleting an archive does not block the name, so a letter forwarded to a
// deleted slug starts a fresh pending site exactly as the first letter for any
// archive does. If somebody then *claims* that site on day twenty, it promotes
// itself into `raw/` and `rendered/` under the same slug -- and this timer is
// still holding a thirty-day appointment to empty them. A new family's letters
// would be destroyed by a deletion they had nothing to do with, ten days after
// they arrived, with the audit trail pointing at a stranger.
//
// The guard is `acl.json`. Deletion removes it, and nothing but a claim puts
// one back, so its presence means the slug is in use again -- by somebody --
// and the purge must not run. It is the same check `restoreSite` makes, for
// the same reason.

import { TABLES } from './tables.js';
import { readAcl } from './acl.js';
import { DELETION_RECORD } from './deletion.js';

// Everything a deleted archive occupies. `inbox` is deliberately absent: it
// holds the untouched original of every message, is aged out by a lifecycle
// rule at thirty days regardless, and is not addressed by slug at all -- its
// blobs are named by ULID, so there is no prefix to aim at.
//
// `books` will belong here when Journal Publish ships. It has no container
// yet; when it gets one it must be added to this list *and* to
// `purgeContainerNames` in main.bicep, or this will fail on a permission
// rather than quietly skip it -- which is the right way round.
export const ERASED_CONTAINERS = ['raw', 'rendered', 'config', 'exports', 'pending'];

/**
 * Erase one archive, if it is still right to.
 *
 * @returns {Promise<{slug: string, outcome: string, blobs?: number, versions?: number}>}
 *   `outcome` is one of `erased`, `not-due`, `recreated`, or `gone`.
 */
export async function eraseSite({ purge, store, tables, slug, now = () => new Date(), log }) {
    const record = await tables.getEntity(TABLES.deletions, slug, DELETION_RECORD);
    if (!record) return { slug, outcome: 'gone' };

    // Compared as ISO strings, which sort correctly because both sides are UTC
    // at the same precision. Deliberately not parsed: a malformed date read as
    // a number would come out as 1970 and be due immediately, whereas a string
    // comparison against nonsense simply is not due.
    if (!(record.purgeAfter && now().toISOString() >= record.purgeAfter)) {
        return { slug, outcome: 'not-due' };
    }

    if (await readAcl(store, slug)) {
        // Loud, and it clears the record rather than trying again tomorrow:
        // the archive standing here now belongs to somebody else, and this
        // appointment will never become appropriate again.
        log?.error?.('erase: the slug is in use again, nothing was deleted', {
            slug,
            deletedAt: record.deletedAt,
            deletedBy: record.deletedBy
        });
        await tables.deleteEntity(TABLES.deletions, slug, DELETION_RECORD);
        return { slug, outcome: 'recreated' };
    }

    let blobs = 0;
    let versions = 0;

    for (const container of ERASED_CONTAINERS) {
        // Listed once, up front. Deleting while iterating a paged listing is
        // how a purge silently skips a page.
        const entries = await purge.listVersions(container, `${slug}/`);

        // Pass one: demote. A version that is still the current version of a
        // live blob refuses both of the passes below, so the base blob goes
        // first. Names rather than entries, because one blob has many versions
        // and the base blob is deleted once.
        for (const name of new Set(entries.map((entry) => entry.name))) {
            await purge.deleteBlob(container, name);
            blobs += 1;
        }

        // Passes two and three, per version. The soft delete is not a fallback
        // and not optional: without it the permanent delete returns 409.
        for (const entry of entries) {
            if (!entry.versionId) continue;
            if (!entry.deleted) {
                await purge.softDeleteVersion(container, entry.name, entry.versionId);
            }
            await purge.permanentlyDeleteVersion(container, entry.name, entry.versionId);
            versions += 1;
        }
    }

    // Last, and only once every container has come back clean. A record
    // removed before the blobs are gone leaves an archive nothing will ever
    // come back for, and that failure is silent. The opposite failure is a run
    // that repeats against blobs already gone, which the 404 handling in
    // purgestore.js makes free.
    await tables.deleteEntity(TABLES.deletions, slug, DELETION_RECORD);

    log?.warn?.('site.erased', {
        slug,
        blobs,
        versions,
        deletedAt: record.deletedAt,
        deletedBy: record.deletedBy,
        reason: record.reason ?? ''
    });

    return { slug, outcome: 'erased', blobs, versions };
}

/**
 * Everything that has come due.
 *
 * One archive's failure does not stop the rest. Abandoning the run on the
 * first error would let a single stuck slug hold every other family's deletion
 * open indefinitely, and the promise made to each of them was about their own
 * archive.
 */
export async function runDueErasures({ purge, store, tables, now = () => new Date(), log }) {
    const rows = await tables.listEntities(TABLES.deletions);
    const due = rows.filter((row) => row.rowKey === DELETION_RECORD);

    const results = [];
    for (const row of due) {
        try {
            results.push(await eraseSite({ purge, store, tables, slug: row.partitionKey, now, log }));
        } catch (error) {
            // Left in place deliberately. The record is the only thing that
            // remembers these letters are meant to go, so a failure has to
            // keep it rather than tidy it away.
            log?.error?.('erase: failed, will be retried tomorrow', {
                slug: row.partitionKey,
                message: error?.message
            });
            results.push({ slug: row.partitionKey, outcome: 'failed' });
        }
    }
    return results;
}
