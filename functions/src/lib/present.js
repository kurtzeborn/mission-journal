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
        .map((p) => pick(p, fields))
        .sort((a, b) => String(b.originalDate ?? '').localeCompare(String(a.originalDate ?? '')));
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
