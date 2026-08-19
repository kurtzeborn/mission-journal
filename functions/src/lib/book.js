// Setting the archive as a book.
//
// The reader is a scrolling column: one letter after another, newest at the
// top, as long as it needs to be. A book is the opposite of all three of
// those. It runs oldest-first, because a mission read back to front is a
// mission read backwards. It is cut into fixed rectangles whether the text
// wants that or not. And it has furniture a web page has never needed --
// running heads, folios, a gutter wide enough to survive being glued.
//
// **Pagination happens twice, from this same code.** The contents page has to
// print the page number each letter starts on, and that number is not known
// until the letters have been set -- by which time the contents page is long
// past. The usual escape is `bufferPages`, which keeps every page in memory
// until the end so earlier ones can be revisited; on a mission of four
// hundred photographs that is the entire book in a 2 GB instance, so it is
// not available here.
//
// Instead the whole book is set once with no photographs fetched, purely to
// find out where each letter lands, and then set again for real. The measuring
// pass is nearly free: `post.photos` already records each picture's width and
// height, so a photograph can occupy exactly the right rectangle without
// anyone reading its bytes. What makes this trustworthy is that both passes
// run the *same* function -- a separate "estimator" would be a second model
// of the layout, and the day it drifted the contents page would start lying
// by one page in a way nobody would notice until a book was printed.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import sharp from 'sharp';
import { flowBody, inlinePhotoIds } from './bookflow.js';
import { clothOf } from './cover.js';
import { fillLine, segments } from './typeset.js';

// pdfkit publishes no ESM entry point, so it comes in through require the way
// yazl does in archive.js.
const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');

const INCH = 72;

// US Letter hardcover, 8.5"x11". Not a preference -- it is the only portrait
// trim on Peecho's hardcover list that an American reader would recognise.
// They bind A5, A4, Letter, and two squares, and nothing else; the 8"x10"
// this file was first written against is not among them and never was, which
// is what comes of choosing a trim before choosing a printer.
//
// Held as points because that is the only unit a PDF has; every dimension
// below is derived from it rather than typed twice.
export const PAGE = { width: 8.5 * INCH, height: 11 * INCH };

// Asymmetric on purpose, and the asymmetry is the point. A hardcover's inner
// edge disappears into the binding, so the gutter margin has to be the widest
// one or the last few characters of every line curve out of sight. Peecho's
// floor is 10mm from the trim on all four sides; the narrowest here is an
// inch, which is nearly three times that.
//
// The extra half-inch of width Letter brought over the old trim went entirely
// into these rather than into the text, which is why `COLUMN` below is the
// same 444pt it has always been. A wider page is an argument for wider
// margins, not for longer lines: the measure was tuned to sixty-five
// characters because that is what reads well, and the page getting bigger
// does not change what reads well.
export const MARGIN = { top: 66, bottom: 72, inside: 96, outside: 72 };

export const COLUMN = PAGE.width - MARGIN.inside - MARGIN.outside;
const TEXT_BOTTOM = PAGE.height - MARGIN.bottom;

// Crimson Text: an old-style book face, OFL licensed, shipped in the repo.
//
// It is here rather than being one of pdfkit's built-in fonts because the
// built-ins are the PDF Standard 14, which are by definition *not* embedded --
// they name a font and trust the reader to own it. Peecho asks for every font
// embedded, as every printer does, so the choice was never between faces, it
// was between shipping one and having no book.
const FACES = {
    regular: 'CrimsonText-Regular.ttf',
    bold: 'CrimsonText-Bold.ttf',
    italic: 'CrimsonText-Italic.ttf',
    semibold: 'CrimsonText-SemiBold.ttf'
};

const face = (name) => readFileSync(new URL(`../assets/book/${name}`, import.meta.url));

// Read once per process. Together they are about 440 KB and every book uses
// the same bytes.
const FONTS = Object.fromEntries(Object.entries(FACES).map(([key, file]) => [key, face(file)]));

// Crimson sets small for its point size -- it is a Garamond descendant, and
// those run about a size beneath a Times. Twelve on sixteen measures out to
// roughly sixty-five characters across this column, which is the middle of
// the range typography has agreed on for a book you read for an hour.
const BODY = { size: 12, leading: 16 };
const HEAD_SIZES = { 1: 16, 2: 14.5, 3: 13, 4: 12.5, 5: 12, 6: 12 };

// How far a picture may push the text off its own page. Without a ceiling a
// portrait photograph from a phone -- three by four, and every phone shoots
// it -- fills the column to well over the height of the page and lands alone
// on a sheet with a caption's worth of text stranded after it.
const PHOTO_MAX_HEIGHT = 0.62;

// How much of the front board a cover photograph takes, from the very top
// down. A little over half: enough that the picture is the first thing seen,
// and not so much that a long name has to be set small to fit under it.
// Exported for the thumbnail, which bands its picture the same way.
export const PLATE_HEIGHT = PAGE.height * 0.52;

// Contents entries per page, used to reserve the right number of leaves
// before anything is set. Deliberately a constant rather than something
// measured: the reservation has to be identical in both passes, and a value
// derived from the first pass would move in the second.
const CONTENTS_PER_PAGE = 32;

// The fewest sheets a hardcover can be bound from, counting the two covers,
// and it has to be an even number besides. Both are Peecho's rules rather
// than ours: below two dozen there is not enough paper for a spine to hold,
// and an odd count would leave the back cover printed on the wrong side of
// the last leaf. A book with less in it than this is padded up to it, which
// costs blank paper -- see `padToPrinter`, which explains why that is still
// the least bad answer.
export const SHEET_LEAST = 24;

// Front and back. Named because the number turns up in three unrelated sums
// -- the printer's floor, the page total, and the parity of the last leaf --
// and a bare 2 in any of them reads as a coincidence rather than as the same
// two sheets of card.
const COVERS = 2;

// The album that faces a letter. `MIN_ROW` is the point at which a row of
// photographs stops being a row of photographs and becomes a strip of
// thumbnails; below it the album spills onto another page instead of
// shrinking further.
const ALBUM_GAP = 10;
const ALBUM_MIN_ROW = 84;
const ALBUM_MOST = 6;
const ALBUM_LEAST = 2;

// Four by three when nothing was recorded. Ingest measures every photograph it
// stores, so this is for the handful that predate it -- and a picture with no
// shape still has to be given one, because the alternative is a division by
// zero in the middle of a page.
const aspectOf = (photo) =>
    photo?.width > 0 && photo?.height > 0 ? photo.width / photo.height : 4 / 3;

const BLACK = '#1a1a1a';
const QUIET = '#666666';

// What a press needs, and what a screen needs, and the gap between them is
// the whole reason there are two renditions of every book. At 300 the column
// carries about 1875 pixels; at 110 it carries 690, which is more than any
// laptop will show of a page and about a fifteenth of the file size.
const PRINT_DPI = 300;
const PROOF_DPI = 110;

// Written across every page of the reviewing copy.
//
// Diagonal, pale, and set over the text rather than under it, which is worth
// the machinery in `stampProof` further down. Under the text it would vanish
// beneath any photograph on the page, and a mark that is absent from exactly
// the pages somebody would want to steal is not a mark.
//
// The wording matters as much as the ink. "Draft" invites a reply about
// typos; this copy is not a draft of anything, it is the finished book at a
// resolution deliberately too low to print, and the sentence says so.
const PROOF = {
    text: 'PROOF \u00b7 NOT FOR PRINT',
    size: 34,
    ink: '#8a8a8a',
    opacity: 0.22,
    angle: -32,
    // Three courses down the page. One is easy to crop out of a screenshot;
    // filling the page would make the letters unreadable, which defeats the
    // point of showing somebody their book.
    rows: [0.26, 0.5, 0.74]
};

const INDENT_STEP = 18;

// A picture the letter mentioned, with the text running round it.
//
// The site floats these at 45% of its column. The book's column is 444pt,
// which is a good deal narrower, and the same share would leave about 34
// characters beside the picture -- right at the width where a paragraph stops
// being a paragraph and becomes a ladder of single words down the page. Two
// fifths leaves 37, which is the least that still reads as prose.
const FLOAT_SHARE = 0.4;
const FLOAT_GUTTER = 12;

