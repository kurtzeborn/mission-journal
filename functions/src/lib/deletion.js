// Deleting an archive, and the thirty days before that becomes true.
//
// The promise made at the confirmation prompt is exact and worth restating,
// because everything here is shaped by it: *your letters stop being visible
// immediately and are permanently erased 30 days from now.* Both halves are
// load-bearing. A "permanent" button that is not permanent is a lie; a
// literally-instant hard delete would mean turning off the soft-delete and
// versioning that protect the one part of this service that cannot be rebuilt,
// in order to honor a misclick.
//
// **Access is revoked by deleting `acl.json`, not by setting a flag.**
//
// That choice is the reason this module is short. Every authorization in the
// service already resolves through the ACL, so removing the file refuses every
// member on every path at once -- content, photos, download, members, profile,
// posts -- without a single one of those call sites learning that deletion
// exists, and without adding a table read to the authorization hot path that
// every reader pays on every request forever.
//
// It has three further properties that a flag does not:
//
//   * **Versioning makes it the undo.** The container has versioning on, so
//     the delete is a demotion rather than a destruction, and restoring is
//     reading the previous version back. There is no second copy of the
//     membership list to keep in step with the first.
//   * **A deleted archive is indistinguishable from one that never existed.**
//     Which is what the rest of the service already promises: a signed-in
//     stranger must not be able to discover which slugs exist by asking.
//   * **Operators still get in**, because operator authority is resolved above
//     the ACL and does not consult it. That is exactly the access the restore
//     path needs, and it required no new rule.
//
// **Nothing is emailed.** Consistent with removing a single member: being told
// you have been cut out of a family's archive is a message the family should
// get to write themselves. It applies more strongly here, where the alternative
// hands any one owner a button that mails the entire extended family.
//
// **The slug is not reserved afterwards.** Deletion means "delete what is
// here", not "block this name forever". A letter forwarded to a deleted slug
// is treated as a letter for a slug we have never heard of -- which is to say
// it starts a new pending site, exactly as the first letter for any archive
// does. See the guard in purge.js for the one hazard that creates.

import { TABLES } from './tables.js';
import { readAcl } from './acl.js';
import { forgetMembership, rebuildMemberships } from './memberships.js';

export const PURGE_DAYS = 30;

// One row per deleted archive, keyed on the slug, so the timer's question --
// "what is due" -- is a single scan of a table that is empty in the ordinary
// case and holds one row per deletion in the worst.
export const DELETION_RECORD = 'record';

// Where the deleted ACL is kept so the restore path does not have to reason
// about blob versions. Versioning is the safety net underneath this; the copy
// is what makes restoring an ordinary write rather than a REST call against a
// version id.
//
// It lives beside the ACL in `config/` rather than in a container of its own,
// so the day-30 purge -- which walks `config/{slug}/` -- takes it away with
// everything else and cannot leave a family's member list behind as the one
// surviving artifact of an archive that is supposed to be gone.
const gravePath = (slug) => `${slug}/deleted-acl.json`;

/**
 * Delete an archive.
 *
 * Order matters, and this order is chosen so that every partial failure leaves
 * a state a human can understand:
 *
 *   1. Copy the ACL aside, so the restore path has something to read.
 *   2. Write the deletion record, so the purge timer knows to come back.
 *   3. Delete `acl.json` -- the moment access actually stops.
 *   4. Delete the membership rows, so the archive leaves everyone's list.
 *
 * A failure before (3) is a no-op that the owner sees as an error and can
 * retry. A failure after it has already revoked access, which is the outcome
 * they asked for, and leaves the rest recoverable. The reverse order could
 * revoke access with no record of why and nothing to restore from, which is
 * the one state nobody could reason their way out of.
 *
 * @param {string} [reason] recorded, and required of operators rather than of
 *   owners: an owner deleting their own family's archive owes no explanation,
 *   and it is the only part of an operator's action that cannot be
 *   reconstructed from the data afterwards.
 * @returns {Promise<{error: string}|{slug: string, purgeAfter: string, members: number}>}
 */
export async function deleteSite({
    store,
    tables,
    slug,
    by,
    reason = '',
    now = () => new Date(),
    log
}) {
    const acl = await readAcl(store, slug);
    if (!acl) return { error: 'no such site' };

    const at = now();
    const purgeAfter = new Date(at.getTime() + PURGE_DAYS * 86400_000);

    // Copied byte for byte rather than re-serialised from what readAcl
    // returned, so that restoring puts back exactly the file that was taken
    // away. readAcl deliberately yields only the members array, and acl.json
    // carries more than that -- rebuilding the file from its output would
    // quietly drop the rest. That is the same two-way format drift between the
    // real file and a rebuilt one that memory-store.js still carries a comment
    // about, and it survived a green suite the last time.
    const original = await store.readBlob('config', `${slug}/acl.json`);

    await store.writeBlob('config', gravePath(slug), Buffer.from(original.bytes), {
        contentType: 'application/json'
    });

    await tables.upsertEntity(TABLES.deletions, {
        partitionKey: slug,
        rowKey: DELETION_RECORD,
        deletedAt: at.toISOString(),
        deletedBy: by,
        reason,
        purgeAfter: purgeAfter.toISOString()
    });

    await store.deleteBlob('config', `${slug}/acl.json`);

    // After the ACL, deliberately. These rows grant nothing -- they answer
    // "which archives does this address belong to" and the ACL is checked
    // again on arrival -- so leaving them a moment longer costs a redirect
    // into a refusal, while removing them first would leave an archive that
    // is still readable and no longer reachable.
    for (const member of acl) {
        await forgetMembership({ tables, email: member.email, slug });
    }

    log?.warn?.('site.deleted', {
        slug,
        by,
        reason,
        members: acl.length,
        purgeAfter: purgeAfter.toISOString()
    });

    return { slug, purgeAfter: purgeAfter.toISOString(), members: acl.length };
}

