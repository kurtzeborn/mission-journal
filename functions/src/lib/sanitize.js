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

export const PHOTO_PREFIX = '/api/photo/';

// Our own access links, removed from anything on its way into `rendered/`.
//
// A claim link and an invitation link are bearer credentials: possession is
// the whole authentication. They are mailed to people who then do what people
// do with mail, which here includes forwarding it to `post@` -- and that
// publishes the link into the archive, where it is readable by everyone the
// archive is shared with. An invitation can carry the owner role, so a reader
// who found one in a letter could promote themselves.
//
// Not host-bound on purpose. Matching only `PUBLIC_BASE_URL` would make the
// single most security-critical module in the system depend on an app setting,
// where getting the setting wrong disables the control silently. Any host is
// matched instead, so the failure mode is a dead link in somebody's letter
// rather than a live credential in the archive.
//
// The match stops at whitespace, which is what a mail client's line wrapping
// inserts into a token this long. That is sufficient rather than sloppy: the
// part before the wrap is the base64url payload, so removing it leaves a
// remainder that cannot be verified and is not reassemblable from what
// survives. Redacting the beginning of a token destroys the token.
const ACCESS_LINK = /https?:\/\/[^\s"'<>]*\/(?:claim|invite)#[^\s"'<>]*/gi;

// No angle brackets, quotes or ampersand, so this is inert wherever it lands
// -- including inside an unquoted href, where it splits into junk attributes
// the allowlist then drops.
const REDACTED = '[link removed]';

/**
 * Strip our own claim and invitation links out of letter text.
 *
 * Exported because a plain-text letter never reaches `sanitizeBody` -- ingest
 * stores it as `bodyText` and render turns it into paragraphs itself -- and a
 * control that only covered the HTML path would be one forwarded plain-text
 * mail away from useless.
 */
export const redactAccessLinks = (value) =>
    value == null ? value : String(value).replace(ACCESS_LINK, REDACTED);

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

// Blocks that mail clients emit by the dozen to carry spacing they have
// already expressed some other way. Measured across the 24 stored letters:
// every one of them arrived with 10-19 empty <p> and one empty <div>, about
// 7% of the stored body and a blank line each on screen.
//
// Only these three. An empty <li> consumes a bullet, an empty <td> holds a
// column open, and an empty heading is more likely to be a real authoring
// mistake worth seeing -- none of those are safe to remove silently, and none
// of them appear in the corpus anyway.
//
// **A block holding a <br> and nothing else is not empty.** That measurement
// was taken over forwarded letters, all of them composed on a desktop client
// that separates paragraphs with margins and emits `<p><o:p>&nbsp;</o:p></p>`
// as leftover noise. Gmail's mobile composer does the opposite: it writes
// every paragraph as a bare `<div dir="auto">` with no margin at all, and
// puts the blank line between them in a `<div dir="auto"><br></div>`. That
// div *is* the paragraph break, and dropping it as empty ran a missionary's
// entire letter together into one wall of text -- which is what it did to the
// first direct send we ever received, and the reason this exception exists.
//
// The distinction is real rather than convenient. Nothing needs a <br> to sit
// alone in a block unless somebody meant a line to be there.
//
// **But only once the letter has started.** Outlook for Android opens every
// message with three of them above its own advertisement, and honoring those
// would put three blank lines at the top of every forward -- a visible
// regression on the path almost every letter takes, traded for a fix on the
// rare one. A break before any text has appeared is separating nothing.
const EMPTY_BLOCKS = new Set(['p', 'div', 'span']);

// A block holding nothing but breaks and space with nothing but closing tags
// between it and the end of the letter. Matched against our own output rather
// than the incoming mail, which is what makes a regex over HTML defensible
// here: every attribute has been stripped by then, so there is exactly one
// spelling of each tag to match. The lookahead is what lets a nested one be
// found -- `<div><div><br /></div></div>` has a closing tag after the block
// that matters, not the end of the string.
const TRAILING_BLANK = /<(p|div|span)>(?:\s|<br \/>)*<\/\1>(?=(?:\s*<\/(?:p|div|span)>)*\s*$)/;

// Closing what a cut left open. The rules are the ones above, so re-parsing
// already-sanitized output can only ever take more away, never let more in.
const REBALANCE = {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false
};

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
 * @param {string|null} [options.keepPhotoPrefix] a `/api/photo/{slug}/` prefix
 *   whose images have already been through here once and survive a second
 *   pass. See the img transform below.
 * @returns {string} sanitized HTML, '' when there was nothing to sanitize
 */
export function sanitizeBody(
    html,
    { cidMap = new Map(), letterText = null, keepPhotoPrefix = null } = {}
) {
    if (!html) return '';

    // Before anything is parsed, so the token is gone from the href and from
    // the visible text in one pass -- a mail client writes it in both places.
    const source = redactAccessLinks(String(html));

    // Redacted on both sides, so the two stay comparable. The probe is matched
    // against the sanitized HTML's text; redacting one and not the other could
    // turn a match into a miss for a letter that opens with a link, and a miss
    // there means a block holding the letter is mistaken for a header block
    // and dropped.
    const probe = squash(redactAccessLinks(letterText)).slice(0, PROBE_LENGTH);
    const dropHeaders = probe.length >= MIN_PROBE;

    // Output positions of horizontal rules and line breaks that survived.
    // `exclusiveFilter` runs innermost-first in closing order, and a frame's
    // `tagPosition` is where its opening tag was written, so at the moment a
    // block is judged these hold exactly the tags that closed before it did.
    // One *inside* the block therefore sits at a position at or after the
    // block's own, and one before or after it does not. Verified against
    // sanitize-html rather than assumed.
    //
    // Without this, `<div><hr></div>` reads as empty -- no text, no media --
    // and the block would be dropped together with the rule it exists to
    // show. `<div><br></div>` has the same problem and costs more, because
    // it is how Gmail writes a paragraph break. Images need no such
    // bookkeeping: `mediaChildren` already excludes the ones this filter
    // removed.
    let rules = [];
    let breaks = [];

    // Removing a block rewinds the output to where it opened, so a position
    // recorded from inside it would go on matching whatever is written there
    // instead -- which kept a blank line beside every paragraph that followed
    // a dropped quoted header block. The cut point moves back for the same
    // reason: a wrapper removed after the header block it held leaves the
    // letter starting where the wrapper did.
    const forget = (from) => {
        rules = rules.filter((position) => position < from);
        breaks = breaks.filter((position) => position < from);
        if (preamble > from) preamble = from;
        return true;
    };

    // Whether any real text has been written yet. `textFilter` runs in
    // document order as each text node is passed through, which is what makes
    // it usable from `exclusiveFilter` -- a bare text node opening a letter
    // (`<div>Hola<div><br></div>...`, Gmail's exact shape) has already been
    // seen by the time the break after it is judged, even though the block
    // holding it has not closed. Nothing here rewrites the text.
    let started = false;

    // Everything above the quoted headers belongs to the forwarder, not to the
    // missionary: a mail client's own advertisement, the rule it draws under
    // it, and anything a parent typed before passing the letter on. None of it
    // was written by the person whose archive this is.
    //
    // Only ever cut above text the letter itself has not reached yet. A chain
    // can hold a second run of quoted headers *below* the letter -- something
    // the missionary was replying to -- and cutting at that one would throw
    // away the letter instead of the preamble. `seen` is the letter's own
    // opening words arriving in document order, so a header block judged after
    // that point is left where it is and only the block itself is removed.
    let seen = '';
    let reached = !dropHeaders;
    let preamble = 0;

    const walked = sanitizeHtmlLib(source, {
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

        // Read, never written. See `started` above.
        textFilter: (text) => {
            if (!started && String(text).trim()) started = true;
            if (!reached) {
                seen = squash(seen + text).slice(-PROBE_LENGTH * 4);
                if (seen.includes(probe)) reached = true;
            }
            return text;
        },

        transformTags: {
            // cid: references point at MIME parts, which mean nothing to a
            // browser. Rewriting them to the rendered photo is what keeps
            // embedded images working in Outlook and Apple Mail — the common
            // case for pasted photos, not an edge case.
            img: (tagName, attribs) => {
                const key = cidKey(attribs.src);
                const mapped = key ? cidMap.get(key) : null;

                // Ingest sees cid: references. An owner's edit sees HTML that
                // has already been through here once, so its photos are
                // /api/photo/ URLs with no cid: left to map -- and without
                // this they would lose their src here and then be dropped
                // outright by exclusiveFilter below, so correcting one typo
                // would silently delete every picture in the letter. Pinned to
                // the caller's own slug, so an edit cannot reach for the
                // photos of a site the editor does not own.
                const own =
                    !mapped &&
                    keepPhotoPrefix &&
                    String(attribs.src ?? '').startsWith(keepPhotoPrefix)
                        ? attribs.src
                        : null;

                const src = mapped ?? own;
                return {
                    tagName,
                    attribs: src ? { src, alt: attribs.alt ?? '' } : { alt: attribs.alt ?? '' }
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
            if (frame.tag === 'hr') {
                rules.push(frame.tagPosition);
                return false;
            }
            if (frame.tag === 'br') {
                breaks.push(frame.tagPosition);
                return false;
            }
            if (dropHeaders && isQuotedHeaderBlock(frame.text, probe)) {
                if (!reached) preamble = frame.tagPosition;
                return forget(frame.tagPosition);
            }

            // Nesting resolves in a single pass: a parent's `text` is the text
            // of its whole subtree, so a <div> wrapping nothing but empty
            // paragraphs reads as empty in the same sweep that removes them.
            // `&nbsp;` has already been decoded to a space by this point, so
            // trimming catches it.
            if (EMPTY_BLOCKS.has(frame.tag) && !frame.text.trim() && !frame.mediaChildren.length) {
                const held = (position) => position >= frame.tagPosition;
                if (!rules.some(held) && !(started && breaks.some(held))) {
                    return forget(frame.tagPosition);
                }
            }
            return false;
        }
    });

    // A removed block truncates the output back to where it opened, so the
    // header block's position is exactly where the letter now begins. Slicing
    // there can orphan the closing tag of a wrapper that opened above it,
    // which is why the fragment goes back through the parser rather than being
    // patched: it is already sanitized, so this pass only rebalances tags.
    const clean = preamble ? sanitizeHtmlLib(walked.slice(preamble), REBALANCE) : walked;

    // Whatever the removed blocks were indented with is left behind between
    // the surviving tags. It renders as nothing, so this only tidies the ends.
    //
    // The break blocks kept above are the other half of the same tidying. A
    // break is a separator, and one with nothing after it separates nothing --
    // but `exclusiveFilter` closes tags in order and cannot see whether more
    // of the letter is coming, so the only place to answer that is here, on
    // finished output. Repeated until stable because removing an inner block
    // leaves an empty wrapper that is now itself last.
    let trimmed = clean.trim();
    for (let previous = ''; previous !== trimmed; ) {
        previous = trimmed;
        trimmed = trimmed.replace(TRAILING_BLANK, '').trim();
    }
    return trimmed;
}

// The URL the reader fetches a rendition from. Kept here so the sanitizer and
// the render pipeline cannot disagree about the shape of a photo link.
export const photoUrl = (slug, photoId, size) => `${PHOTO_PREFIX}${slug}/${photoId}/${size}.webp`;