// Characters of letter left after a picture, counted up to the next picture
// or the end. Below this there is not enough text to wrap and the float stops
// paying for itself -- three lines beside a photograph and then a mile of
// white -- so the picture is centred on its own instead.
//
// The site uses 250 against a wider column. The threshold has to rise as the
// column narrows, because the same number of characters makes more lines.
const FLOW_MIN = 320;

export const dateLine = (post) => {
    const stamp = String(post.originalDate ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) return '';

    const [year, month, day] = stamp.split('-').map(Number);
    const at = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(at.getTime())) return '';

    return at.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC'
    });
};

const shortDate = (post) => String(post.originalDate ?? '').slice(0, 10);

// A calendar day for the cover: "June 15, 2025". `dateLine` names the weekday
// too, which is what a letter wants over it and far more than a cover does.
// Exported for the thumbnail, which sets the same two dates in the same words.
export const coverDate = (stamp) => {
    const [year, month, day] = String(stamp).split('-').map(Number);
    const at = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(at.getTime())) return '';

    return at.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC'
    });
};

// Oldest first. `presentPosts` sorts newest-first because that is what a
// reader arriving at a live site wants; a book wants the mission in the order
// it was lived. Reversing the presented payload rather than re-sorting the
// raw one keeps the ACL filtering and the tie-breaking that payload already
// settled -- see present.js, which explains why that order is total.
export const inReadingOrder = (posts) => [...posts].reverse();

/**
 * How many pages the contents will occupy.
 *
 * Exported because both passes need the same answer, and a number this
 * load-bearing should be derived in one place rather than counted twice.
 */
export const contentsPages = (count) => Math.max(1, Math.ceil(count / CONTENTS_PER_PAGE));

/**
 * How far a page's contents slide to mirror the gutter.
 *
 * Recto and verso are mirror images: the gutter is on the left of a right-hand
 * page and on the right of a left-hand one. Getting this backwards produces a
 * book that looks fine on screen and is unreadable once bound, which is
 * exactly the class of mistake that only shows up after it has been printed.
 *
 * The mirroring is done by *moving the page*, not by moving the text box, and
 * that is not a stylistic choice -- it is the only version that works.
 *
 * The obvious implementation is to give each page its own left and right
 * margins and let pdfkit wrap inside them. It is wrong, and wrong invisibly:
 * pdfkit's line wrapper records the starting x when a block begins, and when
 * that block overflows onto the next page it puts the cursor back to the
 * recorded x rather than to the new page's margin (`LineWrapper.nextSection`).
 * So every paragraph that spanned a page break carried the previous page's
 * geometry with it, and the gutter landed on the wrong edge -- on roughly half
 * the pages of every letter longer than one. It took reading the coordinates
 * out of the rendered PDF to see it at all.
 *
 * Since both boxes are the same width, verso is simply recto slid left by the
 * difference between the margins. So the book is always set against one fixed
 * box, and left-hand pages are translated. One starting x, forever, and the
 * wrapper's bookkeeping becomes true by construction.
 */
export const mirror = (pageNumber) => (pageNumber % 2 === 1 ? 0 : -(MARGIN.inside - MARGIN.outside));

// The one text box everything is set against, before mirroring.
const LEFT = MARGIN.inside;

/**
 * Fetch a photograph and prepare it for print.
 *
 * `rendered/` holds WebP, and PDF cannot embed WebP at all -- so this is a
 * transcode, not a copy. It goes to JPEG rather than PNG because these are
 * photographs: PNG would store them losslessly at several times the size, and
 * a 400-photograph book has to travel to the printer as one file.
 *
 * Left in RGB rather than converted to CMYK because Peecho asks for RGB and
 * does its own separation -- a press profile they choose per facility beats
 * one guessed here.
 *
 * Resized down to what the page can actually show at 300 dpi. The stored
 * rendition is 2400px on its long edge, and a picture printed across this
 * column needs about 1875 -- so shipping the stored file unchanged would put
 * roughly a third more data in the book than any printer could resolve.
 * `withoutEnlargement` keeps a small picture from being blown up into
 * something blurry to satisfy an arithmetic target.
 */
export async function printPhoto({ store, slug, photoId, widthPoints, dpi = PRINT_DPI }) {
    const blob = await store.readBlob('rendered', `${slug}/photos/${photoId}/large.webp`);
    if (!blob) return null;

    return forPrint(Buffer.from(blob.bytes), { widthPoints, dpi });
}

/**
 * The same transcode, for bytes somebody has already fetched.
 *
 * Split out for the cover, whose picture may be one of the archive's
 * photographs or a file the owner uploaded that lives somewhere else
 * entirely. Everything about how a picture is prepared for a press belongs in
 * one place regardless of which folder it came out of.
 */
export function forPrint(bytes, { widthPoints, dpi = PRINT_DPI }) {
    const pixels = Math.round((widthPoints / INCH) * dpi);

    return sharp(bytes)
        .resize({ width: pixels, withoutEnlargement: true })
        .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
        .toBuffer();
}

/**
 * The rectangle a photograph will occupy, given what the page has left.
 *
 * Pure, and separate from drawing it, because the measuring pass needs the
 * geometry without the bytes. Both passes call this, so a photograph cannot
 * take a different amount of room in the book than it did in the reckoning
 * that produced the contents page.
 */
export function photoBox({ width, height, column = COLUMN }) {
    const ratio = width > 0 && height > 0 ? height / width : 0.75;
    const ceiling = (PAGE.height - MARGIN.top - MARGIN.bottom) * PHOTO_MAX_HEIGHT;

    let drawn = column;
    if (drawn * ratio > ceiling) drawn = ceiling / ratio;

    return { width: drawn, height: drawn * ratio };
}

/**
 * Write the proof mark across the page that is about to be left behind.
 *
 * Called on the way out of a page rather than on the way in, which is the
 * only way to get ink on top of the content while still streaming. Drawing it
 * from `pageAdded` would put it underneath, where a photograph hides it; the
 * usual alternative -- `bufferPages` and a second visit with
 * `switchToPage` -- keeps every page of the book in memory to the end, which
 * is the one thing this design exists to avoid.
 *
 * So the two methods that can end a page are wrapped instead, in `openBook`.
 */
function stampProof(doc) {
    // Nothing has been drawn yet: `autoFirstPage` is off, so the first
    // `addPage` has no outgoing page to mark.
    if (!doc.page) return;

    doc.save();

    // Zeroed for the same reason the furniture zeroes them. This writes clear
    // across the sheet, and pdfkit answers a write that crosses a margin by
    // adding a page -- from inside the call that was adding a page.
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
    doc.rotate(PROOF.angle, { origin: [PAGE.width / 2, PAGE.height / 2] });
    doc.font('semibold').fontSize(PROOF.size).fillColor(PROOF.ink).fillOpacity(PROOF.opacity);

    // Started half a page to the left and given twice the page's width, so
    // that centring the line centres it on the page rather than on the part
    // of the rotated axis that happens to fall inside the sheet.
    for (const row of PROOF.rows) {
        doc.text(PROOF.text, -PAGE.width / 2, PAGE.height * row, {
            width: PAGE.width * 2,
            align: 'center',
            lineBreak: false
        });
    }

    doc.restore();
}

/**
 * A document with the fonts registered and the furniture wired up.
 *
 * The running heads and folios are drawn from the `pageAdded` event rather
 * than being revisited at the end, which is what makes streaming possible:
 * once a page is written it is never needed again and can leave memory.
 */
