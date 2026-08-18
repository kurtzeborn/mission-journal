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

// pdfkit publishes no ESM entry point, so it comes in through require the way
// yazl does in archive.js.
const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');

const INCH = 72;

// Lulu hardcover, 8"x10", premium colour -- the trim named in the plan. Held
// as points because that is the only unit a PDF has; every dimension below is
// derived from it rather than typed twice.
export const PAGE = { width: 8 * INCH, height: 10 * INCH };

// Asymmetric on purpose, and the asymmetry is the point. A hardcover's inner
// edge disappears into the binding, so the gutter margin has to be the widest
// one or the last few characters of every line curve out of sight. Lulu's own
// floor is half an inch from the trim on all four sides; nothing here is
// closer than three quarters.
export const MARGIN = { top: 60, bottom: 66, inside: 78, outside: 54 };

export const COLUMN = PAGE.width - MARGIN.inside - MARGIN.outside;
const TEXT_BOTTOM = PAGE.height - MARGIN.bottom;

// Crimson Text: an old-style book face, OFL licensed, shipped in the repo.
//
// It is here rather than being one of pdfkit's built-in fonts because the
// built-ins are the PDF Standard 14, which are by definition *not* embedded --
// they name a font and trust the reader to own it. Lulu rejects an interior
// with unembedded fonts outright, so the choice was never between faces, it
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

// Contents entries per page, used to reserve the right number of leaves
// before anything is set. Deliberately a constant rather than something
// measured: the reservation has to be identical in both passes, and a value
// derived from the first pass would move in the second.
const CONTENTS_PER_PAGE = 32;

// The album that faces a letter. `MIN_ROW` is the point at which a row of
// photographs stops being a row of photographs and becomes a strip of
// thumbnails; below it the album spills onto another page instead of
// shrinking further.
const ALBUM_GAP = 10;
const ALBUM_MIN_ROW = 84;

// Four by three when nothing was recorded. Ingest measures every photograph it
// stores, so this is for the handful that predate it -- and a picture with no
// shape still has to be given one, because the alternative is a division by
// zero in the middle of a page.
const aspectOf = (photo) =>
    photo?.width > 0 && photo?.height > 0 ? photo.width / photo.height : 4 / 3;

const BLACK = '#1a1a1a';
const QUIET = '#666666';

