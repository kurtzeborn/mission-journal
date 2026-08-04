// HTML sanitization for letter bodies.
//
// Email HTML is untrusted input — under the forward path it is supplied by a
// third party by construction. Static Web Apps authenticates API calls with a
// session cookie, so script running on a letters page could add ACL members,
// edit posts, or pull down the whole archive. This is the single most
// important control in the system.
//
// Sanitization happens on the way *into* `rendered/`, never on the way out, so
// a bug in the reader cannot reintroduce the vulnerability and the offline
// export and print-book PDF inherit safe content for free.

import sanitizeHtmlLib from 'sanitize-html';

// Allowlist, never denylist. The plan's set — headings, paragraphs, breaks,
// lists, emphasis, blockquote, links, images — plus two additions:
//
//   div/span   Mail clients carry paragraph structure on these constantly.
//              Stripped of every attribute they are inert.
//   table/*    Outlook wraps ordinary prose in table layout. Dropping the
//              tags keeps the text but collapses a multi-column signature or
//              a quoted block into one run-on paragraph, which mangles real
//              letters. Attribute-stripped tables carry no script surface.
//
// Everything else goes, including script, style, iframe, object, form, and
// every on* handler.
const ALLOWED_TAGS = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'div', 'span',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'small',
    'blockquote', 'pre', 'code',
    'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption'
];

// Content is discarded rather than flattened to text. Without this a <style>
// block's CSS would survive as visible prose in the letter.
const DROP_CONTENT = ['script', 'style', 'textarea', 'option', 'noscript', 'head', 'title'];

const PHOTO_PREFIX = '/api/photo/';

// The header block a client leaves behind when it flattens a forward into the
// body. Removing it is a privacy control, not tidying: a missionary's weekly
// letter goes to their whole distribution list, so the `To:` line carries
// every recipient's address into the published post. Two real letters
// measured 100 and 101 distinct third-party addresses each.
//
// Addresses the missionary typed into the letter itself are left alone. Those
// were written to be read, and the site is ACL-gated either way. Only the
// client-generated header block goes.
//
// No word boundary before the label: a <br> contributes no text, so the next
// label arrives glued to the end of the previous value -- "MondayTo:". A
// spurious extra label only ever makes a block look *more* like a header run,
// and the two guards below are what actually decide.
const HEADER_LABEL = /(from|sent|date|to|cc|bcc|subject|reply-to):/gi;
const LEADING_SEPARATOR = /^(?:-{3,}\s*forwarded message\s*-{3,}|_{8,})\s*/i;

// From: plus two more labels. Every client emits at least four.
const MIN_LABELS = 3;

// Below this there is not enough of the letter to recognize it inside a
// candidate block, so the block is kept. Leaving a header block in place is a
// disclosure; removing one that turns out to contain the letter is data loss,
// and the archive in `raw/` is the only other copy.
const MIN_PROBE = 20;
const PROBE_LENGTH = 50;

const collapse = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

// All whitespace removed, because the same prose arrives spaced differently in
// the two MIME parts: the plain-text part wraps at some column, and the HTML
// part breaks with <br>, which leaves no space behind at all. Comparing the
// two without this finds no match, and the guard silently stops guarding.
const squash = (value) => String(value ?? '').replace(/\s+/g, '');

/**
 * Recognizes the smallest block whose text is the forwarded header run.
 *
 * The block has to *start* with `From:`, so a block holding the letter ahead
 * of the headers can never match, and it must not contain the opening of the
 * letter, so a block holding the letter after them cannot either. That second
 * guard is what makes this safe on the common Outlook shape, where one div
 * wraps the header paragraph and the entire letter beneath it.
 */
const isQuotedHeaderBlock = (text, probe) => {
    const value = collapse(text).replace(LEADING_SEPARATOR, '').trim();
    if (!/^from:/i.test(value)) return false;

    const labels = new Set();
    for (const match of value.matchAll(HEADER_LABEL)) labels.add(match[1].toLowerCase());
    if (labels.size < MIN_LABELS) return false;

    return !squash(value).includes(probe);
};