function openBook({ title, state }) {
    const doc = new PDFDocument({
        size: [PAGE.width, PAGE.height],
        autoFirstPage: false,
        // Set on the file itself so the book is identifiable when it is a
        // loose PDF on somebody's desktop, which is how it reaches the
        // printer.
        info: { Title: title, Producer: 'Pday Letters' }
    });

    for (const [name, bytes] of Object.entries(FONTS)) doc.registerFont(name, bytes);

    // The two ways a page can be finished: another one starts, or the
    // document does. Wrapped rather than called from the dozen places that
    // add a page, because one of them would eventually be added without it
    // and the missing mark would be on whichever page somebody photographed.
    if (state.proof) {
        const addPage = doc.addPage.bind(doc);
        doc.addPage = (...args) => {
            stampProof(doc);
            return addPage(...args);
        };

        const end = doc.end.bind(doc);
        doc.end = (...args) => {
            stampProof(doc);
            return end(...args);
        };
    }

    doc.on('pageAdded', () => {
        // A cover is not a page of the book, and almost nothing below applies
        // to it. It takes no folio and no running head, it is not counted in
        // the numbering the contents page refers to, and it is not mirrored:
        // the front and back covers are printed on one wrapped sheet, so
        // neither of them has a gutter to lean away from. Bailing out here
        // rather than guarding each rule separately keeps the page count
        // meaning one thing -- leaves of the book -- everywhere else.
        if (state.cover) {
            // Margins zeroed for the same reason the furniture below zeroes
            // them, and it bit just as hard. A cover is drawn at absolute
            // positions, but pdfkit reads a write that crosses the bottom
            // margin as an overflow and answers it by adding a page -- from
            // inside this handler, while `state.cover` is still set, so the
            // new page is never counted. The line at the foot of the front
            // cover cleared the margin by a fraction of a point, which was
            // enough to put a twenty-fifth sheet in a twenty-four sheet book
            // that nothing in the returned page total knew about.
            doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
            doc.x = MARGIN.outside;
            doc.y = MARGIN.top;
            doc.fillColor(BLACK);
            return;
        }

        state.page += 1;
        const recto = state.page % 2 === 1;

        // A float belongs to one sheet of paper. Cleared here rather than at
        // the half-dozen places that add a page, because one of them would
        // eventually forget and the text on the new page would then flow
        // around a picture that is not on it.
        state.float = null;

        // Everything on a left-hand page, furniture included, slides across
        // together. Applied before anything is drawn, and never undone,
        // because each page carries its own content stream and starts from an
        // untransformed one.
        const shift = mirror(state.page);
        if (shift) doc.translate(shift, 0);

        // Zeroed while the furniture is drawn, and set properly afterwards.
        // The running head sits above the top margin and the folio below the
        // bottom one, which is what makes them furniture rather than text --
        // but pdfkit reads a write outside the margins as an overflow and
        // answers it by adding a page, from inside the handler that runs when
        // a page is added. That recursion ends in a stack overflow, and it
        // does so only once a document is long enough to need a second page.
        doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

        // Front matter carries no furniture. A running head over a title page
        // is a printing error rather than a feature, and a folio on the
        // contents would number pages that are not yet the book.
        //
        // Neither does a page left blank to bring the next letter round onto
        // a left-hand page. A blank leaf with a page number on it reads as a
        // page whose contents failed to print.
        if (state.furniture && !state.blank) {
            // A chapter opening takes the folio but not the running head. The
            // head answers "where am I" on a page that has already told you,
            // in nineteen-point type an inch below it -- so on this one page
            // it is noise, and every printed book leaves it off.
            if (!state.opening) {
                doc.font('italic').fontSize(9.5).fillColor(QUIET);
                doc.text(recto ? state.head : title, LEFT, MARGIN.top - 30, {
                    width: COLUMN,
                    align: recto ? 'right' : 'left',
                    lineBreak: false
                });
            }

            // The folio *is* the physical page number, front matter included
            // in the count even though it prints none of its own. Numbering
            // the letters separately from page one was the first arrangement
            // and it put odd numbers on left-hand pages, which is the one
            // thing about page numbers everybody notices without being able
            // to say why it looks wrong.
            doc.font('regular').fontSize(10).fillColor(QUIET);
            doc.text(String(state.page), LEFT, PAGE.height - MARGIN.bottom + 26, {
                width: COLUMN,
                align: 'center',
                lineBreak: false
            });

            state.opening = false;
        }

        doc.page.margins = {
            top: MARGIN.top,
            bottom: MARGIN.bottom,
            left: LEFT + state.indent,
            right: MARGIN.outside
        };

        // Drawing the furniture moved the cursor, and whatever is written
        // next expects to start at the top of the text box. Restored here
        // rather than at every call site, because there are a dozen of those
        // and one of them would eventually forget.
        doc.x = doc.page.margins.left;
        doc.y = MARGIN.top;
        doc.fillColor(BLACK);
    });

    return doc;
}

/**
 * The horizontal room a line has, given what is floating beside it.
 *
 * This is the whole of the float model, and it is deliberately the whole of
 * it: one picture at a time, rectangular, on one side. CSS has to cope with
 * several floats stacking, shapes that are not rectangles, and boxes that
 * establish new contexts. A letter home has one photograph in the margin.
 *
 * A line clears the picture when it starts below it. It does not have to
 * clear it to *begin* below it -- a line whose top is above the picture's
 * bottom is still beside it, even if most of the line hangs below -- which is
 * why the test is on the line's top edge and not its middle.
 */
export function reserve({ float, y, height, indent = 0 }) {
    const x = LEFT + indent;
    const width = COLUMN - indent;

    if (!float || y + height <= float.top || y >= float.bottom) return { x, width };

    const taken = float.width + FLOAT_GUTTER;
    return float.side === 'left' ? { x: x + taken, width: width - taken } : { x, width: width - taken };
}

/**
 * Underline and strikethrough, drawn by hand.
 *
 * pdfkit will do both from options on `doc.text`, and it must not be allowed
 * to. It sizes each rule from `options.textWidth`, a field only its line
 * wrapper fills in, and nothing in this book goes through the wrapper -- so
 * the option puts NaN into the path and the document explodes at `end()`,
 * thousands of lines of layout after the letter that carried the tag. The
 * same trap swallows the `link` option, which is placed beside these for the
 * same reason. Third instance of the same lesson: any pdfkit feature that
 * reads wrapper state is off limits in this file.
 *
 * The geometry is pdfkit's own, copied rather than invented, so that a rule
 * in the book sits where the reader's browser would have put it.
 */
function setRule(doc, { run, x, y, width, size, color }) {
    if (!run?.underline && !run?.strike) return;

    const thickness = size < 10 ? 0.5 : Math.floor(size / 10);
    const height = doc.currentLineHeight();

    doc.save().lineWidth(thickness).strokeColor(color);
    if (run.underline) {
        doc.moveTo(x, y + height - thickness).lineTo(x + width, y + height - thickness).stroke();
    }
    if (run.strike) {
        doc.moveTo(x, y + height / 2).lineTo(x + width, y + height / 2).stroke();
    }
    doc.restore();
}

/**
 * Set styled runs down the page, one line at a time.
 *
 * This replaces what pdfkit does for you, and it has to, because pdfkit's own
 * `text` takes a single width for a whole call: it has no notion of a line
 * being narrower than the one above it, which is all a float is. There is no
 * package that fills the gap either -- everything in reach either has no
 * layout at all or needs a browser to get one.
 *
 * So: ask where this line may go, fill it, draw it, move down, repeat. Each
 * piece is drawn at an explicit x with `lineBreak: false`, so pdfkit never
 * makes a wrapping decision and never carries a stale one across a page
 * break, which is the failure the first version of this file shipped with.
 */
