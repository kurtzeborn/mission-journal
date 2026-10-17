// Who most recently read an archive, and when.
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
// ingest cap, to answer a question worth two numbers. One row per person and
// archive answers it with storage we already pay for and code that can
// be tested without a cloud.
//
//   `visits`  PartitionKey = slug, RowKey = sha256(address)
//             lastAccessAt = ISO timestamp
//
// **Upsert is what makes it cheap.** Somebody refreshing the page forty times
// updates the same row forty times and it stays one row. The write needs no
// read, and the People page can list one archive partition rather than scan
// every visit in the service.
//
// **The hash is a safe key, not anonymity.** Email addresses may contain
// characters Azure Table Storage forbids in row keys. SHA-256 turns every
// address into the same fixed hexadecimal shape and keeps addresses from being
// casually exposed in table listings. Anyone who already knows an address can
// calculate its key; this is pseudonymization, not an access control.
//
// Rows written before this shape used the UTC day as the partition and
// `{slug}|{hash}` as the row key. Reports understand both during the transition,
// and the daily sweep migrates the newest legacy day before deleting those
// obsolete rows.

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
 * Hashed because an address may legally contain characters Azure forbids in a
 * row key. This also avoids casual disclosure in listings, but a known address
 * can be matched to its hash and no stronger privacy claim is made.
 */
export const visitorKey = (email) =>
    createHash('sha256')
        .update(String(email ?? '')
            .trim()
            .toLowerCase(), 'utf8')
        .digest('hex');

/**
 * Note that this person looked at this archive now.
 *
 * **Never throws, and never fails a read.** This is an activity record attached to the
 * one request in the service that matters most; a family being unable to open
 * their letters because a statistics table was briefly unavailable would be an
 * absurd trade. Anything that goes wrong is logged and swallowed.
 *
 * Awaited by the caller rather than left running, because work outstanding
 * when a Function returns its response is not guaranteed to finish. It is one
 * merge-upsert into the archive partition, which is the cheapest write the
 * table service does.
 */
export async function recordVisit({ tables, slug, email, now = () => new Date(), log }) {
    if (!tables || !slug || !email) return false;

    try {
        await tables.upsertEntity(TABLES.visits, {
            partitionKey: slug,
            rowKey: visitorKey(email),
            lastAccessAt: now().toISOString()
        });
        return true;
    } catch (error) {
        log?.warn?.('visits: could not record a visit', { slug, error: error?.message });
        return false;
    }
}

const visitFact = (row) => {
    const latest = String(row.lastAccessAt ?? '');
    if (latest && Number.isFinite(Date.parse(latest))) {
        return {
            slug: String(row.partitionKey ?? ''),
            who: String(row.rowKey ?? ''),
            at: latest
        };
    }

    const day = String(row.partitionKey ?? '');
    const key = String(row.rowKey ?? '');
    const bar = key.indexOf('|');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || bar < 1) return null;

    return {
        slug: row.slug ?? key.slice(0, bar),
        who: key.slice(bar + 1),
        at: `${day}T00:00:00.000Z`
    };
};

/**
 * Most recent access for the current members of one archive.
 *
 * The caller already has the ACL addresses, so it hashes those known values
 * and never asks the table to reveal an identity.
 */
export async function lastVisitsFor({ tables, slug, emails = [], log = console }) {
    const found = new Map();
    if (!tables || !slug || !emails.length) return found;

    const byKey = new Map(
        emails
            .map((email) => String(email ?? '').trim().toLowerCase())
            .filter(Boolean)
            .map((email) => [visitorKey(email), email])
    );

    let rows;
    try {
        rows = await tables.listEntities(TABLES.visits, { partitionKey: slug });
    } catch (error) {
        log?.warn?.('visits: could not read member access', { slug, error: error?.message });
        return found;
    }

    for (const row of rows) {
        const email = byKey.get(String(row.rowKey ?? ''));
        const at = String(row.lastAccessAt ?? '');
        if (email && Number.isFinite(Date.parse(at))) found.set(email, at);
    }

    return found;
}

/**
 * How many people read something today, and in the last thirty days.
 *
 * Counted per archive and across the whole service, and the two are not the
 * sum of each other: a grandmother who opened two archives this morning is two
 * rows and one person, so the service-wide figure de-duplicates and the
 * per-archive figures do not.
 *
 * One scan, because this is the service-wide report. The latest-row shape is
 * bounded by people and archives rather than by days, and legacy rows are
 * de-duplicated with their replacements during the transition.
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

    const latest = new Map();
    for (const row of rows) {
        const fact = visitFact(row);
        if (!fact?.slug || !fact.who) continue;

        const key = `${fact.slug}\u0000${fact.who}`;
        if ((latest.get(key)?.at ?? '') < fact.at) latest.set(key, fact);
    }

    const bySlug = new Map();
    const everyoneToday = new Set();
    const everyoneMonth = new Set();

    for (const { slug, who, at: visitedAt } of latest.values()) {
        const day = dayOf(new Date(visitedAt));
        // Both sides are ISO days, so this is ordinary string ordering with
        // none of the timezone questions date arithmetic would raise.
        if (day < since || day > today) continue;

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