const cidKey = (src) => {
    const match = /^cid:(.+)$/i.exec(String(src ?? '').trim());
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]).toLowerCase();
    } catch {
        // A malformed percent-escape is not worth failing the letter over; the
        // reference simply will not match and the image is dropped.
        return match[1].toLowerCase();
    }
};

/**
 * @param {string|null} html
 * @param {object} [options]
 * @param {Map<string,string>} [options.cidMap] lowercased Content-ID -> photo URL
 * @param {string|null} [options.letterText] the letter body recovered from the
 *   plain-text part, used to protect real content when dropping the quoted
 *   header block. Absent or too short, no header block is dropped.
 * @returns {string} sanitized HTML, '' when there was nothing to sanitize
 */
export function sanitizeBody(html, { cidMap = new Map(), letterText = null } = {}) {
    if (!html) return '';

    const probe = squash(letterText).slice(0, PROBE_LENGTH);
    const dropHeaders = probe.length >= MIN_PROBE;

    return sanitizeHtmlLib(String(html), {
        allowedTags: ALLOWED_TAGS,
        nonTextTags: DROP_CONTENT,

        // No style attribute, no class, no id, no width/height, and no event
        // handlers anywhere. An <img> keeps only what it needs to render.
        // `target`/`rel` are listed because the allowlist is applied after
        // transformTags, so the guards added there have to be permitted here;
        // the transform rebuilds an anchor's attributes from nothing, so an
        // incoming rel or target is still discarded.
        allowedAttributes: {
            a: ['href', 'target', 'rel'],
            img: ['src', 'alt']
        },

        // No javascript:, no data:. data: is excluded deliberately even though
        // it cannot execute in an <img> — it would let a forwarder embed
        // arbitrary bytes that bypass the photo pipeline entirely, so they
        // would never be EXIF-stripped, size-capped, or ACL-checked.
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: { img: [] },
        allowProtocolRelative: false,

        transformTags: {
            // cid: references point at MIME parts, which mean nothing to a
            // browser. Rewriting them to the rendered photo is what keeps
            // embedded images working in Outlook and Apple Mail — the common
            // case for pasted photos, not an edge case.
            img: (tagName, attribs) => {
                const key = cidKey(attribs.src);
                const mapped = key ? cidMap.get(key) : null;
                return {
                    tagName,
                    attribs: mapped
                        ? { src: mapped, alt: attribs.alt ?? '' }
                        : { alt: attribs.alt ?? '' }
                };
            },
            // A letter can legitimately link out. Untrusted links get the full
            // set of guards: no window.opener handle back to the letters page,
            // and no reputation passed to whatever a forwarder linked.
            a: (tagName, attribs) => ({
                tagName,
                attribs: attribs.href
                    ? { href: attribs.href, target: '_blank', rel: 'noopener noreferrer nofollow' }
                    : {}
            })
        },

        // Anything still pointing off-site after cid: rewriting is removed.
        // These are overwhelmingly tracking pixels, and leaving them in would
        // leak every reader's IP address and read time to whatever marketing
        // system the missionary's mail passed through. Real photos are always
        // attachments or cid: parts, so nothing of value is lost.
        //
        // The same hook drops the forwarded header block, because it removes
        // the tag *and its contents* — which is the whole point here, where
        // the addresses are the content.
        exclusiveFilter: (frame) => {
            if (frame.tag === 'img') {
                return !String(frame.attribs?.src ?? '').startsWith(PHOTO_PREFIX);
            }
            return dropHeaders && isQuotedHeaderBlock(frame.text, probe);
        }
    });
}

// The URL the reader fetches a rendition from. Kept here so the sanitizer and
// the render pipeline cannot disagree about the shape of a photo link.
export const photoUrl = (slug, photoId, size) => `${PHOTO_PREFIX}${slug}/${photoId}/${size}.webp`;