function setLines(doc, runs, options = {}) {
    const { state } = options;
    const size = options.size ?? BODY.size;
    const leading = options.leading ?? BODY.leading;
    const indent = options.indent ?? 0;
    const color = options.color ?? BLACK;

    const dress = (run) => {
        const font = run?.bold ? 'bold' : run?.italic ? 'italic' : options.font ?? 'regular';
        doc.font(font).fontSize(run?.small ? size * 0.82 : size);
        return doc;
    };

    const measure = (text, run) => (text ? dress(run).widthOfString(text) : 0);
    const pieces = segments(runs);
    const room = () => reserve({ float: state.float, y: doc.y, height: leading, indent });

    // An orphan: the first line of a paragraph left alone at the foot of a
    // page while the rest of it turns over. Cheap to prevent here because
    // nothing has been drawn yet -- start the paragraph on the next page
    // instead, unless it was only one line long anyway.
    if (pieces.length && doc.y + leading * 2 > TEXT_BOTTOM) {
        if (fillLine(pieces, 0, { measure, width: room().width }) < pieces.length) turnPage(doc, state);
    }

    let at = 0;
    while (at < pieces.length) {
        if (doc.y + leading > TEXT_BOTTOM) turnPage(doc, state);

        const band = room();
        let to = fillLine(pieces, at, { measure, width: band.width });

        // A widow: the last line of a paragraph alone at the top of the next
        // page. Caught with a single line of lookahead -- if this line is the
        // last that fits here and exactly one follows, both go over together.
        if (to < pieces.length && doc.y + leading * 2 > TEXT_BOTTOM) {
            if (fillLine(pieces, to, { measure, width: band.width }) >= pieces.length) {
                turnPage(doc, state);
                continue;
            }
        }

        let x = band.x;
        const y = doc.y;

        for (let n = at; n < to; n += 1) {
            const piece = pieces[n];
            const text = n === to - 1 ? piece.tail : piece.text;
            if (!text) continue;

            dress(piece.run).fillColor(color);
            doc.text(text, x, y, { lineBreak: false });

            const drawn = doc.widthOfString(text);
            const points = piece.run?.small ? size * 0.82 : size;
            setRule(doc, { run: piece.run, x, y, width: drawn, size: points, color });

            // The annotation rectangle is ours to compute because the
            // position is ours. See `setRule` for why pdfkit is not asked.
            if (piece.run?.link) doc.link(x, y, drawn, leading, piece.run.link);

            x += doc.widthOfString(piece.text);
        }

        doc.y = y + leading;
        at = to;
    }

    doc.fillColor(BLACK);
}

/**
 * Start a fresh page mid-text.
 *
 * A float never survives the turn. It is a picture on a particular sheet of
 * paper, and the text on the next sheet has the whole column to itself.
 */
function turnPage(doc, state) {
    doc.addPage();
    state.float = null;
}

/**
 * Put the page's text box where this block wants it.
 *
 * The indent is held on `state` rather than passed, because the handler that
 * runs when a page is added needs it too: a block that overflows has to land
 * inside the same indent on the page it continues onto.
 */
function setBox(doc, state, indent = 0) {
    state.indent = indent;

    doc.page.margins.left = LEFT + indent;
    doc.page.margins.right = MARGIN.outside;
    doc.x = LEFT + indent;
}

/**
 * Arrange photographs into rows that fill the width.
 *
 * The row height is what varies: pictures are added to a row until scaling
 * them to fill the column would push them below `target`, at which point the
 * row is closed and the next one starts. Every picture in a row shares a
 * height, every row is exactly the column wide, and nothing is cropped -- the
 * arrangement newspapers and photo albums have used for a century, for the
 * reason that it wastes no space and never distorts a face.
 *
 * Pure, and driven off the recorded dimensions rather than the files, because
 * the measuring pass has to reach the same arrangement without reading a
 * single byte.
 */
export function albumRows(photos, { target, width = COLUMN, gap = ALBUM_GAP }) {
    const rows = [];
    let row = [];
    let aspects = 0;

    for (const photo of photos) {
        row.push(photo);
        aspects += aspectOf(photo);

        const height = (width - gap * (row.length - 1)) / aspects;
        if (height <= target) {
            rows.push({ photos: row, height });
            row = [];
            aspects = 0;
        }
    }

    // The last row is short, so it keeps the target height rather than being
    // stretched across the column. A single leftover picture blown up to the
    // full width is the classic tell of a grid that stopped thinking.
    if (row.length) {
        rows.push({
            photos: row,
            height: Math.min(target, (width - gap * (row.length - 1)) / aspects)
        });
    }

    return rows;
}

const albumHeight = (rows) =>
    rows.reduce((total, row) => total + row.height, 0) + ALBUM_GAP * (rows.length - 1);

/**
 * The largest row height at which the whole album still fits one page.
 *
 * Searched rather than solved. The packing is a step function -- nudging the
 * target moves a picture between rows and the total height jumps -- so there
 * is no closed form to invert, and twenty-odd halvings settle it to well
 * under a point.
 */
export function albumTarget(photos, { height, width = COLUMN }) {
    let low = ALBUM_MIN_ROW;
    let high = height;

    if (albumHeight(albumRows(photos, { target: low, width })) > height) return low;

    for (let step = 0; step < 24; step += 1) {
        const mid = (low + high) / 2;
        if (albumHeight(albumRows(photos, { target: mid, width })) <= height) low = mid;
        else high = mid;
    }

    return low;
}

/**
 * Arrange one leaf's photographs to fill the page they have to themselves.
 *
 * `albumRows` packs to a width, which is the right answer for a run of
 * pictures sitting in a column of text: the column is the fixed thing and the
 * height falls out. On a leaf that owns the whole page it is the wrong
 * answer, and badly so. Two landscape photographs packed to the column come
 * out side by side, a hand's width tall, marooned in the middle of eleven
 * inches of paper -- because filling the column is the only rule the packer
 * knows, and two pictures fill it at a stroke. The reader did not ask for two
 * postage stamps; the page had room to make them nearly six inches each.
 *
 * So the leaf is arranged by trying every way of dealing its pictures into
 * bands, in the order they arrived, and keeping the best of them. Each band
 * is measured at full width, and the stack is scaled down as one if it is
 * taller than the page. Scaling the stack is what lets a band be *narrower*
 * than the column -- which is the whole trick, because that is the only way
 * height ever becomes the binding constraint and the only way a page of two
 * grows.
 *
 * The best is the one whose *smallest* picture is largest, rather than the
 * one covering the most paper. Covering the most paper sounds like the same
 * thing and is not: six photographs come out as two small and two large and
 * two small, because one picture blown up pays for two shrunk, and a page
 * with three sizes on it reads as a page that was arranged by an accident.
 * Judging a page by its worst picture equalises it, and lands on the answer
 * every photo album has used for a century -- six in three rows of two --
 * without having to name it.
 *
 * Bands are never widened past the column and pictures are never enlarged
 * beyond it, so nothing here can reach into a margin.
 *
 * Pure, and driven off the recorded dimensions rather than the files, because
 * the measuring pass has to reach the same arrangement without reading a
 * single byte.
 */
export function albumPlan(photos, { height, width = COLUMN, gap = ALBUM_GAP }) {
    if (!photos.length) return [];

    let best = null;

    for (let bands = 1; bands <= photos.length; bands += 1) {
        // `albumSpread` deals a list into runs of near-equal length keeping
        // the order, which is exactly what a band is; that it was written for
        // pages is an accident of where it was needed first.
        const rows = albumSpread(photos, { pages: bands }).map((band) => {
            const aspects = band.reduce((sum, photo) => sum + aspectOf(photo), 0);
            return { photos: band, height: (width - gap * (band.length - 1)) / aspects };
        });

        const stack = rows.reduce((sum, row) => sum + row.height, 0);
        const scale = Math.min(1, (height - gap * (bands - 1)) / stack);

        const least = Math.min(
            ...rows.flatMap((row) =>
                row.photos.map((photo) => (row.height * scale) ** 2 * aspectOf(photo))
            )
        );

        if (best && least <= best.least) continue;
        best = {
            least,
            rows: rows.map((row) => ({ photos: row.photos, height: row.height * scale }))
        };
    }

    return best.rows;
}

/**
 * How many leaves to give a letter's album.
 *
 * Two jobs at once. The first is restraint: past half a dozen pictures a page
 * stops being a plate and starts being a contact sheet, and these are
 * photographs somebody's family sent from the other side of the world.
 *
 * The second is parity. Every letter opens on a verso, so a letter whose text
 * and album come to an odd number of pages forces a blank leaf before the
 * next one -- and across a hundred letters that is fifty sheets of nothing
 * that the reader pays the printer for. Spreading the same pictures over one
 * more page costs no paper at all, because the paper was going to be spent
 * either way, and it makes the pictures bigger into the bargain. So the
 * smallest legal spread that comes out even wins.
 *
 * When no legal spread is even -- two photographs after a two-page letter,
 * say -- the tightest one is used and the blank leaf is accepted. There is
 * nowhere else for the page to come from.
 */
