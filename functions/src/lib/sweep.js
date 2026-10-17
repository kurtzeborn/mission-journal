// Clearing out completed operational rows and normalizing old visit rows.
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
// The former `visits` shape also partitioned by day. It has been replaced by
// one latest-access row per archive and person, so this job migrates the newest
// legacy day and removes every obsolete daily row. Keeping the migration here
// makes a delayed host or rollback self-cleaning without a manual production
// script.

import { TABLES } from './tables.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETAIN_DAYS = 30;

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

/**
 * Migrate the latest legacy day for each archive/person, then remove all
 * legacy rows.
 *
 * `insertEntity` is the concurrency guard. A current visit may create the new
 * row after this scan; if it wins, migration receives false rather than
 * overwriting that newer timestamp with an old midnight.
 */
export const sweepVisits = ({
    tables,
    dryRun = false,
    log = console
}) => migrateVisits({ tables, dryRun, log });

async function migrateVisits({ tables, dryRun, log }) {
    const empty = { scanned: 0, deleted: 0, kept: 0, failed: 0, migrated: 0, oldest: null };
    if (!tables) return empty;

    let rows;
    try {
        rows = await tables.listEntities(TABLES.visits);
    } catch (error) {
        log.error?.('sweep: could not read the visits table', { message: error?.message });
        return empty;
    }

    const result = { ...empty, scanned: rows.length };
    const current = new Set(
        rows
            .filter((row) => row.lastAccessAt)
            .map((row) => `${row.partitionKey}\u0000${row.rowKey}`)
    );
    const legacy = new Map();

    for (const row of rows) {
        const day = DAY_PARTITION.exec(String(row.partitionKey ?? ''))?.[1];
        if (!day) {
            result.kept += 1;
            continue;
        }

        const key = String(row.rowKey ?? '');
        const bar = key.indexOf('|');
        if (bar < 1 || bar === key.length - 1) {
            result.kept += 1;
            continue;
        }

        const slug = row.slug ?? key.slice(0, bar);
        const who = key.slice(bar + 1);
        const id = `${slug}\u0000${who}`;
        const group = legacy.get(id) ?? { slug, who, day, rows: [] };
        if (group.day < day) group.day = day;
        group.rows.push(row);
        legacy.set(id, group);

        if (!result.oldest || day < result.oldest) result.oldest = day;
    }

    for (const [id, visit] of legacy) {
        let targetReady = current.has(id);
        if (dryRun) {
            if (!targetReady) result.migrated += 1;
            targetReady = true;
        } else if (!targetReady) {
            try {
                targetReady =
                    (await tables.insertEntity(TABLES.visits, {
                        partitionKey: visit.slug,
                        rowKey: visit.who,
                        lastAccessAt: `${visit.day}T00:00:00.000Z`
                    })) !== false;
                if (targetReady) result.migrated += 1;
                else targetReady = true; // A concurrent current visit won the insert.
            } catch (error) {
                result.failed += 1;
                log.error?.('sweep: could not migrate a legacy visits row', {
                    slug: visit.slug,
                    message: error?.message
                });
            }
        }

        if (!targetReady) {
            result.kept += visit.rows.length;
            continue;
        }

        for (const row of visit.rows) {
            if (dryRun) {
                result.deleted += 1;
                continue;
            }

            try {
                await tables.deleteEntity(TABLES.visits, row.partitionKey, row.rowKey);
                result.deleted += 1;
            } catch (error) {
                result.failed += 1;
                log.error?.('sweep: could not delete a legacy visits row', {
                    partitionKey: row.partitionKey,
                    message: error?.message
                });
            }
        }
    }

    return result;
}
