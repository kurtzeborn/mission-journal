// How many letters one archive may take in a day.
//
// The failure this exists for is not abuse, it is an accident: a forwarding
// rule that points a mailbox at `post@` while a copy of everything sent there
// comes back, or two mail accounts each set to forward to the other. Nobody
// notices, because the whole design is that letters arrive without anybody
// doing anything. What is left behind is thousands of posts, thousands of
// rendered photo variants, and a storage bill, in an archive whose owner is
// now looking at a page they cannot use.
//
// **The cap is deliberately far above the largest honest day.** A two-year
// mission is about a hundred weekly letters, and forwarding the whole lot in
// one sitting is a scenario the pipeline was explicitly built to survive --
// it is what a family does on the day they find out this exists. Two hundred
// clears that with room to spare while still stopping a loop two orders of
// magnitude short of "thousands".
//
// **A refused letter is not a destroyed one.** The raw message stays in
// `inbox/` under its 30-day lifecycle rule, so anything caught by a cap that
// turns out to be wrong can be replayed by re-enqueuing the ULID. That is what
// makes a hard refusal defensible here when almost nothing else in this
// pipeline is allowed to drop a letter.

import { TABLES } from './tables.js';

export const DAILY_CAP = 200;

// UTC, matching the invitation cap, and for the same reason: the alternative
// is picking a timezone for a service whose senders are spread across every
// one of them, and a day boundary that moves is worse than one in the wrong
// place.
const dayOf = (at) => at.toISOString().slice(0, 10);

/**
 * Record an arrival and say whether it is within the day's allowance.
 *
 * **Counts rows rather than incrementing a number, which is the whole design.**
 * The obvious implementation -- read a counter, add one, write it back -- loses
 * increments whenever two messages are in flight, and the queue host runs a
 * batch at a time. Under exactly the sustained flood this exists to catch, the
 * counter would advance far more slowly than the mail arrives and the cap
 * would fire late or not at all. A row per message cannot undercount: every
 * accepted letter leaves one behind.
 *
 * It can still *overshoot*, by as many messages as the host has in flight when
 * the limit is crossed. That is the harmless direction -- a handful of letters
 * past two hundred -- and closing it needs an atomic counter the table wrapper
 * does not expose.
 *
 * **Fails open**, and logs when it does. A table that is refusing reads is not
 * evidence of a loop, and this is the one guard in the pipeline whose
 * malfunction would otherwise reject real mail. The bias everywhere else here
 * is that a letter published in error is visible and reversible while a letter
 * silently discarded is gone; a cost guard is not a good enough reason to
 * invert it.
 *
 * @returns {Promise<{ok: boolean, count: number}>}
 */
export async function withinDailyCap({ tables, slug, ulid, now = () => new Date(), cap = DAILY_CAP, log }) {
    if (!tables) return { ok: true, count: 0 };

    const partitionKey = `${slug}:${dayOf(now())}`;

    let seen;
    try {
        seen = await tables.listEntities(TABLES.arrivals, { partitionKey });
    } catch (error) {
        log?.error?.('ingest: could not check the daily cap', { slug, message: error?.message });
        return { ok: true, count: 0 };
    }

    if (seen.length >= cap) {
        // Error level, and a message of its own, because this is the line an
        // alert rule watches. It is also the only interesting thing in the
        // logs on the thousandth message of a loop -- everything else at that
        // point is one rejection repeated.
        log?.error?.('ingest: daily cap reached', { slug, cap, count: seen.length, ulid });
        return { ok: false, count: seen.length };
    }

    try {
        // A redelivery of a message already counted returns false and is not
        // counted twice. It is also not refused: the queue retrying is our
        // problem, not the sender's.
        await tables.insertEntity(TABLES.arrivals, { partitionKey, rowKey: String(ulid) });
    } catch (error) {
        log?.error?.('ingest: could not record an arrival', { slug, message: error?.message });
    }

    return { ok: true, count: seen.length + 1 };
}

// ---------------------------------------------------------------------------
// How many letters one archive may hold, ever.
//
// The cap above limits the rate and not the total, which are different
// guarantees: two hundred a day sustained is seventy thousand letters a year,
// and the file every reader downloads on every visit is one JSON document
// holding all of them. Nothing pages it, deliberately -- the client-side
// search rests on having the whole archive in hand -- so the assumption that
// an archive is small is load-bearing and until now was written down nowhere.
//
// A two-year mission is about a hundred and four p-days, so a hundred and four
// weekly letters is the theoretical ceiling for an elder and rather fewer for a
// sister serving eighteen months. The one complete archive on the service ran
// to forty-four. A hundred and fifty clears the theoretical maximum with room
// for the things that are not weekly letters -- a mission president's note, a
// transfer announcement, a re-forward an edit stopped dedupe from matching.
//
// **This one does not reset tomorrow.** The daily cap forgives itself at
// midnight; reaching this one is permanent until somebody deletes a letter.
// The replay path is the same -- the raw message keeps its thirty days in
// `inbox/` and a refused letter can be re-enqueued by ULID -- but the window
// is the only warning there is, so the refusal logs at error level.
// ---------------------------------------------------------------------------

export const ARCHIVE_CAP = 150;