export function albumPageCount(count, { textPages = 1 } = {}) {
    if (count < 1) return 0;

    const least = Math.ceil(count / ALBUM_MOST);
    const most = Math.max(least, Math.floor(count / ALBUM_LEAST));

    for (let pages = least; pages <= most; pages += 1) {
        if ((textPages + pages) % 2 === 0) return pages;
    }

    return least;
}

/**
 * Deal the photographs out over that many pages, as evenly as they go.
 *
 * Order is kept, because the order is the order they were attached in and
 * that is usually the order they were taken in.
 */
export function albumSpread(photos, { pages }) {
    const out = [];
    let taken = 0;

    for (let page = 1; page <= pages; page += 1) {
        const upTo = Math.round((photos.length * page) / pages);
        out.push(photos.slice(taken, upTo));
        taken = upTo;
    }

    return out;
}

/**
 * Bring the next page round onto a left-hand one.
 *
 * Every letter opens on a verso so that a letter short enough to fit a single
 * page has its own photographs facing it across the spread -- which is most
 * of them. The cost is a blank leaf whenever a letter and its album come to
 * an odd number of pages, and that cost is real: it is paper, and the reader
 * pays the printer for it.
 */
function padToVerso(doc, state) {
    if ((state.page + 1) % 2 === 0) return;

    state.blank = true;
    doc.addPage();
    state.blank = false;
}

/**
 * Blank leaves at the end, up to what the printer will actually bind.
 *
 * Two rules, and both of them are the press's rather than the book's. The
 * page count including covers has to be even, because the leaves are printed
 * on both sides and there is no half a sheet of paper. And it has to reach
 * `SHEET_LEAST`, because a spine needs a certain thickness of paper to hold
 * at all.
 *
 * Padding is not the obvious answer -- refusing to print a book with three
 * letters in it would be tidier, and would spend nobody's money on blank
 * paper. But the threshold is not three letters, it is twenty-two pages, and
 * that is not a number anybody can be told in advance: it depends on how long
 * the letters run and how many photographs they carry, which is not known
 * until the book has been set. A reader who is told "not yet" would have no
 * way to find out how much more was needed. Blank leaves at the back of a
 * thin book are what every short print-on-demand title has always done.
 */
function padToPrinter(doc, state, least) {
    // Zero means there is no printer -- both rules below are the press's, so
    // both go together, and code measuring the layout itself wants neither.
    if (!least) return;

    const wanted = Math.max(least - COVERS, 0);

    while (state.page < wanted || state.page % 2 !== 0) {
        state.blank = true;
        doc.addPage();
        state.blank = false;
    }
}

/**
 * Set one letter, opening on a left-hand page.
 *
 * `images` is a map of photo id to JPEG buffer, and is empty for the whole of
 * the measuring pass. Nothing else differs between the passes, which is the
 * entire reason the contents page can be trusted.
 *
 * @returns {number} the page the letter opened on
 */
function setLetter(doc, { post, slug, images, state }) {
    padToVerso(doc, state);

    // All three set before the page is added, because the handler draws the
    // furniture and places the text box the moment it is, and cannot be told
    // any of this afterwards.
    state.head = shortDate(post) || post.subject || '';
    state.opening = true;
    state.indent = 0;
    doc.addPage();

    const opened = state.page;

    // A chapter opening drops below the top margin. It is the oldest signal
    // in book typography that something has started, and it costs an inch of
    // a page that was starting anyway.
    doc.y = MARGIN.top + 40;

    doc.font('semibold').fontSize(19).fillColor(BLACK);
    doc.text(post.subject || 'Untitled', LEFT, doc.y, { width: COLUMN, lineGap: 3 });

    const written = dateLine(post);
    if (written) {
        doc.font('italic').fontSize(10.5).fillColor(QUIET);
        doc.text(written, LEFT, doc.y + 3, { width: COLUMN });
    }

    doc.y += 20;
    doc.fillColor(BLACK);

    const blocks = flowBody(post.bodyHtml ?? '', slug);
    const shot = (id) => (post.photos ?? []).find((photo) => photo.id === id) ?? { id };
    const placed = new Set();

    // Pictures alternate sides down a letter and the first one hangs left.
    state.side = 'left';

    for (let n = 0; n < blocks.length; n += 1) {
        const block = blocks[n];

        if (block.kind !== 'photo') {
            setBlock(doc, { block, state });
            continue;
        }

        // Pictures with nothing between them are one thing, not several. Left
        // as separate floats they would alternate sides down the page with a
        // line of text wedged between, which is not what somebody who pasted
        // three photographs in a row meant. The reader gathers them into a
        // row; so does this.
        const run = [];
        while (n < blocks.length && blocks[n].kind === 'photo') {
            run.push(shot(blocks[n].photoId));
            placed.add(blocks[n].photoId);
            n += 1;
        }
        n -= 1;

        if (run.length > 1 || textAfter(blocks, n) < FLOW_MIN) {
            setPlate(doc, { photos: run, images, state });
            continue;
        }

        setFloat(doc, { photoId: run[0].id, meta: run[0], images, state });
    }

    // Whatever the last float was, the letter ends below it rather than
    // beside it -- the album that may follow is a fresh page anyway, but the
    // page count this letter reports has to include the picture.
    if (state.float) doc.y = Math.max(doc.y, state.float.bottom);
    state.float = null;

    // Anything attached but never placed in the text. The reader shows these
    // as an album under the letter and the book gives them the facing page,
    // for the same reason: they belong to this letter and to no other, and
    // dropping them would lose pictures the family sent.
    setAlbum(doc, {
        photos: (post.photos ?? []).filter((photo) => !placed.has(photo.id)),
        textPages: state.page - opened + 1,
        images,
        state
    });

    return opened;
}

/**
 * The photographs a letter carried but never mentioned, given their own page.
 *
 * Starts a page rather than continuing under the text, which is what makes
 * the spread work: a letter that fits one page is on the left and its
 * pictures are on the right, facing it. A longer letter still gets its album,
 * just further along.
 */
function setAlbum(doc, { photos, textPages, images, state }) {
    if (!photos.length) return;

    setBox(doc, state, 0);

    const usable = PAGE.height - MARGIN.top - MARGIN.bottom;
    const pages = albumPageCount(photos.length, { textPages });

    for (const leaf of albumSpread(photos, { pages })) {
        doc.addPage();
        setLeaf(doc, { photos: leaf, images, usable });
    }

    doc.fillColor(BLACK);
}

/**
 * One page of an album.
 */
function setLeaf(doc, { photos, images, usable }) {
    const rows = albumPlan(photos, { height: usable });

    // Centred both ways. Vertically because an arrangement can still come up
    // short of the page -- six pictures of the same shape tile it almost
    // exactly, four rarely do -- and pushed to the top that reads as a page
    // that ran out. Horizontally because a band scaled down to make the stack
    // fit is narrower than the column, and a short band hanging off the
    // gutter edge reads as a mistake rather than as a plate.
    const total = albumHeight(rows);
    let y = MARGIN.top + (total < usable ? (usable - total) / 2 : 0);

    for (const row of rows) {
        const widths = row.photos.map((photo) => row.height * aspectOf(photo));
        const band = widths.reduce((sum, width) => sum + width, 0) + ALBUM_GAP * (row.photos.length - 1);

        let x = LEFT + (COLUMN - band) / 2;

        row.photos.forEach((photo, index) => {
            drawImage(doc, {
                bytes: images.get(photo.id),
                x,
                y,
                width: widths[index],
                height: row.height
            });

            x += widths[index] + ALBUM_GAP;
        });

        y += row.height + ALBUM_GAP;
    }

    doc.y = y;
}

