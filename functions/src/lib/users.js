// What one *person* has asked us to do, as opposed to one archive.
//
// Every other index in this service is keyed on a slug, because almost every
// question here is about an archive. This one is keyed on an address, and it
// exists because a grandmother following two grandchildren is one person with
// one inbox and one opinion about how often we should write to her. Answering
// that per archive would put two near-identical emails in the same inbox on
// the same morning, and the count grows fastest for exactly the people most
// likely to find it tiresome.
//
// Three things about the shape, each of which had a cheaper wrong answer:
//
//   **No row means no mail.** The plan says the preference is asked rather
//   than assumed, and absence is the strictest possible reading of that: a
//   person who has never been asked is a person we have never been told to
//   write to. It also disposes of the `@missionary.org` case for free --
//   those addresses are created by ingest and never sign in, so they never
//   get a row, so they never get a digest. They wrote the letters.
//
//   **This is not the opt-out, and it never overrides it.** A preference is a
//   choice about which mail to receive; an opt-out is a statement about
//   receiving any. Collapsing the two would let a preferences page quietly
//   re-subscribe somebody who said stop, so the suppression check stays where
//   it is, above this, as a veto.
//
//   **`digestAt` is the end of the last cycle, not the last send.** It moves
//   whether or not mail went out, so the window is contiguous and no letter
//   can fall between two runs. Advancing it over a quiet month is safe for
//   the same reason: there was nothing in that window to miss.

import { TABLES } from './tables.js';

const ROW = 'profile';

const lower = (value) => String(value ?? '').trim().toLowerCase();

export const DIGEST = { monthly: 'monthly', weekly: 'weekly', off: 'off' };

/**
 * How long a cycle is.
 *
 * Days rather than calendar months, and the drift is deliberate. "One month
 * after January 31st" is a question with no good answer -- every language
 * runtime picks a different wrong one, and JavaScript's picks March 3rd --
 * while thirteen sends a year instead of twelve is invisible to somebody who
 * asked for mail roughly monthly. The word in the interface is what a person
 * means by it, not what a calendar means by it.
 */
export const CYCLE_DAYS = { [DIGEST.monthly]: 30, [DIGEST.weekly]: 7 };

/** Anything not offered is `off`, so a hand-edited row cannot start mail. */
export const validFrequency = (value) =>
    value === DIGEST.monthly || value === DIGEST.weekly ? value : DIGEST.off;

export async function readUser({ tables, email }) {
    const them = lower(email);
    if (!them) return null;
    return await tables.getEntity(TABLES.users, them, ROW);
}

/**
 * Record what somebody chose.
 *
 * `digestAt` is seeded on creation and left alone afterwards. Seeding it is
 * what stops a new reader's first digest being the entire back catalogue of
 * an archive somebody has been keeping for eighteen months: the window starts
 * when they answered the question, not when the mission did.
 *
 * Changing the frequency deliberately does *not* reset it. Somebody switching
 * from monthly to weekly three weeks in has been waiting three weeks, and
 * restarting their clock would make the change look like it did nothing.
 */
export async function setDigest({ tables, email, frequency, now = () => new Date() }) {
    const them = lower(email);
    if (!them) throw new Error('user: an address is required');

    const at = now().toISOString();
    const existing = await tables.getEntity(TABLES.users, them, ROW);

    await tables.upsertEntity(TABLES.users, {
        partitionKey: them,
        rowKey: ROW,
        digestFrequency: validFrequency(frequency),
        ...(existing ? {} : { createdAt: at, digestAt: at })
    });

    return validFrequency(frequency);
}

/** The cycle is over, whether or not it had anything in it. */
export async function markDigested({ tables, email, at }) {
    await tables.upsertEntity(TABLES.users, {
        partitionKey: lower(email),
        rowKey: ROW,
        digestAt: at
    });
}

/**
 * The answer given on the way in, at a claim or an invitation.
 *
 * Swallows its own failure, which is the whole reason it is a function rather
 * than a call to `setDigest`. Joining an archive is the thing that had to
 * happen; how often we write about it is a question the same person can
 * answer again on a page they are now signed in to. Letting a bad write to
 * this index turn an accepted invitation into a refusal would trade the
 * important half for the trivial one.
 */
export async function recordDigestChoice({ tables, email, frequency, now, log = console }) {
    if (frequency === undefined || frequency === null || frequency === '') return;

    try {
        await setDigest({ tables, email, frequency, now });
    } catch (error) {
        log.error?.('user: could not record a digest preference', { detail: error.message });
    }
}

/**
 * Is this row's next cycle over?
 *
 * A row with no `digestAt` is treated as due immediately rather than as
 * never: the only way to have one is to have been written by something older
 * than this field, and the alternative is an address that silently never
 * hears from us and no way to tell it from one that is working.
 */
export function digestDue({ row, now = () => new Date() }) {
    const frequency = validFrequency(row?.digestFrequency);
    if (frequency === DIGEST.off) return false;

    const since = row?.digestAt;
    if (!since) return true;

    const due = new Date(since);
    if (Number.isNaN(due.getTime())) return true;
    due.setUTCDate(due.getUTCDate() + CYCLE_DAYS[frequency]);

    return now() >= due;
}

/**
 * Everybody who has ever answered the question.
 *
 * A cross-partition scan, and the only one in the service that runs on a
 * schedule rather than as a repair. It is what this table is for: the digest
 * asks "who is due" and there is no partition key that answers it. One row
 * per person who has signed in, read once a day.
 */
export async function everyUser({ tables }) {
    const rows = await tables.listEntities(TABLES.users);
    return rows.filter((row) => row.rowKey === ROW);
}
