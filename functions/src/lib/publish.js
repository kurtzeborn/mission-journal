// The publish pipeline: a site's letters in, a bound book out.
//
// Split from the endpoints that drive it because there are three of them --
// ask for a book, look at how it is going, and the queue worker that actually
// makes it -- and all three have to agree about where the files live and what
// the states are called. Agreement by import is cheaper than agreement by
// convention.
//
// Nothing here talks to a print provider. That is the last mile and it is
// deliberately not wired in yet: everything up to and including a finished,
// reviewable PDF is ours, works offline, and can be tested without an account
// anywhere. The provider's part is one upload and one redirect on the end of
// it.

import { randomBytes } from 'node:crypto';

import { buildInterior } from './book.js';
import { presentPosts } from './present.js';
import { readProfile } from './profile.js';
import { ROLE } from './acl.js';

// Its own container, like `exports`, and for the opposite reason. Exports are
// disposable and a lifecycle rule sweeps them; books are not. Once a book has
// been ordered the printer may refetch it for a reprint, and a file deleted
// out from under an order is a reprint that fails months later with nobody
// left who remembers why. So: no expiry rule on this container, ever.
export const BOOKS = 'books';

export const BOOK_QUEUE = 'book';

export const bookFolder = (slug, id) => `${slug}/${id}`;
export const statusName = (slug, id) => `${bookFolder(slug, id)}/status.json`;
export const bookName = (slug, id) => `${bookFolder(slug, id)}/book.pdf`;
export const manifestName = (slug, id) => `${bookFolder(slug, id)}/manifest.json`;

// The states a book can be in, and there are only three. A fourth -- ordered
// -- belongs to the provider and will live on the order record rather than
// here, because this file's job ends when there are bytes to look at.
export const STATE = {
    building: 'building',
    ready: 'ready',
    failed: 'failed'
};

// How long a build may sit in `building` before a second request is allowed
// to start another. Generous on purpose: a two-year mission with a thousand
// photographs is genuinely slow, and the failure this guards against -- an
// owner clicking twice and paying to render the same book twice -- is much
// cheaper than refusing to rebuild a book whose worker was killed mid-flight.
const STALE_MINUTES = 45;

/**
 * A book id that sorts into the order the books were asked for.
 *
 * Sortable by construction, because the reader finds the current book by
 * listing the site's folder and taking the last one. A random id would need
 * an index blob to put them in order, and an index is one more thing to
 * write, to keep in step, and to repair when it drifts.
 *
 * The random tail is not for uniqueness within a second -- two requests that
 * close together are refused above -- it is so the folder name cannot be
 * guessed from the moment somebody pressed the button.
 */
const newBookId = (at) =>
    `${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(4).toString('hex')}`;

const utf8 = (value) => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

const writeStatus = (store, status) =>
    store.writeBlob(BOOKS, statusName(status.slug, status.id), utf8(status), {
        contentType: 'application/json; charset=utf-8'
    });

const readJson = async (store, container, name) => {
    const blob = await store.readBlob(container, name);
    if (!blob) return null;

    try {
        return JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
    } catch {
        return null;
    }
};

/**
 * The most recent book asked for on this site, whatever became of it.
 *
 * Listing rather than keeping a `latest.json` pointer. The pointer would be a
 * second write on the request path that can succeed when the status write
 * fails, and a pointer to a book that does not exist is worse than one extra
 * listing of a folder that holds a handful of entries.
 */
export async function latestBook({ store, slug }) {
    const names = await store.listBlobs(BOOKS, `${slug}/`);
    const statuses = names.filter((name) => name.endsWith('/status.json'));
    if (!statuses.length) return null;

    return readJson(store, BOOKS, statuses[statuses.length - 1]);
}

export async function readBook({ store, slug, id }) {
    return readJson(store, BOOKS, statusName(slug, id));
}

/**
 * What the site is still missing before its cover can be printed.
 *
 * Returned rather than enforced, and the distinction matters. Only the
 * display name is a refusal -- it is the title of the book and there is
 * nothing to fall back on but the slug, which is an email address with the
 * @ taken out. The rest is a prompt: the UI can ask for a mission name
 * before the owner commits to a permanent object, and the owner can decline.
 *
 * The dates are absent from this list on purpose. `profile.js` documents an
 * empty date as "derive it from the letters", and the letters are right
 * here -- so a site that never filled the form in still gets a dated cover
 * rather than a nag.
 */
export function missingForBook(profile = {}) {
    const missing = [];
    if (!profile.displayName) missing.push('displayName');
    if (!profile.mission) missing.push('mission');
    return missing;
}

/**
 * Fill in what the cover needs and the profile does not say.
 *
 * The span on the cover is the span of the letters unless the owner has said
 * otherwise, which is what an unset date already means everywhere else. Read
 * off the presented posts rather than the raw ones so a hidden first letter
 * cannot set a date that appears on a cover but nowhere inside the book.
 */
export function coverProfile(profile, posts) {
    const days = posts
        .map((post) => String(post.originalDate ?? '').slice(0, 10))
        .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
        .sort();

    if (!days.length) return profile;

    return {
        ...profile,
        startDate: profile.startDate || days[0],
        returnDate: profile.returnDate || days[days.length - 1]
    };
}

const stale = (status, now) => {
    const since = now.getTime() - Date.parse(status.requestedAt ?? '');
    return !Number.isFinite(since) || since > STALE_MINUTES * 60 * 1000;
};

