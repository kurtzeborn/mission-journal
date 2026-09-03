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
//
// `visits` has the same shape and the same problem, and one difference: there
// the window *is* for reading, because the thirty-day figure on the operator
// page is computed from these rows. Its retention has to clear that window
// rather than merely reach it.

import { TABLES } from './tables.js';
import { ACTIVE_DAYS } from './visits.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETAIN_DAYS = 30;

// Longer than the thirty days `activeReaders` looks back over, because a sweep
// that ran an hour early would otherwise take the far end of its own window.
export const VISIT_RETAIN_DAYS = ACTIVE_DAYS + 10;

// The date half of `{slug}:{yyyy-mm-dd}`. Anchored and exact, because the slug
// in front of it may contain anything a local-part may contain, colons
// included -- so the date is read from the end rather than by splitting.
const DATED_PARTITION = /:(\d{4}-\d{2}-\d{2})$/;

// `visits` partitions on the day alone, so the whole key is the date.
const DAY_PARTITION = /^(\d{4}-\d{2}-\d{2})$/;

const dayOf = (at) => at.toISOString().slice(0, 10);

/**
 * Delete rows from a day-partitioned table once they are past the window.
 *
 * **Every ambiguity keeps the row.** A partition key that does not match is
 * not something this job understands, and deleting rows it cannot explain
 * would make a future change to the key format silently destructive. The cost
 * of keeping one is a few bytes.
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
 * @returns {Promise<{scanned: number, deleted: number, kept: number, failed: number, oldest: string|null}>}
 */
async function sweepDated({ tables, table, pattern, now, retainDays, dryRun, log }) {
    const empty = { scanned: 0, deleted: 0, kept: 0, failed: 0, oldest: null };
    if (!tables) return empty;

    const cutoff = dayOf(new Date(now().getTime() - retainDays * DAY_MS));

    let rows;
    try {
        rows = await tables.listEntities(table);
    } catch (error) {
        // Nothing is broken by not sweeping, so this reports and stops rather
        // than throwing into the timer host and being retried.
        log.error?.(`sweep: could not read the ${table} table`, { message: error?.message });
        return empty;
    }

    const result = { ...empty, scanned: rows.length };

    for (const row of rows) {
        const match = pattern.exec(String(row.partitionKey ?? ''));
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
            await tables.deleteEntity(table, row.partitionKey, row.rowKey);
            result.deleted += 1;
        } catch (error) {
            result.failed += 1;
            log.error?.(`sweep: could not delete a ${table} row`, {
                partitionKey: row.partitionKey,
                message: error?.message
            });
        }
    }

    return result;
}

/** Arrival rows older than the retention window. */
export const sweepArrivals = ({
    tables,
    now = () => new Date(),
    retainDays = RETAIN_DAYS,
    dryRun = false,
    log = console
}) =>
    sweepDated({
        tables,
        table: TABLES.arrivals,
        pattern: DATED_PARTITION,
        now,
        retainDays,
        dryRun,
        log
    });

/** Visit rows from before the window anybody reports on. */
export const sweepVisits = ({
    tables,
    now = () => new Date(),
    retainDays = VISIT_RETAIN_DAYS,
    dryRun = false,
    log = console
}) =>
    sweepDated({
        tables,
        table: TABLES.visits,
        pattern: DAY_PARTITION,
        now,
        retainDays,
        dryRun,
        log
    });