/**
 * Undo a deletion, up to the moment the purge runs.
 *
 * Operator-only, and there is deliberately no owner-facing control. The
 * confirmation prompt says the letters are erased in thirty days and says
 * nothing about taking it back, because a prompt that offers an undo in the
 * same breath is not a confirmation -- and the thing being confirmed here is
 * irreversible destruction of the only copy of a family's mail.
 *
 * @returns {Promise<{error: string}|{slug: string, members: number}>}
 */
export async function restoreSite({ store, tables, slug, by, now = () => new Date(), log }) {
    const record = await tables.getEntity(TABLES.deletions, slug, DELETION_RECORD);
    if (!record) return { error: 'not deleted' };

    const grave = await store.readBlob('config', gravePath(slug));
    if (!grave) return { error: 'nothing to restore' };

    // Refused rather than merged. An archive that exists again has been
    // recreated by somebody else's letters since -- see purge.js -- and
    // writing a dead family's member list over a live one would hand strangers
    // access to a stranger's mail. This is the only failure in this module
    // that is worth being loud about.
    if (await readAcl(store, slug)) {
        log?.error?.('site.restore refused: the slug is in use again', { slug, by });
        return { error: 'slug in use' };
    }

    const acl = JSON.parse(Buffer.from(grave.bytes).toString('utf8'));
    const members = acl?.members ?? [];

    // The grave is the original file, so this is a copy back rather than a
    // re-render. See the note where it was written.
    await store.writeBlob('config', `${slug}/acl.json`, Buffer.from(grave.bytes), {
        contentType: 'application/json'
    });

    // Rebuilt from the ACL that was just restored rather than replayed from a
    // second record, for the reason memberships.js exists: the ACL is the
    // authority and the rows are derived from it. This is the same repair path
    // drift recovery uses.
    await rebuildMemberships({ tables, slug, acl, now });

    await tables.deleteEntity(TABLES.deletions, slug, DELETION_RECORD);
    await store.deleteBlob('config', gravePath(slug));

    log?.warn?.('site.restored', { slug, by, members: members.length });

    return { slug, members: members.length };
}

/**
 * Every archive awaiting purge, soonest first.
 *
 * A full scan, which is right for a table whose ordinary size is zero and
 * whose worst case is one row per deleted archive in the service's history
 * minus thirty days. The only callers are the operator's list and the timer.
 */
export async function pendingDeletions({ tables }) {
    const rows = await tables.listEntities(TABLES.deletions);
    return rows
        .filter((row) => row.rowKey === DELETION_RECORD)
        .map((row) => ({
            slug: row.partitionKey,
            deletedAt: row.deletedAt ?? '',
            deletedBy: row.deletedBy ?? '',
            reason: row.reason ?? '',
            purgeAfter: row.purgeAfter ?? ''
        }))
        .sort((a, b) => (a.purgeAfter < b.purgeAfter ? -1 : 1));
}

export const deletedAclPath = gravePath;

/**
 * The pending deletion for one archive, or null.
 *
 * A point read rather than a filter over `pendingDeletions`, because the
 * caller is the archive page and the scan above is sized for a table nobody
 * reads on a hot path.
 *
 * **Only ever called for an operator**, which is what makes it affordable. An
 * archive that has been deleted has no `acl.json`, so the only way to be
 * looking at one is to hold the role by way of `OPERATOR_EMAILS` -- every
 * ordinary reader has already been refused by the time this would be reached,
 * and pays nothing for it.
 *
 * It exists because operator access to a deleted archive is correct and its
 * silence was not: the page rendered a family's letters in full, with the
 * ordinary operator banner and nothing at all to say the archive was deleted
 * or that it would be destroyed on a date. The one person who can undo the
 * deletion was the one person not being told it had happened.
 */
export async function deletionOf({ tables, slug }) {
    const row = await tables.getEntity(TABLES.deletions, slug, DELETION_RECORD);
    if (!row) return null;

    return {
        deletedAt: row.deletedAt ?? '',
        deletedBy: row.deletedBy ?? '',
        purgeAfter: row.purgeAfter ?? ''
    };
}
