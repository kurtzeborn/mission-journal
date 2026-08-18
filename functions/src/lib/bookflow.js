// Turning a sanitized letter into blocks a printed page can be built from.
//
// This is the translation step the plan calls for, and it is deliberately a
// translation rather than a rendering. The alternative -- driving headless
// Chromium over the reader's own CSS -- produces a photograph of a web page,
// and a web page is the wrong artifact: it has no facing pages, no gutter, no
// running heads, and it hyphenates nothing. It is also a 300 MB dependency
// with cold starts measured in tens of seconds, against a Consumption plan.
//
// So the letter is taken apart into blocks with semantic names, and the page
// builder decides what each one looks like in a book. What is given up is
// exotic inline styling from a mail client -- and the reader already fights
// that, because `sanitize.js` strips every attribute off `div` and `span`
// precisely so an Outlook signature cannot dictate typography. There is no
// styling left here to lose.
//
// **Everything this reads has already been through `sanitizeBody`.** That is
// what makes the tag list below closed rather than defensive: it is the same
// allowlist, and anything outside it cannot arrive. This file must never be
// pointed at raw email.

import { Parser } from 'htmlparser2';
import { PHOTO_PREFIX } from './sanitize.js';

// Tags that end whatever was being written and start something new. `td` and
// `th` are in here for the reason `sanitize.js` keeps tables at all: Outlook
// wraps ordinary prose in table layout, so cells routinely hold real
// sentences. They become paragraphs.
//
// Real tabular data does exist in letters -- a transfer list, a set of
// mission stats -- and it comes out as consecutive paragraphs rather than as
// a grid. That is a known loss and an accepted one: laying out arbitrary
// email table markup, with its colspans and its nesting, is a book-typesetting
// problem of its own, and the payoff is a handful of tables across an entire
// mission. It can be revisited when a real archive produces one that matters.
const BLOCK = new Set([
    'p', 'div', 'li', 'dt', 'dd', 'td', 'th', 'caption',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'tr'
]);

const HEADING = /^h([1-6])$/;

// Containers that push their contents further from the margin. `dl` counts:
// a definition list reads as an indented structure whatever the tag says.
const INDENT = new Set(['ul', 'ol', 'blockquote', 'dl']);

// Inline tags mapped to the flag they set on every run inside them. `strike`
// and `s` are the same instruction written twice, as are `b`/`strong` and
// `i`/`em`, because both spellings survive sanitization and mail clients emit
// both.
// `code` is deliberately absent. The book has one family and no monospace
// face, so a `mono` flag would be a run property nothing could ever draw. The
// part of preformatting that carries meaning -- the spacing it was written
// with -- is preserved by the `pre` block kind instead, which needs no
// typeface to be honest about it.
const STYLE = {
    b: 'bold', strong: 'bold',
    i: 'italic', em: 'italic',
    u: 'underline',
    s: 'strike', strike: 'strike',
    small: 'small', sub: 'small', sup: 'small'
};

// Collapses runs of whitespace to a single space, the way a browser does.
// Email HTML is full of newlines and indentation that mean nothing, and
// carrying them into a justified column produces gaps in the middle of
// sentences. `pre` is excluded from this below, which is its whole point.
const squeeze = (text) => text.replace(/\s+/g, ' ');

const EMPTY_RUNS = (runs) => runs.every((run) => !run.text.trim());

/**
 * The photo id inside one of our own image URLs, or null for anything else.
 *
 * Letters can contain images that are not ours -- a tracking pixel that beat
 * the size filter, a logo hotlinked from a newsletter. Those have no bytes in
 * `rendered/` and nothing to print, so they are dropped rather than left as a
 * gap. Matching on our prefix is what distinguishes the two, and it is the
 * same prefix the reader keys on.
 */
export function photoIdFromSrc(src, slug) {
    const value = String(src ?? '');
    const prefix = `${PHOTO_PREFIX}${slug}/`;
    if (!value.startsWith(prefix)) return null;

    const id = value.slice(prefix.length).split('/')[0];
    return id || null;
}

/**
 * Take a sanitized letter body apart into printable blocks.
 *
 * Blocks are flat, never nested. Nesting is carried as an `indent` depth
 * instead, because a page builder walking a tree has to solve page breaks
 * recursively -- a quote splitting across a page boundary means unwinding and
 * resuming an arbitrary stack -- while a flat list breaks anywhere between two
 * entries. The book only ever needs to know how far from the margin something
 * sits, and a number says that completely.
 *
 * @param {string} html sanitized `bodyHtml`
 * @param {string} slug the site the letter belongs to, for photo URLs
 * @returns {object[]} blocks in reading order
 */