function setBlock(doc, { block, state }) {
    const indent = block.indent * INDENT_STEP;
    setBox(doc, state, indent);
    const x = LEFT + indent;
    const width = COLUMN - indent;

    // Only running prose wraps round a picture. A list beside a float puts
    // the marker on one edge of the page and the item it belongs to on the
    // other; a heading beside one reads as a caption it is not. So anything
    // with structure of its own clears the picture and starts underneath, the
    // same call `clear` makes on the site.
    if (block.kind !== 'para' && state.float) {
        doc.y = Math.max(doc.y, state.float.bottom);
        state.float = null;
    }

    if (block.kind === 'rule') {
        if (doc.y + 26 > TEXT_BOTTOM) turnPage(doc, state);
        doc.y += 8;
        doc.strokeColor('#cccccc')
            .lineWidth(0.5)
            .moveTo(x + width * 0.35, doc.y)
            .lineTo(x + width * 0.65, doc.y)
            .stroke();
        doc.y += 14;
        return;
    }

    if (block.kind === 'head') {
        const size = HEAD_SIZES[block.level] ?? 13;
        doc.y += 10;
        setLines(doc, block.runs, { state, font: 'semibold', size, leading: size + 4, indent });
        doc.y += 4;
        return;
    }

    if (block.kind === 'item') {
        // The marker hangs in the indent rather than sitting in the text, so
        // the second line of a long bullet lines up under the first word and
        // not under the bullet.
        const top = doc.y;
        doc.font('regular').fontSize(BODY.size).fillColor(BLACK);
        doc.text(block.marker ?? '\u2022', x, top, { width: INDENT_STEP - 4, lineBreak: false });

        doc.y = top;
        setLines(doc, block.runs, { state, indent: indent + INDENT_STEP });
        doc.y += 3;
        return;
    }

    if (block.kind === 'quote') {
        setLines(doc, block.runs, { state, font: 'italic', color: '#444444', indent });
        doc.y += 7;
        return;
    }

    // `pre` is set in the text face, because there is no other one. The
    // spacing carried the meaning; the typeface never did.
    const pre = block.kind === 'pre';
    setLines(doc, block.runs, { state, size: pre ? BODY.size - 1 : BODY.size, indent });
    doc.y += pre ? 7 : 8;
}

/**
 * Draw a picture into a rectangle, or reserve the rectangle if it is missing.
 *
 * The measuring pass has no bytes for anything, and once in a while a
 * rendition has genuinely gone. Both want the same rectangle held: the first
 * so the contents page is right, the second so a lost picture leaves an
 * obvious gap rather than silently reflowing the book around it.
 *
 * The rectangle is filled rather than fitted, and the picture keeps its own
 * proportions inside it. pdfkit takes a width *and* a height as an
 * instruction to make the image exactly that, so handing it both is handing
 * it permission to stretch -- and it will, by whatever the box and the
 * picture disagree by. That disagreement is not hypothetical: every rectangle
 * in this file is computed from dimensions recorded at ingest, and a
 * rendition that has since been re-encoded, or was recorded before a fix to
 * how orientation is read, will not match. A face half again as wide as it
 * should be is the worst thing a photo book can do, and losing a strip off an
 * edge is close to the least, so the trade goes that way every time. pdfkit's
 * `cover` scales to fill and centres but does not clip what hangs over, so
 * the clip is drawn here.
 */
function drawImage(doc, { bytes, x, y, width, height }) {
    if (!bytes) {
        doc.save().rect(x, y, width, height).fillOpacity(0.06).fill(BLACK).restore();
        return;
    }

    doc.save().rect(x, y, width, height).clip();
    doc.image(bytes, x, y, { cover: [width, height], align: 'center', valign: 'center' });
    doc.restore();
}

/**
 * A picture the letter mentioned, floated into the margin.
 *
 * The side alternates down the letter, which is what the reader does and for
 * the same reason: three pictures stacked against one edge turn the column
 * into a staircase. It restarts at every chapter opening, because a letter
 * whose first photograph hangs on the right looks like a mistake.
 *
 * Nothing is drawn if there is not room for the picture *and* a couple of
 * lines beside it -- past that point the page turns first, because a float
 * two lines from the foot of a page is a float nothing flows around.
 */
function setFloat(doc, { photoId, meta, images, state }) {
    const width = Math.round(COLUMN * FLOAT_SHARE);
    const height = width / aspectOf(meta);

    if (doc.y + BODY.leading * 2 > TEXT_BOTTOM) turnPage(doc, state);

    // A float already open means two pictures close together with a scrap of
    // text between them. The second one waits until the first has been
    // cleared, which is exactly the clean break the reader gets from
    // `clear: left` -- otherwise they overlap in the same margin.
    if (state.float) doc.y = Math.max(doc.y, state.float.bottom);
    if (doc.y + height > TEXT_BOTTOM) turnPage(doc, state);

    const side = state.side;
    state.side = side === 'left' ? 'right' : 'left';

    const top = doc.y + 2;
    const x = side === 'left' ? LEFT : LEFT + COLUMN - width;

    drawImage(doc, { bytes: images.get(photoId), x, y: top, width, height });

    state.float = { side, top, bottom: top + height + 8, width };
    doc.fillColor(BLACK);
}

/**
 * A picture set across the column on its own, with nothing beside it.
 *
 * What a photograph gets when there is too little letter left to wrap around
 * it, and what a run of photographs with no text between them gets whatever
 * the length -- the same two rules the reader uses, for the same reasons.
 */
function setPlate(doc, { photos, images, state }) {
    if (state.float) doc.y = Math.max(doc.y, state.float.bottom);
    state.float = null;
    setBox(doc, state, 0);

    const rows =
        photos.length > 1
            ? albumRows(photos, {
                  target: albumTarget(photos, {
                      height: (PAGE.height - MARGIN.top - MARGIN.bottom) * PHOTO_MAX_HEIGHT
                  })
              })
            : [{ photos, height: photoBox({ width: photos[0].width, height: photos[0].height }).height }];

    for (const row of rows) {
        const widths = row.photos.map((photo) => row.height * aspectOf(photo));
        const total = widths.reduce((sum, width) => sum + width, 0) + ALBUM_GAP * (row.photos.length - 1);

        // Never split, so it turns the page whole rather than being clipped.
        if (doc.y + row.height + 14 > TEXT_BOTTOM) turnPage(doc, state);

        let x = LEFT + (COLUMN - total) / 2;
        const y = doc.y + 6;

        row.photos.forEach((photo, index) => {
            drawImage(doc, { bytes: images.get(photo.id), x, y, width: widths[index], height: row.height });
            x += widths[index] + ALBUM_GAP;
        });

        doc.y = y + row.height + 14;
    }

    doc.fillColor(BLACK);
}

/**
 * How much letter is left after a picture, in characters.
 *
 * Counted up to the next picture or the end of the letter, never past one,
 * because text on the far side of another photograph is not text this one can
 * wrap around. The reader walks the DOM to work this out; here the blocks are
 * already flat, so it is a loop.
 */
function textAfter(blocks, from) {
    let count = 0;

    for (let n = from + 1; n < blocks.length; n += 1) {
        if (blocks[n].kind === 'photo') break;
        for (const run of blocks[n].runs ?? []) count += run.text.length;
    }

    return count;
}

/**
 * The title, the mission and the dates, centred in a box.
 *
 * Drawn twice -- once on the cover and once on the title page a few leaves
 * behind it -- because that is what books do, and from one function because
 * the alternative is two copies that agree until the day somebody edits one.
 * Sizes are given as a share of the title's so a cover can simply ask for
 * larger type and have the rest follow.
 *
 * The two inks are arguments rather than the file's constants because the
 * cover may be any colour in the palette and the title page is always on
 * paper. Nothing here decides which pair it is given; it only uses them
 * consistently, so a dark cloth gets pale type throughout rather than a pale
 * name over a black date.
 */
function setNameplate(doc, { title, profile, x, width, size, rule = false, ink = BLACK, quiet = QUIET }) {
    doc.font('semibold').fontSize(size).fillColor(ink);
    doc.text(title, x, doc.y, { width, align: 'center' });

    // A hairline under the name, on the cover only. It costs nothing, and it
    // is the difference between a name floating in a field of colour and a
    // name that has been set on something.
    if (rule) {
        const span = width * 0.34;
        doc.moveDown(0.5);
        doc.save()
            .strokeColor(quiet)
            .lineWidth(0.75)
            .moveTo(x + (width - span) / 2, doc.y)
            .lineTo(x + (width + span) / 2, doc.y)
            .stroke()
            .restore();
        doc.y += 2;
    }

    // The mission stands on its own line rather than being folded into a
    // sentence. "Letters from the" plus whatever somebody typed reads well
    // for "Argentina Buenos Aires North Mission" and badly for "the one with
    // the mountains", and the field is free text on purpose -- so this does
    // not try to make grammar out of it.
    doc.moveDown(0.6);
    doc.font('italic').fontSize(size * 0.43).fillColor(quiet);
    doc.text(profile.mission || 'Letters from the mission', x, doc.y, { width, align: 'center' });

    // Full dates rather than years. This is what a cover is for: the two days
    // that bound the whole thing. Both are optional and either may be
    // missing, which is why this is built from whatever survives the filter
    // rather than from a fixed pair.
    const span = [profile.startDate, profile.returnDate].filter(Boolean).map(coverDate);
    if (!span.length) return;

    doc.moveDown(1.4);
    doc.font('regular').fontSize(size * 0.4);
    doc.text(span.join(' \u2013 '), x, doc.y, { width, align: 'center' });
}

