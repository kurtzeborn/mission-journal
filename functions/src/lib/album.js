// Album links, and taking them back out of a letter.
//
// A missionary with more pictures than an email will carry shares one album
// and pastes its link into every letter for two years. Measured across the
// first four archives: 84 of 98 letters carried one, exactly one link each,
// and each missionary used a single album for their whole mission.
//
// The link is worth keeping once and not eighty-four times. It is also
// perishable in a way the letters are not -- the share stops resolving once
// the account behind it is no longer a missionary account -- so what a printed
// book would preserve is a URL that will already be dead when it is read. The
// URL is recorded on the site row; the letters lose it.
//
// This replaced a detection-only flag that recorded which service a letter
// linked to. That flag existed to answer how often this happens and to which
// service, and it answered: always Google Photos, never Drive, not once in
// eighty-four letters. A question that has been answered stops earning its
// place on every post record.

// Anchored immediately after the scheme, so a host appearing later in a path
// cannot match. That is not sufficient on its own -- `photos.google.com@evil`
// puts the real host after an `@` and still matches here -- which is why
// anything recorded is parsed and checked below.
const URL_SOURCE = String.raw`https?:\/\/(?:photos\.app\.goo\.gl|photos\.google\.com)[^\s"'<>]*`;

const HOSTS = ['photos.app.goo.gl', 'photos.google.com'];

// A link written inline in prose collects the punctuation that ended the
// sentence. Trimmed only where the URL is being *kept*; the removal side is
// happy to take a trailing period with it.
const TRAILING = /[.,;:!?)\]]+$/;

/**
 * Every distinct album URL a letter mentions.
 *
 * @param {string|null} body HTML or plain text
 * @returns {string[]} sorted, deduplicated; empty when nothing matched
 */
export function albumUrls(body) {
    if (!body) return [];

    const found = new Set();

    for (const [match] of String(body).matchAll(new RegExp(URL_SOURCE, 'gi'))) {
        const url = match.replace(TRAILING, '');
        try {
            if (HOSTS.includes(new URL(url).hostname.toLowerCase())) found.add(url);
        } catch {
            // Not a URL once the punctuation came off. Nothing to record.
        }
    }

    return [...found].sort();
}

// The longest genuine label observed is 53 characters -- "Link for the
// (currently very empty) google photo album" -- and the shortest sentence
// whose tail merely happens to end in one is 67. Sixty sits in that gap with
// room on both sides, and is a ceiling rather than a guess: a label is a
// caption, and a caption that runs longer than this is prose.
const LABEL_MAX = 60;

// A full stop, bang or question mark anywhere but the end means more than one
// sentence, which means the run is writing rather than a caption.
const MID_SENTENCE = /[.!?](?!\s*$)/;

const NAMES_PICTURES = /photo|foto|album|picture|link/i;

const HAS_WORDS = /[\p{L}\p{N}]/u;

/**
 * Whether the text run immediately before a link is a label for it.
 *
 * Three conditions, and all three are needed. Length alone would delete "If
 * you want to see the video of the truck and motorcycles then join the photo
 * album:", which contains no mid-sentence punctuation and is eighty-three
 * characters of somebody's writing. Punctuation alone would delete the same
 * line. And neither catches a run that is only an emoji and a colon, which is
 * a label in every sense except that it names nothing.
 */
const isLabel = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (trimmed.length > LABEL_MAX) return false;
    if (MID_SENTENCE.test(trimmed)) return false;
    if (!HAS_WORDS.test(trimmed)) return true;
    return NAMES_PICTURES.test(trimmed);
};

// A sentence that introduced the link is kept, but its colon now points at
// nothing. A full stop is what the sentence would have ended with had the link
// never been there.
const soften = (text) => text.replace(/:(\s*)$/, '.$1');

// Markup and space that may sit between a label and its link without either
// ceasing to belong to the other. Structural and inline tags only: an <img> or
// a <table> between the two means they are not a pair.
const BETWEEN = String.raw`(?:\s|<\/?(?:p|div|span|br|b|i|u|em|strong|font)\b[^>]*>)*`;

// The link itself, as an anchor with everything it wraps, or bare in text. The
// anchor form has to take the whole element: its visible text is the URL
// again, and leaving that behind would remove the link and print it anyway.
const LINK = `(?:<a\\b[^>]*href\\s*=\\s*["']?${URL_SOURCE}["']?[^>]*>[\\s\\S]*?<\\/a>|${URL_SOURCE})`;

// Group one is the text since the last tag, which is exactly "the line before"
// in markup that has no lines. It cannot run past a tag boundary, so it can
// never swallow a paragraph it does not belong to. A blank line stops it for
// the same reason: a plain-text letter has no tags at all, and without this
// the run would reach back to the greeting and no label would ever be short
// enough to recognise.
const RUN = String.raw`(?:(?!\n\s*\n)[^<>])*`;
const LABEL_AND_LINK = `(${RUN})(${BETWEEN})(${LINK})`;

/**
 * Remove album links, and the labels that introduce them, from a letter.
 *
 * Works on HTML and on plain text, because a letter with no HTML part never
 * reaches the sanitizer and a control that covered only one of them would be
 * one forwarded plain-text mail away from useless.
 *
 * Removing a label empties the block that held it. That block is left behind
 * on purpose -- this runs before the sanitizer parses anything, and dropping
 * empty blocks is already the sanitizer's job.
 *
 * @param {string|null} value
 * @param {object} [options]
 * @param {(removed: {label: string, link: string}) => void} [options.onRemove]
 *   called for each link taken out, with the label if one went with it. Exists
 *   so the backfill can print what it is about to delete: this is the one pass
 *   in the system that removes words somebody wrote, and it runs once.
 * @returns {string|null} the same type it was given
 */
export function stripAlbumLinks(value, { onRemove = null } = {}) {
    if (value == null) return value;

    return String(value).replace(
        new RegExp(LABEL_AND_LINK, 'gi'),
        (whole, label, between, link) => {
            const drop = isLabel(label);
            onRemove?.({ label: drop ? label.trim() : '', link });

            return drop
                ? // Whitespace around the tags goes with the label. Left in, it
                  // would hold open the very block the label used to fill.
                  between.replace(/>\s+</g, '><').trim()
                : `${soften(label)}${between}`;
        }
    );
}
