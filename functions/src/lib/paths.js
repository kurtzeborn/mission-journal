// Turning untrusted strings into blob path segments.
//
// Blob names are flat strings in which `/` creates virtual directories, so a
// crafted attachment filename like `../rendered/elder.smith/posts.json` would
// escape its prefix and overwrite live data. Every segment below is built,
// not interpolated.

import { createHash } from 'node:crypto';

const MAX_NAME = 100;

// Path separators, traversal sequences, control characters, and leading dots
// all removed. The unmodified filename is recorded in metadata.json, so
// nothing is lost for display.
export function safeName(filename) {
    const base = String(filename ?? '')
        .replace(/[\u0000-\u001F\u007F]/g, '')
        .replace(/[\\/]/g, '-')
        .replace(/\.{2,}/g, '.')
        .replace(/^\.+/, '')
        .replace(/[<>:"|?*]/g, '-')
        .trim();

    if (!base) return 'unnamed';
    if (base.length <= MAX_NAME) return base;

    // Truncate the stem, keep the extension: a name that loses its suffix
    // stops being recognizable as an image downstream.
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || base.length - dot > 12) return base.slice(0, MAX_NAME);
    const ext = base.slice(dot);
    return base.slice(0, MAX_NAME - ext.length) + ext;
}

export const attachmentPath = (index, filename) =>
    `${String(index).padStart(2, '0')}-${safeName(filename)}`;

// A Message-ID is sender-controlled and may contain anything at all, so it is
// hashed rather than sanitized. Sanitizing would risk collapsing two distinct
// IDs onto one directory, which would silently merge two letters; a hash
// cannot. The true Message-ID is recorded in metadata.json.
export function msgIdSegment(messageId, ulid) {
    if (!messageId) return `u_${ulid}`;
    const digest = createHash('sha256').update(String(messageId), 'utf8').digest('hex');
    return `m_${digest.slice(0, 16)}`;
}

// Photo identity is content, not filename: the same picture forwarded twice
// is one photo.
export const photoId = (bytes) =>
    `p_${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`;

// The slug is the local-part of the missionary's address, lowercased, with no
// other transformation — collapsing dots and hyphens would let two distinct
// Church-issued addresses map to one slug. It still has to be checked rather
// than trusted, because it reaches a blob path.
const SLUG = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function validSlug(slug) {
    const s = String(slug ?? '').toLowerCase();
    return SLUG.test(s) && !s.includes('..') ? s : null;
}

// Crockford's base32, uppercase, twenty-six characters. The Worker generates
// these and nothing else ever should, but they arrive from a URL on the
// manage page and are concatenated straight into `inbox/{ulid}.raw`.
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function validUlid(ulid) {
    const value = String(ulid ?? '').toUpperCase();
    return ULID.test(value) ? value : null;
}
