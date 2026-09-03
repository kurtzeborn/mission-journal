// Who read an archive, and on what day.
//
// The operator page can say how much is here. It could not say whether anybody
// is looking at it, which is the difference between an archive that is working
// and one that is merely accumulating. A family that stopped visiting is the
// thing worth knowing about, and no count of letters shows it.
//
// **This is a table, not telemetry.** The obvious route was App Insights: log
// an identity on each read and run a daily query. That needs a new log line on
// the hottest path in the service, query access granted to the Function App,
// and a timer running KQL -- three moving parts pushing against a 1 GB/day
// ingest cap, to answer a question worth two numbers. A row per person per
// archive per day answers it with storage we already pay for and code that can
// be tested without a cloud.
//
//   `visits`  PartitionKey = 'YYYY-MM-DD', RowKey = '{slug}|{hash of address}'
//
// **Upsert is what makes it cheap.** Somebody refreshing the page forty times
// writes the same row forty times and it stays one row, so the count is people
// rather than page loads without anything having to de-duplicate it later. The
// same property is why a visit can be recorded without first reading anything.
//
// **The address is hashed and the row holds nothing else.** A count is all this
// is for, and the reverse question -- which letters did this person read -- is
// one the service should not be able to answer about a family. The slug is
// stored in the clear because the per-archive number needs it and it is not a
// fact about a person.
//
// Derived, and worthless if lost: an empty table means the numbers start again
// from today, which costs a month of history and nothing else.

import { createHash } from 'node:crypto';
import { TABLES } from './tables.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The window behind "this month". Thirty days rather than a calendar month, so
// the number means the same thing on the first of March as on the thirty-first.
export const ACTIVE_DAYS = 30;

export const dayOf = (at) => at.toISOString().slice(0, 10);

/**
 * The visitor half of the row key.
 *
 * Hashed for the same mechanical reason as `optOutKey` -- an address may
 * legally contain characters a row key may not -- and here for a second reason
 * as well: nothing needs to read this table back to an address, so it should
 * not be able to.
 */
export const visitorKey = (email) =>
    createHash('sha256')
        .update(String(email ?? '')
            .trim()
            .toLowerCase(), 'utf8')
        .digest('hex');

/**
 * Note that this person looked at this archive today.
 *
 * **Never throws, and never fails a read.** This is a counter attached to the
 * one request in the service that matters most; a family being unable to open
 * their letters because a statistics table was briefly unavailable would be an
 * absurd trade. Anything that goes wrong is logged and swallowed.
 *
 * Awaited by the caller rather than left running, because work outstanding
 * when a Function returns its response is not guaranteed to finish. It is one
 * upsert into a partition keyed by today, which is the cheapest write the
 * table service does.
 */
export async function recordVisit({ tables, slug, email, now = () => new Date(), log }) {
    if (!tables || !slug || !email) return false;

    try {
        await tables.upsertEntity(TABLES.visits, {
            partitionKey: dayOf(now()),
            rowKey: `${slug}|${visitorKey(email)}`,
            slug
        });
        return true;
    } catch (error) {
        log?.warn?.('visits: could not record a visit', { slug, error: error?.message });
        return false;
    }
}

/**
 * How many people read something today, and in the last thirty days.
 *
 * Counted per archive and across the whole service, and the two are not the
 * sum of each other: a grandmother who opened two archives this morning is two
 * rows and one person, so the service-wide figure de-duplicates and the
 * per-archive figures do not.
 *
 * One scan, because retention keeps the table to roughly a month of rows and
 * thirty partition queries to avoid reading a few thousand rows is a worse
 * trade than the scan. Failure is reported as zeroes for the same reason as
 * everything else on the stats route: it is a report.
 *
 * @returns {Promise<{totals: {daily: number, monthly: number},
 *   bySlug: Map<string, {daily: number, monthly: number}>}>}
 */
export async function activeReaders({ tables, now = () => new Date(), days = ACTIVE_DAYS, log }) {
    const empty = { totals: { daily: 0, monthly: 0 }, bySlug: new Map() };
    if (!tables) return empty;

    const at = now();
    const today = dayOf(at);
    const since = dayOf(new Date(at.getTime() - (days - 1) * DAY_MS));

    let rows;
    try {
        rows = await tables.listEntities(TABLES.visits);
    } catch (error) {
        log?.warn?.('visits: could not read the visits table', { error: error?.message });
        return empty;
    }

    const bySlug = new Map();
    const everyoneToday = new Set();
    const everyoneMonth = new Set();

    for (const row of rows) {
        const day = String(row.partitionKey ?? '');
        // Both sides are ISO days, so this is ordinary string ordering with
        // none of the timezone questions date arithmetic would raise.
        if (day < since || day > today) continue;

        const key = String(row.rowKey ?? '');
        const bar = key.indexOf('|');
        if (bar < 1) continue;

        const slug = row.slug ?? key.slice(0, bar);
        const who = key.slice(bar + 1);

        if (!bySlug.has(slug)) bySlug.set(slug, { daily: new Set(), monthly: new Set() });
        const seen = bySlug.get(slug);

        seen.monthly.add(who);
        everyoneMonth.add(who);
        if (day === today) {
            seen.daily.add(who);
            everyoneToday.add(who);
        }
    }

    return {
        totals: { daily: everyoneToday.size, monthly: everyoneMonth.size },
        bySlug: new Map(
            [...bySlug].map(([slug, seen]) => [
                slug,
                { daily: seen.daily.size, monthly: seen.monthly.size }
            ])
        )
    };
}
