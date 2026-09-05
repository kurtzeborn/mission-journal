// What an owner may change about a published letter, and what changing it does
// to the record.
//
// Kept out of the Function so the rules can be exercised directly: which
// fields are editable, what each edit implies for the rest of the post, and
// how a write survives a second owner saving at the same moment.

import { sanitizeBody, PHOTO_PREFIX } from './sanitize.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';

// Everything an owner is allowed to change. Anything absent is either derived
// from the source message or internal bookkeeping.
//
// The dedup fields are the ones this list exists to protect. `originalFrom`,
// `originalDate`, `originalMessageId` and `bodyHead100` are what a re-forward
// of the same letter is matched against, so an edit that moved any of them
// would let that letter quietly return as a second post months later.
const EDITABLE = new Set(['subject', 'bodyHtml', 'hidden']);

// Only these two are content. Hiding is a moderation decision about the post
// rather than a change to what it says, so it does not stamp `editedBy` --
// otherwise hiding and unhiding a letter would leave a record claiming
// somebody had rewritten it.
const CONTENT_FIELDS = new Set(['subject', 'bodyHtml']);

// Long enough for any real letter subject and short enough that the field
// cannot be used to push a megabyte into posts.json.
const MAX_SUBJECT = 500;

// The same protection for the body, which for a long time had none at all --
// the sentence above was true of the subject and quietly false of the field
// next to it. Measured against a real archive: the longest of forty-four
// letters ran to 5,138 characters and the median to 1,479, so this is roughly
// twenty-five times the longest one anybody has actually written.
const MAX_BODY = 128 * 1024;

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');

/**
 * Apply an owner's changes to one post.
 *
 * @param {object} post the stored post record
 * @param {object} changes the request body
 * @param {object} options
 * @param {string} options.editor the signed-in owner's address
 * @param {string} options.slug the site being edited
 * @returns {{error: string}|{post: object, changed: string[]}}
 */
export function applyEdit(post, changes, { editor, slug, now = new Date() }) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        return { error: 'body must be a JSON object' };
    }

    const keys = Object.keys(changes);
    if (!keys.length) return { error: 'no changes supplied' };

    const rejected = keys.filter((key) => !EDITABLE.has(key));
    if (rejected.length) return { error: `not editable: ${rejected.join(', ')}` };

    const next = { ...post };
    const changed = [];

    if ('hidden' in changes) {
        if (typeof changes.hidden !== 'boolean') return { error: 'hidden must be a boolean' };
        if (changes.hidden !== Boolean(post.hidden)) {
            next.hidden = changes.hidden;
            changed.push('hidden');
        }
    }

    if ('subject' in changes) {
        if (typeof changes.subject !== 'string') return { error: 'subject must be a string' };
        const subject = changes.subject.trim();
        if (subject.length > MAX_SUBJECT) {
            return { error: `subject exceeds ${MAX_SUBJECT} characters` };
        }
        if (subject !== (post.subject ?? '')) {
            next.subject = subject;
            changed.push('subject');
        }
    }

    if ('bodyHtml' in changes) {
        if (typeof changes.bodyHtml !== 'string') return { error: 'bodyHtml must be a string' };

        // Before sanitizing rather than after, so an oversized body costs a
        // length comparison instead of a full parse.
        if (changes.bodyHtml.length > MAX_BODY) {
            return { error: `bodyHtml exceeds ${MAX_BODY} characters` };
        }

        // The same sanitizer ingest uses, with no trusted-input exception. An
        // owner is trusted; an owner's hijacked session is not, and what it
        // would be writing into is the file served to every reader and baked
        // into every downloaded archive.
        const bodyHtml = sanitizeBody(changes.bodyHtml, {
            keepPhotoPrefix: `${PHOTO_PREFIX}${slug}/`
        });

        if (bodyHtml !== (post.bodyHtml ?? '')) {
            next.bodyHtml = bodyHtml;
            changed.push('bodyHtml');

            // `bodyText` is only ever a fallback for a letter that has not
            // rendered yet, and readers receive it. Leaving it in place after
            // an edit would defeat the main reason to edit at all: an owner
            // removing a name from the body would publish that name anyway,
            // out of a field they were never shown and cannot see.
            if (bodyHtml && next.bodyText !== undefined) {
                delete next.bodyText;
                changed.push('bodyText');
            }
        }
    }

    if (changed.some((field) => CONTENT_FIELDS.has(field))) {
        next.editedBy = editor;
        next.editedAt = now.toISOString();
    }

    return { post: next, changed };
}

/**
 * Read-modify-write posts.json under its ETag, retrying a lost race.
 *
 * The mutation runs inside the loop rather than against a copy read outside
 * it, so a retry re-examines what the winning writer actually left behind.
 *
 * @param {Function} mutate (posts, blobEtag) => {error} | {posts, ...rest}
 *   The ETag is handed over so a caller can refuse to write on top of a
 *   version its user never saw.
 */
export async function commitPosts({ store, slug, mutate, log = console }) {
    const name = `${slug}/posts.json`;

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const current = await store.readBlob('rendered', name);
        if (!current) return { error: 'not found' };

        const posts = JSON.parse(Buffer.from(current.bytes).toString('utf8'));
        const outcome = mutate(posts, current.etag);
        if (outcome.error) return outcome;

        try {
            await store.writeBlob('rendered', name, utf8(outcome.posts), {
                contentType: 'application/json',
                ifMatch: current.etag
            });
            return outcome;
        } catch (err) {
            if (!isConflict(err)) throw err;
            log.info?.('edit: posts.json conflict, retrying', { slug, attempt });
        }
    }

    // Losing eight races in a row is a stuck writer or a bug, not contention.
    throw new Error(`posts.json contention for ${slug} after ${CONFLICT_RETRIES} attempts`);
}
