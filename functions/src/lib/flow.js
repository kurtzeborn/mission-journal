// Is mail still arriving, and where is it going?
//
// This is the one question about this service that nothing else can answer.
// Every other view is scoped to an archive somebody belongs to, which is the
// whole design -- and it means that the failure mode with the longest fuse in
// the system is also the one nobody is positioned to notice. Ingest stopping
// is silent by construction: no letter arrives, so no letter is missing from
// any page, so no owner has anything to report. The first evidence would be a
// family asking where last month went.
//
// So this spans every slug, and therefore can never be an owner-facing page.
// It is assembled from indexes that already exist rather than from a new
// record kept for the purpose: `sites` is written by ingest on every letter,
// the pending manifests are written by the hold path, and the deletions table
// is written when an archive is deleted. Nothing here is authoritative about
// anything, so a wrong answer on this page is a bug in a report rather than a
// bug in the service.
//
// **The two dates are different questions and both are shown.** `lastPostAt`
// is the date the newest letter carries; `lastReceivedAt` is when it landed
// here. See sites.js. The gap between them is the most informative number on
// the page -- an archive whose newest letter is from 2019 and whose last
// arrival was last night is a family working through a backlog, which is a
// completely different situation from one that has gone quiet, and the two are
// indistinguishable on either column alone.
//
// **Rows written before `lastReceivedAt` existed have none, and it stays
// blank.** Copying `lastPostAt` across would have made the two columns agree
// by construction on exactly the archives with the longest history, which is
// where the gap is most likely to be real. A blank that fills itself in on the
// next letter is the honest version.

import { TABLES } from './tables.js';
import { DELETION_RECORD } from './deletion.js';
import { allSiteActivity } from './sites.js';

// What an archive is doing, in one word, chosen in this order.
export const STATE = {
    // Letters are being held for a slug nobody has claimed. There is no ACL,
    // nothing renders, and the letters expire on the date shown.
    pending: 'pending',
    // Deleted and inside the thirty days. Ranked above `live` because a
    // deleted archive still holding a site row looks exactly like a working
    // one, and this page is where somebody goes to be told otherwise.
    deleted: 'deleted',
    live: 'live'
};

const latest = (...dates) => dates.filter(Boolean).sort().at(-1) ?? '';

// What a row sorts on, and where the headline date is taken from. Falls back
// to the letter's own date only for rows written before arrivals were
// recorded, so an archive with real history does not sink below one that has
// never received anything.
const rank = (archive) => archive.lastReceivedAt || archive.lastPostAt || '';

/**
 * Every archive in the service and when it last heard from anybody.
 *
 * Three reads, all of them small: one table scan of `sites` (one row per
 * archive), one table scan of `deletions` (ordinarily empty), and one listing
 * of the `pending` container. It is deliberately not paged or filtered --
 * partial answers are what make a monitoring page untrustworthy, and the whole
 * point of looking is to see whether something is missing.
 *
 * @returns {Promise<{lastReceivedAt: string, archives: Array<object>}>}
 */
export async function serviceFlow({ store, tables }) {
    const rows = await allSiteActivity({ tables });

    const deletions = (await tables.listEntities(TABLES.deletions)).filter(
        (row) => row.rowKey === DELETION_RECORD
    );
    const deleted = new Map(deletions.map((row) => [row.partitionKey, row]));

    const held = await pendingBySlug({ store });

    const archives = [];
    const seen = new Set();

    for (const row of rows) {
        seen.add(row.slug);
        const pending = held.get(row.slug);

        archives.push({
            slug: row.slug,
            name: row.missionaryDisplayName ?? '',
            state: deleted.has(row.slug) ? STATE.deleted : STATE.live,
            lastPostAt: row.lastPostAt,
            lastReceivedAt: row.lastReceivedAt,
            // Nonzero against a live archive is an anomaly rather than a
            // status: promotion writes the letter into `raw/` and only then
            // deletes the held copy, so anything still sitting here is a
            // promotion that failed partway and left the only copy of somebody's
            // mail in a container nothing reads. It is worth a column of its
            // own precisely because it is ordinarily always zero.
            held: pending?.letters ?? 0,
            expiresAt: ''
        });
    }

    // Slugs with letters and no site row at all: the ordinary pending case,
    // and the only rows here that are about a family nobody has met yet.
    for (const [slug, pending] of held) {
        if (seen.has(slug)) continue;

        archives.push({
            slug,
            name: '',
            state: STATE.pending,
            lastPostAt: '',
            lastReceivedAt: pending.lastMessageAt,
            held: pending.letters,
            // The date the letters are destroyed if nobody claims them, which
            // is the only deadline in this service that runs against somebody
            // who has never been told it exists.
            expiresAt: pending.expiresAt
        });
    }

    // Most recent first. The obvious alternative -- longest silent first --
    // sounds like the right way round for a monitoring page and is not: a
    // missionary who came home is silent forever and legitimately so, and
    // within a year the top of that list would be nothing but finished
    // archives with no way to tell them from a broken one. Sorted this way the
    // first row answers the question the page exists for, which is when this
    // service last received anything at all.
    archives.sort((a, b) => rank(b).localeCompare(rank(a)));

    return { lastReceivedAt: latest(...archives.map(rank)), archives };
}

/**
 * The `pending` container, read the way purge.js reads it.
 *
 * The letters are counted from the `.eml` blobs rather than taken from the
 * manifest's `messageCount`, because that field counts everything ever held
 * and promotion deletes the blobs without decrementing it. A claimed archive
 * would otherwise report a dozen letters stuck in limbo forever.
 *
 * A manifest that will not parse is skipped rather than guessed at, and the
 * slug still appears if it has letters -- an unreadable manifest is exactly
 * the sort of thing this page should not hide.
 */
async function pendingBySlug({ store }) {
    const names = await store.listBlobs('pending', '');
    const found = new Map();

    const record = (slug) => {
        if (!found.has(slug)) {
            found.set(slug, { letters: 0, lastMessageAt: '', expiresAt: '' });
        }
        return found.get(slug);
    };

    for (const name of names) {
        if (!name.endsWith('.eml')) continue;
        const slug = name.slice(0, name.indexOf('/'));
        if (slug) record(slug).letters += 1;
    }

    for (const name of names) {
        if (!name.endsWith('/claim.json')) continue;
        const slug = name.slice(0, -'/claim.json'.length);

        let manifest;
        try {
            const blob = await store.readBlob('pending', name);
            if (!blob) continue;
            manifest = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
        } catch {
            continue;
        }

        // A claimed manifest is left behind by promotion and its dates froze
        // at the claim, so they are not carried. The letter count above is
        // still real, and on a claimed site a nonzero one is the whole point.
        if (manifest.claimedAt) continue;

        const entry = record(slug);
        entry.lastMessageAt = manifest.lastMessageAt ?? '';
        entry.expiresAt = manifest.expiresAt ?? '';
    }

    return found;
}
