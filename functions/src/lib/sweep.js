// Clearing out the counting rows nobody reads any more.
//
// `withinDailyCap` writes one row per accepted letter into `arrivals` and
// counts rows in the partition to decide whether an archive has taken too
// many today. The partition key carries the date, so yesterday's rows are
// never counted again -- they are not wrong, they are simply finished. Nothing
// removed them, so the table grows by one row per letter for as long as the
// service runs.
//
// This is not a correctness problem and it never becomes one. It is a hundred
// rows per mission, forever, in a store that charges by the row. The reason to
// write the sweep anyway is that "grows without bound, but slowly" is how
// every storage surprise starts, and the alternative to a job is remembering.
//
// **The retention window is for reading, not for counting.** Nothing needs a
// row past midnight, so the honest cutoff is one day. Thirty is chosen to
// match the `inbox/` lifecycle rule, so that for any raw message still on
// disk there is a record of the day it landed and what else landed with it --
// which is what a question like "did the cap fire, or did the letters never
// arrive" actually needs.

import { TABLES } from './tables.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETAIN_DAYS = 30;

// The date half of `{slug}:{yyyy-mm-dd}`. Anchored and exact, because the slug
// in front of it may contain anything a local-part may contain, colons
// included -- so the date is read from the end rather than by splitting.
const DATED_PARTITION = /:(\d{4}-\d{2}-\d{2})$/;

const dayOf = (at) => at.toISOString().slice(0, 10);

/**
 * Delete arrival rows older than the retention window.
 *
 * **Every ambiguity keeps the row.** A partition key that does not end in a
 * date is not something this job understands, and deleting rows it cannot
 * explain would make a future change to the key format silently destructive.
 * The cost of keeping one is a few bytes.
 *
 * **Safe to run twice, and safe to interrupt.** Each row is deleted on its
 * own and `deleteEntity` treats a missing row as success, so a run that dies
 * halfway leaves the rest for tomorrow. There is no ordering to get wrong,
 * because no row depends on another.
 *
 * **A failed delete is logged and the sweep continues.** One unreadable row
 * should not leave the other ten thousand in place; the job's whole value is
 * that it finishes without supervision.
 *
 * @param {object} input
 * @param {object} input.tables
 * @param {function} [input.now]
 * @param {number} [input.retainDays]
 * @param {boolean} [input.dryRun] report what would go, delete nothing
 * @param {object} [input.log]
 * @returns {Promise<{scanned: number, deleted: number, kept: number, failed: number, oldest: string|null}>}
 */
export async function sweepArrivals({
    tables,
    now = () => new Date(),
    retainDays = RETAIN_DAYS,
    dryRun = false,
    log = console
}) {
    const empty = { scanned: 0, deleted: 0, kept: 0, failed: 0, oldest: null };
    if (!tables) return empty;

    const cutoff = dayOf(new Date(now().getTime() - retainDays * DAY_MS));

    let rows;
    try {
        rows = await tables.listEntities(TABLES.arrivals);
    } catch (error) {
        // Nothing is broken by not sweeping, so this reports and stops rather
        // than throwing into the timer host and being retried.
        log.error?.('sweep: could not read the arrivals table', { message: error?.message });
        return empty;
    }

    const result = { ...empty, scanned: rows.length };

    for (const row of rows) {
        const match = DATED_PARTITION.exec(String(row.partitionKey ?? ''));
        const day = match?.[1];

        // String comparison, not date arithmetic: both sides are ISO days, so
        // this is the same ordering with none of the timezone questions.
        if (!day || day >= cutoff) {
            result.kept += 1;
            continue;
        }

        if (!result.oldest || day < result.oldest) result.oldest = day;
        if (dryRun) {
            result.deleted += 1;
            continue;
        }

        try {
            await tables.deleteEntity(TABLES.arrivals, row.partitionKey, row.rowKey);
            result.deleted += 1;
        } catch (error) {
            result.failed += 1;
            log.error?.('sweep: could not delete an arrival row', {
                partitionKey: row.partitionKey,
                message: error?.message
            });
        }
    }

    return result;
}