export function flowBody(html, slug) {
    const blocks = [];

    let runs = [];
    let kind = 'para';
    let level = 0;
    let indent = 0;
    let marker = null;

    // Style flags as counters rather than booleans. `<b>a<b>b</b>c</b>` is
    // malformed but arrives anyway, and a boolean would switch bold off at
    // the inner close and leave "c" upright.
    const style = { bold: 0, italic: 0, underline: 0, strike: 0, small: 0 };
    let preformatted = 0;
    let link = null;

    // One counter per open `ol`, so a numbered list inside a numbered list
    // restarts rather than continuing its parent's count.
    const ordinals = [];

    const flush = () => {
        if (runs.length && !EMPTY_RUNS(runs)) {
            blocks.push({ kind, level, indent, marker, runs });
        }
        runs = [];
        kind = 'para';
        level = 0;
        marker = null;
    };

    const write = (text) => {
        if (!text) return;
        runs.push({
            text,
            bold: style.bold > 0,
            italic: style.italic > 0,
            underline: style.underline > 0 || Boolean(link),
            strike: style.strike > 0,
            small: style.small > 0,
            link
        });
    };

    const parser = new Parser(
        {
            onopentag(name, attribs) {
                if (name === 'img') {
                    const id = photoIdFromSrc(attribs.src, slug);
                    if (!id) return;

                    // A photo interrupts the paragraph it was pasted into.
                    // Mail clients drop images inside `<p>` constantly, and
                    // the two halves of the surrounding sentence have to stay
                    // in order, so the first half is committed before the
                    // picture and the second starts a fresh block after it.
                    flush();
                    blocks.push({ kind: 'photo', photoId: id, indent });
                    return;
                }

                if (name === 'br') {
                    // A newline inside the run rather than a block boundary.
                    // Addresses and verse are written with `<br>` between
                    // lines and are one paragraph, not five.
                    write('\n');
                    return;
                }

                if (name === 'hr') {
                    flush();
                    blocks.push({ kind: 'rule', indent });
                    return;
                }

                if (name === 'a' && attribs.href) link = attribs.href;

                if (STYLE[name]) style[STYLE[name]] += 1;
                if (name === 'pre') preformatted += 1;

                if (INDENT.has(name)) {
                    flush();
                    indent += 1;
                    if (name === 'ol') ordinals.push(0);
                    return;
                }

                if (BLOCK.has(name)) {
                    flush();
                    kind = name === 'blockquote' ? 'quote' : name === 'pre' ? 'pre' : 'para';

                    const heading = HEADING.exec(name);
                    if (heading) {
                        kind = 'head';
                        level = Number(heading[1]);
                    }

                    if (name === 'li') {
                        kind = 'item';
                        if (ordinals.length) {
                            ordinals[ordinals.length - 1] += 1;
                            marker = `${ordinals[ordinals.length - 1]}.`;
                        } else {
                            marker = '\u2022';
                        }
                    }

                    // A definition term is the label of the pair below it,
                    // and reads as one. Bold rather than a heading, because a
                    // heading would claim a table-of-contents entry.
                    if (name === 'dt') style.bold += 1;
                }
            },

            ontext(text) {
                write(preformatted ? text : squeeze(text));
            },

            onclosetag(name) {
                if (name === 'a') link = null;
                if (STYLE[name]) style[STYLE[name]] = Math.max(0, style[STYLE[name]] - 1);
                if (name === 'pre') preformatted = Math.max(0, preformatted - 1);
                if (name === 'dt') style.bold = Math.max(0, style.bold - 1);

                if (INDENT.has(name)) {
                    flush();
                    indent = Math.max(0, indent - 1);
                    if (name === 'ol') ordinals.pop();
                    return;
                }

                if (BLOCK.has(name)) flush();
            }
        },
        { decodeEntities: true }
    );

    parser.write(String(html ?? ''));
    parser.end();
    flush();

    return trimEdges(blocks);
}

/**
 * Drop leading and trailing rules and empty space.
 *
 * Forwarded mail arrives wrapped in separators -- a horizontal rule above the
 * quoted header, another below the signature -- and in a book those land as a
 * line across the top of a chapter opening, which reads as a mistake rather
 * than as punctuation.
 */
function trimEdges(blocks) {
    let start = 0;
    let end = blocks.length;

    while (start < end && blocks[start].kind === 'rule') start += 1;
    while (end > start && blocks[end - 1].kind === 'rule') end -= 1;

    return blocks.slice(start, end);
}

/**
 * Every photo the letter places inline, in the order it places them.
 *
 * The album is what is left over: photos on the post that the body never
 * referred to. Splitting them this way is what keeps a picture next to the
 * sentence about it, which is the entire reason a printed letter is worth
 * more than a printed list of attachments.
 */
export function inlinePhotoIds(blocks) {
    return blocks.filter((block) => block.kind === 'photo').map((block) => block.photoId);
}