/**
 * The largest size at which a name will sit on a cover in a line or two.
 *
 * A cover is set by eye in every trade that makes them, and the eye is
 * measuring one thing: how much of the width the longest name takes. A fixed
 * size has to be chosen for the longest name anybody might have, which leaves
 * every ordinary one looking lost -- and "Elder Declan Kurtzeborn" is not
 * even a long name. So the size is fitted instead: come down from the largest
 * that would ever be reasonable until the longest single word fits across the
 * measure and the whole name would take about two lines of it.
 *
 * Hyphenation is not on offer, which is why the longest *word* is a hard
 * constraint rather than a preference: a name wider than the page does not
 * wrap, it overhangs.
 */
function coverSize(doc, { title, width, most = 58, least = 30 }) {
    doc.font('semibold');

    for (let size = most; size > least; size -= 1) {
        doc.fontSize(size);

        const longest = Math.max(...title.split(/\s+/).map((word) => doc.widthOfString(word)));
        if (longest <= width && doc.widthOfString(title) <= width * 1.8) return size;
    }

    return least;
}

/**
 * The front cover, which is simply page one.
 *
 * Peecho takes the whole book as a single PDF -- front cover, then every leaf
 * in order, then back cover -- and works the spine out itself from the page
 * count, the paper and the facility that ends up printing it. So there is no
 * second document to build, no spine width to calculate and no bleed to add:
 * they say plainly not to add bleed or crop marks because their system
 * generates both. A cover here is a page of the same size as every other,
 * drawn first.
 *
 * Centred rather than mirrored, because a cover has no gutter to lean away
 * from -- it is one wrapped sheet of card, not a leaf of the block.
 *
 * Set large. A cover is read across a room, off a shelf, or in a thumbnail on
 * a checkout page, and at every one of those distances the only thing that
 * survives is the size of the name.
 *
 * A photograph, when there is one, takes the top of the board and the type
 * sits on the cloth below it. The obvious alternative -- the picture across
 * the whole board with the name over it -- needs a scrim to stay legible, and
 * a scrim heavy enough for a name over a bright sky is heavy enough to ruin
 * the picture. Banding it needs no scrim, cannot be illegible, and is what a
 * bound photo book looks like anyway.
 */
function setFrontCover(doc, { title, profile, cloth, picture, state }) {
    state.cover = true;
    doc.addPage();

    const width = PAGE.width - MARGIN.outside * 2;

    // The whole board, edge to edge. Drawn before anything else and with the
    // margins already zeroed by `state.cover`, since a fill that crosses a
    // margin is a page break taken from inside `pageAdded`.
    doc.save().rect(0, 0, PAGE.width, PAGE.height).fill(cloth.paper).restore();

    if (picture) {
        drawImage(doc, { bytes: picture, x: 0, y: 0, width: PAGE.width, height: PLATE_HEIGHT });
    }

    // Below the picture when there is one, a fifth of the way down when there
    // is not. Both leave the foot of the board clear for the wordmark.
    doc.y = picture ? PLATE_HEIGHT + 46 : PAGE.height * 0.2;

    setNameplate(doc, {
        title,
        profile,
        x: MARGIN.outside,
        width,
        size: coverSize(doc, { title, width, most: picture ? 44 : 58 }),
        rule: true,
        ink: cloth.ink,
        quiet: cloth.quiet
    });

    doc.font('italic').fontSize(11).fillColor(cloth.quiet);
    doc.text('pdayletters.com', MARGIN.outside, PAGE.height - MARGIN.bottom - 14, {
        width,
        align: 'center',
        lineBreak: false
    });

    state.cover = false;
}

/**
 * The back cover, which is simply the last page.
 *
 * Nearly bare on purpose. A trade paperback puts a blurb and a barcode here
 * because it has to sell itself off a shelf; this book has already been
 * bought, by somebody who knows exactly what is in it. All it owes the reader
 * is where the rest of it lives.
 *
 * The same cloth as the front, always. A book bound in navy with a white back
 * board is not a book anybody has ever seen.
 */
function setBackCover(doc, { slug, cloth, state }) {
    state.cover = true;
    doc.addPage();

    doc.save().rect(0, 0, PAGE.width, PAGE.height).fill(cloth.paper).restore();

    doc.font('italic').fontSize(11).fillColor(cloth.quiet);
    doc.text(`pdayletters.com/${slug}`, MARGIN.outside, PAGE.height * 0.78, {
        width: PAGE.width - MARGIN.outside * 2,
        align: 'center',
        lineBreak: false
    });

    state.cover = false;
}

function setTitlePage(doc, { title, profile, state }) {
    state.indent = 0;
    doc.addPage();

    doc.y = PAGE.height * 0.3;
    setNameplate(doc, { title, profile, x: LEFT, width: COLUMN, size: 30 });
}

function setContents(doc, { entries, state }) {
    const sheets = contentsPages(entries.length);
    state.indent = 0;

    for (let sheet = 0; sheet < sheets; sheet += 1) {
        doc.addPage();

        doc.y = MARGIN.top + 10;

        if (sheet === 0) {
            doc.font('semibold').fontSize(17).fillColor(BLACK);
            doc.text('Contents', LEFT, doc.y, { width: COLUMN });
            doc.moveDown(0.9);
        }

        const slice = entries.slice(sheet * CONTENTS_PER_PAGE, (sheet + 1) * CONTENTS_PER_PAGE);

        for (const entry of slice) {
            // Every cell of the row is drawn at the same `y` and the cursor
            // is advanced by hand afterwards, because three columns that each
            // moved the cursor would stack instead of lining up.
            const y = doc.y;

            doc.font('regular').fontSize(10.5).fillColor(QUIET);
            doc.text(entry.date, LEFT, y, { width: 66, lineBreak: false });

            // Truncated rather than wrapped. A subject long enough to wrap
            // would push the rest of the page down, and the number of rows
            // per page is what the reservation above was computed from.
            doc.fillColor(BLACK);
            doc.text(entry.subject, LEFT + 74, y, {
                width: COLUMN - 74 - 30,
                lineBreak: false,
                ellipsis: true,
                height: 14
            });

            // Blank during the measuring pass, when no letter has a page
            // number yet. The row still occupies its line, which is all the
            // reservation needs it to do.
            doc.fillColor(QUIET);
            doc.text(entry.page ? String(entry.page) : '', LEFT, y, {
                width: COLUMN,
                align: 'right',
                lineBreak: false
            });

            doc.y = y + 15.5;
        }
    }
}

/**
 * The back of the title page.
 *
 * Which is where a colophon belongs, and putting it there solves a second
 * problem for free. Letters open on left-hand pages, so the front matter has
 * to end on a right-hand one; a title page alone would leave its own verso
 * blank and push everything out of phase.
 */
function setColophon(doc, { title, slug, madeAt, state }) {
    state.indent = 0;
    doc.addPage();

    doc.y = PAGE.height * 0.62;
    doc.font('italic').fontSize(11).fillColor(QUIET);

    for (const line of [
        `${title} \u00b7 pdayletters.com/${slug}`,
        `Printed from the archive on ${String(madeAt).slice(0, 10)}.`,
        'Set in Crimson Text.'
    ]) {
        doc.text(line, LEFT, doc.y, { width: COLUMN, align: 'center' });
        doc.moveDown(0.4);
    }
}

