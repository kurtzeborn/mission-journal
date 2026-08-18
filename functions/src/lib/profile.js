// What a site is called, and when the mission starts and ends.
//
// The display name was, until now, whatever the claimant happened to type in
// the minute they took ownership. There was no way to change it: a typo in a
// name that heads every page of the archive, appears in the tab title, labels
// the site on the root list, and goes out in the subject line of every
// invitation was permanent. That is a poor reward for being the first person
// to show up.
//
// **The blob is the record; the `sites` row is an index.** This is the same
// arrangement as `acl.json` and the `memberships` table, and for the same
// reason: the table is what the read paths can afford to consult on every
// request, and the blob is what survives the table being rebuilt. Drift
// recovery (`tools/rebuild-memberships.js`) restores the row *from* the blob,
// so writing only the row would leave a rename that a repair run silently
// undoes -- reverting it on the one code path that exists because something
// has already gone wrong.
//
// **`alternateSenders` is carried through untouched and is not editable
// here.** It is in the file, seeded empty, and nothing reads it: routing keys
// on `@missionary.org` alone. Offering the field before ingest honours it
// would put a control on the page that appears to decide who may publish into
// an archive and in fact decides nothing -- a lie with the shape of a security
// setting. It stays in the document so an editor does not delete it, and it
// gets a UI when it gets an implementation.

import { setSiteProfile } from './sites.js';

const CONFIG = 'config';
const FILE = (slug) => `${slug}/profile.json`;

// Long enough for "Sister Maria-Fernanda Villalobos", short enough that it
// cannot break the masthead or the subject line it is pasted into.
const NAME_MAX = 60;

/**
 * Read a site's profile.
 *
 * A missing file is not an error. Sites claimed before this existed have no
 * `profile.json` at all -- the claim flow writes the `sites` row and nothing
 * else -- so the absent case is the common one and resolves to a blank
 * document the owner can fill in.
 *
 * @returns {Promise<{profile: object, etag: string}>}
 */
export async function readProfile({ store, slug }) {
    const blob = await store.readBlob(CONFIG, FILE(slug));
    if (!blob) return { profile: { slug, displayName: '', alternateSenders: [] }, etag: '' };

    try {
        const profile = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
        return { profile: { alternateSenders: [], ...profile, slug }, etag: blob.etag ?? '' };
    } catch {
        // Corrupt is treated as absent rather than as a failure. The
        // alternative hands the owner a page they cannot use and no way to
        // repair it, over a file whose entire contents they were about to
        // overwrite anyway.
        return { profile: { slug, displayName: '', alternateSenders: [] }, etag: '' };
    }
}

// Collapses whitespace and drops control characters. Not an escape -- every
// consumer either sets `textContent` or runs it through `escape()` on the way
// into an email -- but a name containing a newline breaks the subject header
// it is pasted into, and that is a header-injection shape worth refusing at
// the boundary rather than trusting six call sites to handle.
const tidy = (value) =>
    String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, NAME_MAX);

// A calendar day, not a timestamp. The three things these feed -- scheduling
// the ownership prompts, printing mission dates on a book cover, and counting
// up on the archive page -- are all answered in days, and a full ISO instant
// would invite a timezone argument about which day somebody came home.
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const validDate = (value) => {
    if (!value) return '';
    const text = String(value).trim();
    if (!DATE.test(text)) return null;
    // Rejects 2027-02-31, which matches the pattern and is not a date.
    const parsed = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(text)) return null;
    return text;
};

/**
 * Change a site's profile.
 *
 * ETag-guarded between its own read and its own write, because two owners is
 * the normal case rather than the exotic one -- a parent and the missionary
 * both hold the seat -- and a last-write-wins rename gives no sign that
 * anything was lost. The guard is server-side only: the window it closes is
 * the milliseconds inside this function, not the minutes a form sits open,
 * and asking the page to round-trip a validator would imply it closed the
 * second one too.
 *
 * The `sites` row is updated after the blob, not before. If the mirror fails
 * the record is still correct and the next repair run fixes the index; the
 * other order can leave the index holding a name that no file agrees with.
 *
 * @returns {Promise<{error: string} | {profile: object, etag: string}>}
 */
export async function saveProfile({ store, tables, slug, displayName, startDate, returnDate, log }) {
    const name = tidy(displayName);
    if (!name) return { error: 'a display name is required' };

    const began = validDate(startDate);
    if (began === null) return { error: 'the start date must be a date, like 2025-06-15' };

    const when = validDate(returnDate);
    if (when === null) return { error: 'the return date must be a date, like 2027-06-15' };

    const { profile, etag } = await readProfile({ store, slug });

    const next = {
        ...profile,
        slug,
        displayName: name,
        // Omitted rather than stored empty, for both dates. Absent means
        // "derive it from the letters", which is a different statement from
        // "there is no return date", and a blank string would make the two
        // indistinguishable.
        ...(began ? { startDate: began } : {}),
        ...(when ? { returnDate: when } : {}),
        updatedAt: new Date().toISOString()
    };
    if (!began) delete next.startDate;
    if (!when) delete next.returnDate;

    let written;
    try {
        written = await store.writeBlob(CONFIG, FILE(slug), JSON.stringify(next, null, 2), {
            contentType: 'application/json; charset=utf-8',
            // No file yet means the guard becomes "and there had better still
            // be none", which is what catches two owners creating one at the
            // same moment. Without it the second create is an overwrite that
            // looks like a success.
            ...(etag ? { ifMatch: etag } : { ifNoneMatch: '*' })
        });
    } catch (err) {
        if (err?.statusCode === 412 || err?.statusCode === 409) {
            return { error: 'somebody else changed this first' };
        }
        throw err;
    }

    try {
        await setSiteProfile({
            tables,
            slug,
            missionaryDisplayName: name,
            // Always offered, empty included: the archive page reads the start
            // date off this row, so an owner who clears the field has to see
            // the timer go away.
            missionStartDate: began
        });
    } catch (err) {
        // Not fatal, and deliberately not rolled back. The rename is saved;
        // what has failed is the copy the lists read from, which the repair
        // tool rebuilds from the file that just succeeded.
        log?.error?.('profile: renamed the site but could not update its index', {
            slug,
            message: err?.message
        });
    }

    return { profile: next, etag: written?.etag ?? '' };
}
