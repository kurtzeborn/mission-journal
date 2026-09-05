// What a caller is allowed to see of a stored post.
//
// An allowlist rather than a denylist, deliberately. Post records grow -- this
// one already gained `linkedPhotoServices` after it was first designed -- and
// a denylist ships every new internal field to the browser until someone
// remembers to add it. An allowlist ships nothing until someone decides to.

import { ROLE } from './acl.js';

// Everything a reader needs to render a letter, and nothing else. Note what is
// absent: `sourceRawPath` is an internal blob path, `bodyHead100` is a dedupe
// artifact, and `originalMessageId` and `originalFrom` are the missionary's
// own mail identifiers.
const READER_FIELDS = [
    'id',
    'originalDate',
    'subject',
    'bodyHtml',
    // Only present in the gap between ingest and render, or if a render never
    // succeeded. Carried so a letter is legible rather than blank in that case.
    'bodyText',
    'photos',
    'linkedPhotoServices'
];

// The owner is the missionary's family member who runs the site. They see the
// held letters, the reason each was held, and the provenance needed to decide
// whether to publish it.
const OWNER_FIELDS = [
    ...READER_FIELDS,
    'hidden',
    'heldReason',
    'editedBy',
    'editedAt',
    'receivedAt',
    'extractionSource',
    'originalFrom',
    'forwardedBy'
];

const pick = (post, fields) => {
    const out = {};
    for (const field of fields) {
        if (post[field] !== undefined) out[field] = post[field];
    }
    return out;
};

// A letter's pictures are shown in the order they were taken.
//
// Which is not the order they arrived in. An owner adding two years of
// photographs from a phone uploads them in whatever order the file picker
// handed them over, and a bulk add spread across the archive by date can put
// three on one letter from three separate runs. Arrival order there is not an
// order at all, it is a record of how the work was done.
//
// Only pictures added by an owner carry `takenAt`: it is read in the browser
// from the file (see `web/taken.js`), and a letter's own attachments never
// pass through there. So those keep the order the missionary sent them in,
// which is the order they were meant to be seen in, and the sort has to leave
// it alone. An empty key does that -- undated first, in arrival order,
// untouched -- because `Array.prototype.sort` is stable and a comparator
// returning 0 pins them where they were.
const takenAt = (photo) => String(photo?.takenAt ?? '');

const byTaken = (a, b) => {
    const ta = takenAt(a);
    const tb = takenAt(b);
    if (ta === tb) return 0;
    return ta < tb ? -1 : 1;
};

// Copied before sorting. `pick` hands out the stored array by reference, and
// sorting in place would reorder the object the caller read from storage --
// which the render path then writes back.
const inOrder = (post) =>
    post.photos ? { ...post, photos: [...post.photos].sort(byTaken) } : post;

// Letters are ordered by the local wall clock the sender wrote, not by the
// instant that clock refers to. That is a deliberate choice and the opposite
// of what this file used to do by accident.
//
// Comparing instants sounds more correct and reads as a bug. A missionary
// transferred from +08:00 to -07:00 can write a letter headed August 2 that
// *precedes*, in absolute time, one headed August 1 -- measured, not
// supposed. Ordering by instant lists August 2 above August 1 while the page
// prints those very dates beside them. Position and label must agree.
//
// It is also the only option that needs no invention. Every inline forward
// arrives with no offset at all, because the client rendered the quoted
// header without one, so there is no instant to compare without assuming a
// zone -- and `Date.parse` assumes the *host's* zone for those values, which
// makes the order depend on where the code runs. `dates.js` refuses that
// guess everywhere else and this agrees with it.
//
// The stamp is fixed-width out of `rfc3339InOwnOffset` -- YYYY-MM-DDTHH:MM:SS,
// seconds always emitted -- so a byte comparison of the first 19 characters is
// chronological. Sliced explicitly rather than relying on the offset sorting
// after the stamp, which is what made the old behavior accidental: a stamp
// that ever lost its seconds would have silently reordered the archive.
const stamp = (post) => String(post.originalDate ?? '').slice(0, 19);

// Ties break on `id`, so the order is total and identical between calls.
// Timestamps genuinely collide: a client that renders no seconds puts every
// letter of an evening at :00, and an undated post has no stamp at all.
// Without a tiebreak those land in whatever order the engine's sort happened
// to leave them, which can differ between two requests for the same archive.
const byNewestWritten = (a, b) => {
    const sa = stamp(a);
    const sb = stamp(b);
    if (sa !== sb) return sa < sb ? 1 : -1;

    const ia = String(a.id ?? '');
    const ib = String(b.id ?? '');
    if (ia === ib) return 0;
    return ia < ib ? 1 : -1;
};

/**
 * @param {object[]} posts the raw contents of rendered/{slug}/posts.json
 * @param {string} role a ROLE value
 * @returns {object[]} sorted newest-first, projected for the role
 */
export function presentPosts(posts, role) {
    const owner = role === ROLE.owner;
    const fields = owner ? OWNER_FIELDS : READER_FIELDS;

    // Hidden posts are removed here, before the bytes leave the Function.
    // Shipping them with a flag for the client to respect would put the
    // letter in the browser of someone not entitled to it, and "the UI does
    // not draw it" is not a privacy control.
    const visible = owner ? posts : posts.filter((p) => !p.hidden);

    return visible
        .map((p) => inOrder(pick(p, fields)))
        .sort(byNewestWritten);
}

/**
 * Whether a photo may be served, given the posts of its site.
 *
 * A photo URL is guessable in principle and permanent in practice, so the
 * hidden check has to be repeated here. Otherwise a held letter's pictures
 * stay fetchable by anyone who saw them once.
 */
export function photoIsVisible(posts, photoId, role) {
    return posts.some(
        (post) =>
            (role === ROLE.owner || !post.hidden) &&
            (post.photos ?? []).some((photo) => photo.id === photoId)
    );
}