/**
 * One traversal of the entire book.
 *
 * Both passes call this and differ only in what `photosFor` hands back, which
 * is the invariant the contents page rests on -- see the header.
 *
 * @returns {Promise<Map<string, number>>} post id to the folio it opened on
 */
async function setBook(doc, { slug, posts, profile, title, entries, imagesFor, cloth, picture, least, state }) {
    setFrontCover(doc, { title, profile, cloth, picture, state });
    setTitlePage(doc, { title, profile, state });
    setColophon(doc, { title, slug, madeAt: state.madeAt, state });
    setContents(doc, { entries, state });

    state.furniture = true;
    const starts = new Map();

    for (const post of posts) {
        starts.set(post.id, setLetter(doc, { post, slug, images: await imagesFor(post), state }));
    }

    state.furniture = false;
    padToPrinter(doc, state, least);
    setBackCover(doc, { slug, cloth, state });

    return starts;
}

const NO_IMAGES = new Map();

/**
 * How wide each of a letter's photographs will actually be printed.
 *
 * Worked out before any of them are fetched, because the answer decides how
 * much of each file is worth reading. Sizing every picture to the full column
 * was the first version and it was quietly expensive: an album photograph
 * printed three to a row is about a third of the column, so transcoding it at
 * the column's width put nine times the pixels into the book than any press
 * could resolve -- across four hundred photographs, on an instance with two
 * gigabytes to its name.
 *
 * An upper bound rather than the exact rectangle, and deliberately so. An
 * inline picture prints at two fifths of the column when the text wraps round
 * it and at up to the full column when it does not, and which of those
 * happens depends on how much letter follows -- so the larger is taken.
 * Album pictures are capped at the column for the same kind of reason: how
 * many leaves the album gets is not settled until the letter above it has
 * been set. Erring high costs a few pixels; erring low would print a
 * photograph soft, which no amount of memory saved is worth.
 */
function printWidths(post, slug) {
    const inline = new Set(inlinePhotoIds(flowBody(post.bodyHtml ?? '', slug)));
    const photos = post.photos ?? [];
    const widths = new Map();

    for (const photo of photos) {
        if (!inline.has(photo.id)) continue;
        widths.set(photo.id, photoBox({ width: photo.width, height: photo.height }).width);
    }

    // An album picture is capped at the column rather than at the cell it
    // will land in, because how many leaves the album gets is not settled
    // until the letter above it has been set and its length is known. The
    // column is the widest any picture can ever be printed, so this can only
    // ever err towards too many pixels, never too few. Inline pictures are
    // the ones that mattered anyway: they print at two fifths of the column,
    // which is a sixth of the area.
    for (const photo of photos) {
        if (!inline.has(photo.id)) widths.set(photo.id, COLUMN);
    }

    return widths;
}

const freshState = (madeAt, proof) => ({
    page: 0,
    head: '',
    furniture: false,
    opening: false,
    blank: false,
    cover: false,
    indent: 0,
    float: null,
    side: 'left',
    proof,
    madeAt
});

/**
 * Build the book.
 *
 * One PDF, covers included, which is the form Peecho asks for. Returns the
 * document's own output stream immediately, plus a promise that settles when
 * the last page has been set -- so the bytes can be uploaded while the rest
 * of the book is still being written, and a four-hundred-photograph mission
 * never has to exist in memory at once.
 *
 * `least` is the printer's page floor and is worth being able to override:
 * it belongs to whoever is binding the book, not to the book. Zero turns the
 * press's rules off altogether -- no floor and no parity -- which is what
 * code measuring the layout wants, since twenty blank leaves and a rounding
 * to the next even number hide whatever it was trying to see.
 *
 * `pages` counts what the printer counts -- every leaf, both covers -- since
 * that is the number their spine calculation is fed. The folios in `opens`
 * number the book instead, so the two do not agree and are not meant to.
 *
 * `proof` marks the reviewing copy and drops it to screen resolution, and
 * those two go together on purpose -- which is why one flag sets both. A
 * marked book at press resolution is a hundred megabytes nobody can open in a
 * browser, and an unmarked one at screen resolution is a book somebody can
 * hand to a cheaper printer. Neither changes the layout by a point, which is
 * what lets a proof be trusted as a proof of the thing that will be bound.
 *
 * `cover` is the owner's choice of cloth and, when they made one, the bytes
 * of the picture for the front board -- already fetched, because where that
 * picture lives is a question about storage rather than about typesetting.
 * The measuring pass is given the colour but not the picture, which is safe
 * for the one reason worth stating: a cover is exactly one page whatever is
 * printed on it, so nothing behind it moves.
 *
 * @returns {{stream: import('node:stream').Readable, done: Promise<{pages: number, opens: {id: string, page: number}[]}>}}
 */
export function buildInterior({
    store,
    slug,
    posts,
    profile = {},
    cover = {},
    madeAt,
    least = SHEET_LEAST,
    proof = false,
    dpi = proof ? PROOF_DPI : PRINT_DPI,
    log
}) {
    const ordered = inReadingOrder(posts);
    const title = profile.displayName || slug;
    const cloth = clothOf(cover.cloth);

    const entries = ordered.map((post) => ({
        date: shortDate(post),
        subject: post.subject || 'Untitled',
        page: 0
    }));

    // The measuring pass. It reads no blobs at all -- every rectangle it
    // needs is already recorded on the post -- so it costs layout arithmetic
    // and nothing else, and it is thrown away the moment it has answered the
    // one question it was asked.
    const measured = (async () => {
        const state = freshState(madeAt, proof);
        const draft = openBook({ title, state });

        // Drained and discarded. Nothing here is the book; the only output
        // that matters is where each letter landed. Without a consumer the
        // stream fills its buffer and stops, and the pass never finishes.
        draft.on('data', () => {});

        const starts = await setBook(draft, {
            slug,
            posts: ordered,
            profile,
            title,
            entries,
            imagesFor: () => NO_IMAGES,
            cloth,
            picture: null,
            least,
            state
        });

        draft.end();
        return starts;
    })();

    const state = freshState(madeAt, proof);
    const doc = openBook({ title, state });

    const done = (async () => {
        const starts = await measured;
        for (let index = 0; index < ordered.length; index += 1) {
            entries[index].page = starts.get(ordered[index].id) ?? 0;
        }

        // The one picture in the book that is fetched up front, because it is
        // the one the very first drawing call needs. A cover that will not
        // transcode is not worth failing a book over -- the cloth alone is a
        // cover -- so this is warned about and dropped, exactly as a letter's
        // photograph is.
        let picture = null;
        if (cover.bytes) {
            try {
                picture = await forPrint(cover.bytes, { widthPoints: PAGE.width, dpi });
            } catch (error) {
                log?.warn?.('book.coverFailed', { slug, error: error.message });
            }
        }

        const printed = await setBook(doc, {
            slug,
            posts: ordered,
            profile,
            title,
            entries,
            cloth,
            picture,
            // One letter's pictures at a time, and one picture at a time
            // within that. Fetching the book's photographs up front is how a
            // 2 GB instance meets a 500 MB archive.
            imagesFor: async (post) => {
                const map = new Map();

                for (const [photoId, widthPoints] of printWidths(post, slug)) {
                    try {
                        const bytes = await printPhoto({
                            store,
                            slug,
                            photoId,
                            widthPoints,
                            dpi
                        });
                        if (bytes) map.set(photoId, bytes);
                    } catch (error) {
                        // A missing or unreadable rendition is not worth
                        // failing a whole book over, exactly as in the zip
                        // export. The rectangle is reserved either way, so
                        // the pagination the contents page promised holds.
                        log?.warn?.('book.photoFailed', {
                            slug,
                            photoId,
                            error: error.message
                        });
                    }
                }

                return map;
            },
            least,
            state
        });

        doc.end();

        // `opens` is the same map the contents page was built from, checked
        // against the book that was actually printed rather than the one that
        // was measured. They agree or the two-pass design has failed, which
        // is worth being able to assert from outside this file.
        return {
            pages: state.page + COVERS,
            opens: ordered.map((post) => ({ id: post.id, page: printed.get(post.id) ?? 0 }))
        };
    })();

    return { stream: doc, done };
}
