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
//   **No row means no mail.** Nothing on the way in writes one -- not a
//   claim, not an invitation, not ingest -- so the only thing that can is
//   somebody opening the settings page and asking to hear from us. That is
//   the strictest possible reading of asked rather than assumed, and it
//   disposes of the `@missionary.org` case for free: those addresses are
//   created by ingest and never sign in, so they never get a row, so they
//   never get a digest. They wrote the letters.
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

/** Anything not offered is `off`, so a hand-edited row cannot start mail. */
export const validFrequency = (value) =>
    value === DIGEST.monthly || value === DIGEST.weekly ? value : DIGEST.off;

export const validDigestWeekday = (value) => Number.isInteger(value) && value >= 0 && value <= 6;
export const validDigestWeek = (value) => Number.isInteger(value) && value >= 1 && value <= 4;

const dateOf = (value) => {
    const date = new Date(value ?? '');
    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Calendar choices for a row.
 *
 * Rows written before these fields existed inherit the weekday and occurrence
 * of their last digest. That turns the old rolling cycle into a stable calendar
 * schedule without a migration or an arbitrary change to Monday.
 */
export function digestSchedule(row) {
    const last = dateOf(row?.digestAt);
    const fallbackWeekday = last?.getUTCDay() ?? 1;
    const fallbackWeek = last ? Math.min(4, Math.ceil(last.getUTCDate() / 7)) : 1;

    return {
        weekday: validDigestWeekday(row?.digestWeekday) ? row.digestWeekday : fallbackWeekday,
        week: validDigestWeek(row?.digestWeek) ? row.digestWeek : fallbackWeek
    };
}

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
export async function setDigest({
    tables,
    email,
    frequency,
    weekday,
    week,
    now = () => new Date()
}) {
    const them = lower(email);
    if (!them) throw new Error('user: an address is required');

    const at = now().toISOString();
    const existing = await tables.getEntity(TABLES.users, them, ROW);
    const current = digestSchedule(existing ?? { digestAt: at });
    const wanted = {
        weekday: validDigestWeekday(weekday) ? weekday : current.weekday,
        week: validDigestWeek(week) ? week : current.week
    };
    const wantedFrequency = validFrequency(frequency);
    const scheduleChanged = Boolean(
        existing &&
        (
            validFrequency(existing.digestFrequency) !== wantedFrequency ||
            current.weekday !== wanted.weekday ||
            current.week !== wanted.week
        )
    );

    await tables.upsertEntity(TABLES.users, {
        partitionKey: them,
        rowKey: ROW,
        digestFrequency: wantedFrequency,
        digestWeekday: wanted.weekday,
        digestWeek: wanted.week,
        ...(existing ? (scheduleChanged ? { digestScheduleAt: at } : {}) : { createdAt: at, digestAt: at })
    });

    return wantedFrequency;
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
 * Is this row's next cycle over?
 *
 * A row with no `digestAt` is treated as due immediately rather than as
 * never: the only way to have one is to have been written by something older
 * than this field, and the alternative is an address that silently never
 * hears from us and no way to tell it from one that is working.
 */
const utcDay = (date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const weeklyOccurrence = (date, weekday) => {
    const day = utcDay(date);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() - weekday + 7) % 7));
    return day;
};

const monthlyOccurrence = (year, month, { weekday, week }) => {
    const first = new Date(Date.UTC(year, month, 1));
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return new Date(Date.UTC(year, month, 1 + offset + ((week - 1) * 7)));
};

const latestOccurrence = ({ frequency, schedule, now }) => {
    if (frequency === DIGEST.weekly) return weeklyOccurrence(now, schedule.weekday);

    const today = utcDay(now);
    const current = monthlyOccurrence(now.getUTCFullYear(), now.getUTCMonth(), schedule);
    if (current <= today) return current;
    return monthlyOccurrence(now.getUTCFullYear(), now.getUTCMonth() - 1, schedule);
};

export function digestDue({ row, now = () => new Date() }) {
    const frequency = validFrequency(row?.digestFrequency);
    if (frequency === DIGEST.off) return false;

    const since = dateOf(row?.digestAt);
    if (!since) return true;

    const changed = dateOf(row?.digestScheduleAt);
    const anchor = changed && changed > since ? changed : since;
    const occurrence = latestOccurrence({
        frequency,
        schedule: digestSchedule(row),
        now: now()
    });

    return occurrence > anchor;
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