/**
 * Ask for a book.
 *
 * Writes the status before it enqueues, never the other way round. A worker
 * that picks up a message before its status blob exists has nothing to
 * update and no way to report what it is doing; a status with no message
 * behind it is merely a build that never starts, which the staleness window
 * above already recovers from.
 *
 * @returns {Promise<{id: string, missing: string[]} | {error: string, missing?: string[], id?: string}>}
 */
export async function requestBook({ store, slug, principal, now = new Date(), log }) {
    const { profile } = await readProfile({ store, slug });
    const missing = missingForBook(profile);

    if (missing.includes('displayName')) return { error: 'incomplete', missing };

    const current = await latestBook({ store, slug });
    if (current?.state === STATE.building && !stale(current, now)) {
        return { error: 'building', id: current.id };
    }

    const id = newBookId(now);
    const status = {
        id,
        slug,
        state: STATE.building,
        requestedAt: now.toISOString(),
        // Who to tell when it is ready, and the only reason this is kept. It
        // is not an audit trail: an owner asking for a book of letters they
        // already hold is not an event anybody needs to answer for.
        requestedBy: principal?.userDetails ?? '',
        missing
    };

    await writeStatus(store, status);
    await store.enqueue(BOOK_QUEUE, JSON.stringify({ slug, id }));

    log?.info?.('book.requested', { slug, id });

    return { id, missing };
}

/**
 * Build the book a request asked for.
 *
 * Runs on the queue rather than in the request that asked for it, because a
 * book of four hundred photographs will not finish inside the platform's
 * response window -- and because the owner should be able to close the tab.
 *
 * @param {{slug: string, id: string}} input.message
 */
export async function runBook({ message, store, madeAt = new Date().toISOString(), log = console }) {
    const { slug, id } = message ?? {};
    if (!slug || !id) return { status: 'rejected', reason: 'incomplete-message' };

    const status = await readBook({ store, slug, id });
    if (!status) {
        // The site was deleted between the request and this message, or the
        // status write failed and the enqueue somehow did not. Either way
        // there is nothing to report progress on and nobody to report it to.
        log.info?.('book: no status to build against', { slug, id });
        return { status: 'missing' };
    }

    try {
        const built = await assemble({ store, slug, id, madeAt, log });

        await store.writeBlob(BOOKS, manifestName(slug, id), utf8(built.manifest), {
            contentType: 'application/json; charset=utf-8'
        });

        await writeStatus(store, {
            ...status,
            state: STATE.ready,
            builtAt: new Date().toISOString(),
            pages: built.pages,
            letters: built.manifest.posts.length
        });

        log.info?.('book.built', { slug, id, pages: built.pages });
        return { status: 'built', pages: built.pages };
    } catch (error) {
        // Recorded rather than rethrown. Throwing would retry the message
        // five times and then drop it on the poison queue, leaving the owner
        // watching a spinner that never resolves; a failed status is a thing
        // the page can say out loud and a button they can press again.
        await writeStatus(store, {
            ...status,
            state: STATE.failed,
            failedAt: new Date().toISOString(),
            error: error.message
        });

        log.error?.('book.failed', { slug, id, error: error.message });
        return { status: 'failed', error: error.message };
    }
}

/**
 * Lay the book out and put it in storage.
 *
 * Built from the reader's projection of the letters, not the owner's, and
 * that is the whole of the hidden-post rule for books. A letter the owner has
 * held is one they decided not to publish; a bound object is the last place
 * to bring it back, and it would arrive there without them noticing. The same
 * choice keeps `heldReason`, `originalFrom` and the rest of the owner-only
 * fields out of a file that is destined for a third party's printer.
 */
async function assemble({ store, slug, id, madeAt, log }) {
    const blob = await store.readBlob('rendered', `${slug}/posts.json`);
    const stored = blob ? JSON.parse(Buffer.from(blob.bytes).toString('utf8')) : [];
    const posts = presentPosts(Array.isArray(stored) ? stored : [], ROLE.reader);

    if (!posts.length) throw new Error('there are no letters to print yet');

    const { profile } = await readProfile({ store, slug });
    const { stream, done } = buildInterior({
        store,
        slug,
        posts,
        profile: coverProfile(profile, posts),
        madeAt,
        log
    });

    // Same dance as the archive export: the builder closes its stream only on
    // success, so a build that throws would leave the upload waiting forever
    // for bytes that are not coming. Destroyed with no argument, because a
    // stream emitting an error nobody is listening for takes the process down
    // -- the real reason is rethrown from `outcome` below instead.
    const built = done.catch((error) => {
        stream.destroy();
        throw error;
    });

    const upload = store.uploadStream(BOOKS, bookName(slug, id), stream, {
        contentType: 'application/pdf',
        // Named for the missionary rather than for the book id, because the
        // one person who ever downloads it is looking at a folder of PDFs
        // trying to work out which is theirs.
        contentDisposition: `inline; filename="${slug}-letters.pdf"`
    });

    // allSettled rather than all: when one of these fails the other is about
    // to, and `all` would return the first rejection while the second was
    // still in flight -- an unhandled rejection landing after the invocation
    // had finished, which on this runtime kills the worker rather than the
    // build.
    const outcomes = await Promise.allSettled([upload, built]);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure) throw failure.reason ?? new Error('the book could not be built');

    const result = outcomes[1].value;

    return {
        pages: result.pages,
        manifest: {
            id,
            slug,
            builtAt: new Date().toISOString(),
            pages: result.pages,
            // Which letters are in this copy, and on which page each of them
            // starts. Recorded because a book is permanent and the archive is
            // not: letters get edited and hidden after the fact, and without
            // this there is no way to answer "what is actually in the one on
            // the shelf".
            posts: result.opens
        }
    };
}