const INDENT_STEP = 18;

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
const coverDate = (stamp) => {
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
 * photographs: PNG would store them losslessly at several times the size and
 * put a 400-photograph book past what Lulu will accept as an upload.
 *
 * Resized down to what the page can actually show at 300 dpi. The stored
 * rendition is 2400px on its long edge, and a picture printed across this
 * column needs about 1875 -- so shipping the stored file unchanged would put
 * roughly a third more data in the book than any printer could resolve.
 * `withoutEnlargement` keeps a small picture from being blown up into
 * something blurry to satisfy an arithmetic target.
 */
export async function printPhoto({ store, slug, photoId, widthPoints, dpi = 300 }) {
    const blob = await store.readBlob('rendered', `${slug}/photos/${photoId}/large.webp`);
    if (!blob) return null;

    const pixels = Math.round((widthPoints / INCH) * dpi);

    return sharp(Buffer.from(blob.bytes))
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

    doc.on('pageAdded', () => {
        state.page += 1;
        const recto = state.page % 2 === 1;

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

// Runs are written with `continued`, which is how pdfkit is told the next
// call carries on the same line rather than starting a new one. The last run
// of a block has to close it, or the block after this one joins the sentence.
//
// Nothing here is given an x or a width. Both come from the page's margins,
// which `setBox` has already put where this block wants them, and that is not
// a stylistic preference -- it is the only arrangement that survives a page
// break.
//
// Passing an explicit x was the first attempt and it was wrong in a way that
// took a measurement to see. pdfkit takes the position once, at the start of
// the block; when the block then overflows onto the next page it carries that
// same x with it. On a mirrored layout the next page's text box is on the
// other side of the leaf, so every paragraph that spanned a break printed
// into the previous page's margin -- the gutter on the wrong edge, on roughly
// half the pages of every letter longer than one.
function writeRuns(doc, runs, options = {}) {
    const size = options.size ?? BODY.size;

    runs.forEach((run, index) => {
        const font = run.bold ? 'bold' : run.italic ? 'italic' : options.font ?? 'regular';

        doc.font(font)
            .fontSize(run.small ? size * 0.82 : size)
            .fillColor(options.color ?? BLACK);

        doc.text(run.text, {
            continued: index < runs.length - 1,
            underline: run.underline,
            strike: run.strike,
            link: run.link ?? null,
            align: options.align ?? 'left',
            lineGap: (options.leading ?? BODY.leading) - size
        });
    });
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

    doc.moveDown(1.2);
    doc.fillColor(BLACK);

    const blocks = flowBody(post.bodyHtml ?? '', slug);
    const placed = new Set();

    for (const block of blocks) {
        if (block.kind === 'photo') {
            placed.add(block.photoId);
            setPhoto(doc, { photoId: block.photoId, post, images, state });
            continue;
        }
        setBlock(doc, { block, state });
    }

    // Anything attached but never placed in the text. The reader shows these
    // as an album under the letter and the book gives them the facing page,
    // for the same reason: they belong to this letter and to no other, and
    // dropping them would lose pictures the family sent.
    setAlbum(doc, {
        photos: (post.photos ?? []).filter((photo) => !placed.has(photo.id)),
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
function setAlbum(doc, { photos, images, state }) {
    if (!photos.length) return;

    setBox(doc, state, 0);
    doc.addPage();

    const usable = PAGE.height - MARGIN.top - MARGIN.bottom;
    const target = albumTarget(photos, { height: usable });
    const rows = albumRows(photos, { target });

    // Centred vertically when it does not fill the page, which is usually.
    // Rows have to span the column exactly, so their heights are decided by
    // how the pictures group rather than by how much room is going -- four
    // photographs come out as two rows of two and leave a third of the leaf
    // over no matter what target is chosen. Pushed to the top that reads as a
    // page that ran out; balanced, it reads as a plate.
    const total = albumHeight(rows);
    let y = MARGIN.top + (total < usable ? (usable - total) / 2 : 0);

    for (const row of rows) {
        // Only when the album is larger than one page will this ever fire,
        // which takes a letter with a great many attachments.
        if (y + row.height > PAGE.height - MARGIN.bottom) {
            doc.addPage();
            y = MARGIN.top;
        }

        let x = LEFT;
        for (const photo of row.photos) {
            const width = row.height * aspectOf(photo);
            const bytes = images.get(photo.id);

            if (bytes) doc.image(bytes, x, y, { width, height: row.height });
            else doc.save().rect(x, y, width, row.height).fillOpacity(0.06).fill(BLACK).restore();

            x += width + ALBUM_GAP;
        }

        y += row.height + ALBUM_GAP;
    }

    doc.y = y;
    doc.fillColor(BLACK);
}

function setBlock(doc, { block, state }) {
    const indent = block.indent * INDENT_STEP;
    setBox(doc, state, indent);
    const x = LEFT + indent;
    const width = COLUMN - indent;

    if (block.kind === 'rule') {
        if (doc.y + 26 > TEXT_BOTTOM) doc.addPage();
        doc.moveDown(0.5);
        doc.strokeColor('#cccccc')
            .lineWidth(0.5)
            .moveTo(x + width * 0.35, doc.y)
            .lineTo(x + width * 0.65, doc.y)
            .stroke();
        doc.moveDown(0.9);
        return;
    }

    if (block.kind === 'head') {
        const size = HEAD_SIZES[block.level] ?? 13;
        doc.moveDown(0.6);
        writeRuns(doc, block.runs, { font: 'semibold', size, leading: size + 4 });
        doc.moveDown(0.25);
        return;
    }

    if (block.kind === 'item') {
        // The marker hangs in the indent rather than sitting in the text, so
        // the second line of a long bullet lines up under the first word and
        // not under the bullet.
        const top = doc.y;
        doc.font('regular').fontSize(BODY.size).fillColor(BLACK);
        doc.text(block.marker ?? '\u2022', x, top, { width: INDENT_STEP - 4, lineBreak: false });

        setBox(doc, state, indent + INDENT_STEP);
        doc.y = top;
        writeRuns(doc, block.runs);
        doc.moveDown(0.2);
        return;
    }

    if (block.kind === 'quote') {
        writeRuns(doc, block.runs, { font: 'italic', color: '#444444' });
        doc.moveDown(0.4);
        return;
    }

    // `pre` is set in the text face, because there is no other one. The
    // spacing carried the meaning; the typeface never did.
    const pre = block.kind === 'pre';
    writeRuns(doc, block.runs, { size: pre ? BODY.size - 1 : BODY.size });
    doc.moveDown(pre ? 0.4 : 0.45);
}

function setPhoto(doc, { photoId, post, images, state }) {
    const meta = (post.photos ?? []).find((photo) => photo.id === photoId) ?? {};
    const rect = photoBox({ width: meta.width ?? 4, height: meta.height ?? 3 });

    // Back to the full column before the break is considered, so the page it
    // may add lands with an unindented box rather than inheriting whatever
    // the last list item was using.
    setBox(doc, state, 0);

    // A picture is never split, so it moves to the next page whole rather
    // than being clipped at the bottom of this one.
    if (doc.y + rect.height + 14 > TEXT_BOTTOM) doc.addPage();
    const x = LEFT + (COLUMN - rect.width) / 2;
    const y = doc.y + 6;

    const bytes = images.get(photoId);
    if (bytes) {
        doc.image(bytes, x, y, { width: rect.width, height: rect.height });
    } else {
        // The measuring pass, and also a photograph whose bytes have gone
        // missing. Both want the same rectangle reserved: the first so the
        // contents page is right, the second so a lost picture leaves an
        // obvious gap rather than silently reflowing the book around it.
        doc.save().rect(x, y, rect.width, rect.height).fillOpacity(0.06).fill(BLACK).restore();
    }

    doc.y = y + rect.height + 14;
    doc.fillColor(BLACK);
}

function setTitlePage(doc, { title, profile, state }) {
    state.indent = 0;
    doc.addPage();

    doc.y = PAGE.height * 0.3;
    doc.font('semibold').fontSize(30).fillColor(BLACK);
    doc.text(title, LEFT, doc.y, { width: COLUMN, align: 'center' });

    // The mission stands on its own line rather than being folded into a
    // sentence. "Letters from the" plus whatever somebody typed reads well
    // for "Argentina Buenos Aires North Mission" and badly for "the one with
    // the mountains", and the field is free text on purpose -- so the cover
    // does not try to make grammar out of it.
    doc.moveDown(0.6);
    doc.font('italic').fontSize(13).fillColor(QUIET);
    doc.text(profile.mission || 'Letters from the mission', LEFT, doc.y, {
        width: COLUMN,
        align: 'center'
    });

    // Full dates rather than years. This is what a cover is for: the two days
    // that bound the whole thing. Both are optional and either may be
    // missing, which is why this is built from whatever survives the filter
    // rather than from a fixed pair.
    const span = [profile.startDate, profile.returnDate].filter(Boolean).map(coverDate);

    if (span.length) {
        doc.moveDown(1.4);
        doc.font('regular').fontSize(12);
        doc.text(span.join(' \u2013 '), LEFT, doc.y, { width: COLUMN, align: 'center' });
    }
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
async function setBook(doc, { slug, posts, profile, title, entries, imagesFor, state }) {
    setTitlePage(doc, { title, profile, state });
    setColophon(doc, { title, slug, madeAt: state.madeAt, state });
    setContents(doc, { entries, state });

    state.furniture = true;
    const starts = new Map();

    for (const post of posts) {
        starts.set(post.id, setLetter(doc, { post, slug, images: await imagesFor(post), state }));
    }

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
 * Reached the same way the drawing code reaches it, from `flowBody` and the
 * same packing, so the two cannot disagree about which pictures ended up in
 * the album.
 */
function printWidths(post, slug) {
    const inline = new Set(inlinePhotoIds(flowBody(post.bodyHtml ?? '', slug)));
    const photos = post.photos ?? [];
    const widths = new Map();

    for (const photo of photos) {
        if (!inline.has(photo.id)) continue;
        widths.set(photo.id, photoBox({ width: photo.width, height: photo.height }).width);
    }

    const album = photos.filter((photo) => !inline.has(photo.id));
    if (album.length) {
        const target = albumTarget(album, { height: PAGE.height - MARGIN.top - MARGIN.bottom });
        for (const row of albumRows(album, { target })) {
            for (const photo of row.photos) widths.set(photo.id, row.height * aspectOf(photo));
        }
    }

    return widths;
}

const freshState = (madeAt) => ({
    page: 0,
    head: '',
    furniture: false,
    opening: false,
    blank: false,
    indent: 0,
    madeAt
});

/**
 * Build the interior of the book.
 *
 * Returns the PDF's own output stream immediately, plus a promise that
 * settles when the last page has been set. The page total only exists once
 * that promise resolves, and a hardcover's spine is as thick as the paper
 * inside it -- so the cover cannot be drawn until this has finished.
 *
 * @returns {{stream: import('node:stream').Readable, done: Promise<{pages: number, opens: {id: string, page: number}[]}>}}
 */
export function buildInterior({ store, slug, posts, profile = {}, madeAt, log }) {
    const ordered = inReadingOrder(posts);
    const title = profile.displayName || slug;

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
        const state = freshState(madeAt);
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
            state
        });

        draft.end();
        return starts;
    })();

    const state = freshState(madeAt);
    const doc = openBook({ title, state });

    const done = (async () => {
        const starts = await measured;
        for (let index = 0; index < ordered.length; index += 1) {
            entries[index].page = starts.get(ordered[index].id) ?? 0;
        }

        const printed = await setBook(doc, {
            slug,
            posts: ordered,
            profile,
            title,
            entries,
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
                            widthPoints
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
            state
        });

        doc.end();

        // `opens` is the same map the contents page was built from, checked
        // against the book that was actually printed rather than the one that
        // was measured. They agree or the two-pass design has failed, which
        // is worth being able to assert from outside this file.
        return {
            pages: state.page,
            opens: ordered.map((post) => ({ id: post.id, page: printed.get(post.id) ?? 0 }))
        };
    })();

    return { stream: doc, done };
}
