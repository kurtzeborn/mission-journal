// The first letters we turned away at the door.
//
// A rejection is the most invisible thing this service does. Nothing is
// written, nothing renders, and the only person who learns of it is the one it
// happened to -- who is told, by an automated reply, that their mail client is
// at fault and they should try again. If they try again and it fails again,
// `nudgeOnce` has already spoken and says nothing further. So the outcome for
// somebody doing everything we asked is silence, and the only record is a
// trace in App Insights that nobody is watching.
//
// That is how a fortnight went by with three refused forwards of the same
// family's letters and no page in the service showing it. This is the page.
//
// **Only the two bootstrap refusals are kept.** Every other rejection is a
// stranger, a spammer or a loop, and a list that fills with those is a list
// nobody reads. These two are different in kind: they are somebody trying to
// start an archive and failing at it, which is the one thing this service
// exists to make easy.
//
// **The row lives exactly as long as the message it names.** `inbox/{ulid}.raw`
// is on a thirty-day lifecycle rule, and both doors out of here -- replay and
// bypass -- read that blob. A row outliving it would be an offer of help that
// cannot be honored, which is worse than no offer.

import { TABLES } from './tables.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Matched to the lifecycle rule on the `inbox` container, not chosen. See
// infra/main.bicep.
export const KEEP_DAYS = 30;

// The refusals a person can act on. `no-recoverable-original` is deliberately
// absent: there is no original to replay and nothing for an operator to look
// at, so a row would only offer buttons that cannot work.
export const KEPT_REASONS = new Set(['bootstrap-not-attached', 'bootstrap-unverified']);

const iso = (value) => new Date(value).toISOString();

/**
 * Note that a first letter was refused.
 *
 * Never throws. This runs inside the rejection path of ingest, where the
 * letter is already refused and the sender has already been answered -- a
 * failure to write the record must not turn a handled rejection into a poison
 * queue message that runs four more times.
 *
 * @param {object} input
 * @param {object} input.tables
 * @param {string} input.ulid
 * @param {string} input.slug     already validated by the caller
 * @param {object} input.verdict  from classify()
 * @param {object} input.extracted
 * @param {function} [input.now]
 * @param {object} [input.log]
 */
export async function recordRejection({ tables, ulid, slug, verdict, extracted, now = () => new Date(), log }) {
    if (!KEPT_REASONS.has(verdict?.reason) || !slug || !ulid) return false;

    const at = now();

    try {
        await tables.upsertEntity(TABLES.rejections, {
            partitionKey: slug,
            rowKey: ulid,
            at: iso(at),
            sender: verdict.sender ?? '',
            author: verdict.author ?? '',
            subject: extracted?.original?.subject ?? extracted?.outerSubject ?? '',
            reason: verdict.reason,
            source: extracted?.source ?? '',
            forgetAfter: iso(at.getTime() + KEEP_DAYS * DAY_MS)
        });
        return true;
    } catch (error) {
        log?.error?.('rejections: could not record', { slug, ulid, error: error.message });
        return false;
    }
}

/**
 * Every refused first letter still worth showing, newest first.
 *
 * Rows past their own `forgetAfter` are hidden here rather than waited on: the
 * sweep runs nightly and the message they point at may already be gone.
 *
 * `settled` is asked once per slug, and a slug that has since acquired an
 * archive has its rows deleted rather than merely hidden. That is what makes
 * the list empty itself: replaying a refused letter is what creates the thing
 * the question asks about, so the row that offered the button disappears the
 * moment the button works.
 *
 * @param {object} input
 * @param {object} input.tables
 * @param {function} [input.settled] async (slug) => boolean
 * @param {function} [input.now]
 * @returns {Promise<Array<object>>}
 */
export async function listRejections({ tables, settled = null, now = () => new Date() }) {
    const at = now().getTime();
    const rows = (await tables.listEntities(TABLES.rejections)).filter(
        (row) => !(Date.parse(row.forgetAfter) < at)
    );

    const done = new Set();
    if (settled) {
        for (const slug of new Set(rows.map((row) => row.partitionKey))) {
            if (await settled(slug)) done.add(slug);
        }
        for (const row of rows.filter((row) => done.has(row.partitionKey))) {
            await tables.deleteEntity(TABLES.rejections, row.partitionKey, row.rowKey);
        }
    }

    return rows
        .filter((row) => !done.has(row.partitionKey))
        .map((row) => ({
            slug: row.partitionKey,
            ulid: row.rowKey,
            at: row.at ?? '',
            sender: row.sender ?? '',
            author: row.author ?? '',
            subject: row.subject ?? '',
            reason: row.reason ?? '',
            source: row.source ?? '',
            forgetAfter: row.forgetAfter ?? ''
        }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * Drop the record, because the letter it describes finally got in.
 *
 * Deliberately not a "resolved" flag. The row exists to say somebody is stuck;
 * once they are not, keeping it would be keeping the sender, subject and
 * author of a letter that is now filed properly somewhere else.
 */
export async function forgetRejection({ tables, slug, ulid }) {
    await tables.deleteEntity(TABLES.rejections, slug, ulid);
}

/**
 * Remove rows whose message has aged out of the inbox.
 *
 * Ordinary tidying, unlike purge.js: nothing here is the only copy of
 * anything, and the letter these rows point at is being destroyed by a
 * lifecycle rule this code does not control and cannot delay.
 */
export async function purgeRejections({ tables, now = () => new Date(), log }) {
    const at = now().getTime();
    const rows = await tables.listEntities(TABLES.rejections);
    const stale = rows.filter((row) => Date.parse(row.forgetAfter) < at);

    for (const row of stale) {
        await tables.deleteEntity(TABLES.rejections, row.partitionKey, row.rowKey);
    }

    if (stale.length) {
        log?.info?.('rejections: forgot stale records', {
            forgotten: stale.length,
            slugs: [...new Set(stale.map((row) => row.partitionKey))]
        });
    }

    return { scanned: rows.length, forgotten: stale.length };
}
