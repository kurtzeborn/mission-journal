// The cover, again, as a picture.
//
// Peecho's checkout shows a thumbnail beside the price, and without one their
// configurator logs `thumbnailUrl Required` and shows the buyer an empty
// frame. That frame is the only look at the book anybody gets before paying
// for it, so it is worth more than the sentence of code it takes to satisfy
// the field.
//
// **This draws the cover a second time, and that is the uncomfortable part.**
// The real one is `setFrontCover` in `book.js`, in pdfkit, in points, onto
// page one of the PDF. Nothing can rasterise that page without a PDF renderer
// -- pdfium, poppler, mupdf -- and every one of those is either a heavy
// native dependency on a Linux instance that has to stay small, or licensed
// in a way that would reach into this whole service. Rendering it twice from
// two toolkits is a genuine cost: the two can drift, and the day somebody
// moves the nameplate in `book.js` this file will quietly go on drawing the
// old one.
//
// What keeps that from being a lie rather than a lag: the palette, the trim,
// the plate height, the faces and the date format are all *imported* from the
// files that own them, so a colour or a size can only ever be changed in one
// place. Only the arithmetic of stacking four lines is duplicated, and this
// image is a hundred pixels tall on the page it appears on.
//
// It is deliberately not pixel-exact. pdfkit's `moveDown` measures the
// current face's line height and that is not a number available here, so the
// gaps below are the same multiples against an assumed leading. A thumbnail
// that is a millimetre out is a thumbnail; a thumbnail in the wrong colour,
// with the wrong name or the wrong photograph is a misrepresentation, and
// those are the parts that come from the shared constants.

import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { PAGE, MARGIN, PLATE_HEIGHT, coverDate } from './book.js';
import { clothOf } from './cover.js';

// One pixel to one point, so every measurement below is the same number it is
// in `book.js` and the two can be read side by side. It also happens to be a
// sensible size to hand a checkout page: large enough to survive being shown
// at a few hundred pixels, small enough to be a fraction of the PDF beside it.
const BOARD = { width: Math.round(PAGE.width), height: Math.round(PAGE.height) };
const MEASURE = BOARD.width - MARGIN.outside * 2;
const PLATE = Math.round(PLATE_HEIGHT);

// pdfkit works the line height out from the face; pango is being asked for a
// point size and told where to put the result. This is the ratio that makes
// the gaps come out looking like the printed cover.
const LEADING = 1.2;

// The same four files the book embeds, named the way fontconfig will report
// them once the file is loaded. A name that does not match is not fatal:
// pango falls back to the font in `fontfile`, which is the face we wanted
// anyway -- the name only decides which face inside a family is picked, and
// each of these is a file of its own.
const FACES = {
    regular: { family: 'Crimson Text', file: 'CrimsonText-Regular.ttf' },
    italic: { family: 'Crimson Text Italic', file: 'CrimsonText-Italic.ttf' },
    semibold: { family: 'Crimson Text SemiBold', file: 'CrimsonText-SemiBold.ttf' }
};

const facePath = (file) => fileURLToPath(new URL(`../assets/book/${file}`, import.meta.url));

// Text is handed to pango as markup so it can carry its own colour, which
// means the name of a missionary whose family typed an ampersand into it
// would otherwise be markup too.
const escaped = (text) =>
    String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');

/**
 * One line -- or one wrapped paragraph -- set in a face, at a size, in a
 * colour, trimmed to its own ink.
 *
 * Trimmed is what sharp does rather than what is asked for: the result comes
 * back as wide as the glyphs, not as wide as the box, which is why every
 * caller centres by measuring instead of by asking for an aligned box.
 */
const setLine = ({ face, size, colour, text, width = MEASURE }) =>
    sharp({
        text: {
            text: `<span foreground="${colour}">${escaped(text)}</span>`,
            font: `${face.family} ${size}`,
            fontfile: facePath(face.file),
            rgba: true,
            align: 'centre',
            width: Math.round(width)
        }
    });

/**
 * The largest size at which the name will sit on the board.
 *
 * The same two rules as `coverSize`: the longest single word has to fit
 * across the measure, because nothing hyphenates, and the whole name has to
 * be no wider than about two lines of it. Rather than stepping down a point
 * at a time and re-laying the text at each, this measures once at a reference
 * size and divides -- glyph advances scale linearly with the point size, so
 * the answer is the same one the loop would have reached.
 */
async function fitted({ title, most, least = 30 }) {
    const at = async (text) => {
        // No wrap width: the question is how wide this would be if it were
        // allowed to run on, and a width would answer a different one.
        const { width } = await sharp({
            text: {
                text: escaped(text),
                font: `${FACES.semibold.family} 100`,
                fontfile: facePath(FACES.semibold.file)
            }
        }).metadata();
        return width || 1;
    };

    const words = title.split(/\s+/).filter(Boolean);
    const longest = Math.max(...(await Promise.all(words.map(at))));
    const whole = await at(title);

    const size = Math.min(most, (MEASURE / longest) * 100, ((MEASURE * 1.8) / whole) * 100);

    return Math.max(least, Math.floor(size));
}

/**
 * A picture of the front board.
 *
 * Takes what `assemble` already read for the PDF -- the same cloth, the same
 * photograph bytes -- so the thumbnail cannot show a cover the book does not
 * have.
 *
 * Returns null rather than throwing on any failure. A book that is bound and
 * in storage must not be undone by an image nobody has asked for yet; the
 * listing simply goes out without a preview, which is where this started.
 *
 * @returns {Promise<Buffer|null>}
 */
export async function coverImage({ title, profile = {}, cover = {}, log }) {
    try {
        const cloth = clothOf(cover.cloth);
        const layers = [];

        if (cover.bytes) {
            layers.push({
                // Filled and centre-cropped, exactly as `drawImage` does it
                // for the PDF: a strip off an edge is a far smaller lie than
                // a face stretched to fit.
                input: await sharp(cover.bytes)
                    .resize(BOARD.width, PLATE, { fit: 'cover', position: 'centre' })
                    .toBuffer(),
                top: 0,
                left: 0
            });
        }

        const size = await fitted({ title, most: cover.bytes ? 44 : 58 });
        let y = cover.bytes ? PLATE + 46 : Math.round(BOARD.height * 0.2);

        const place = async (image) => {
            const buffer = await image.png().toBuffer({ resolveWithObject: true });
            layers.push({
                input: buffer.data,
                top: Math.round(y),
                left: Math.round((BOARD.width - buffer.info.width) / 2)
            });
            y += buffer.info.height;
        };

        await place(setLine({ face: FACES.semibold, size, colour: cloth.ink, text: title }));

        // The hairline under the name. It is the one mark on the board that
        // is not type, and it is what stops the name floating in a field of
        // colour.
        y += 0.5 * size * LEADING;
        const rule = Math.round(MEASURE * 0.34);
        layers.push({
            input: {
                create: { width: rule, height: 1, channels: 4, background: cloth.quiet }
            },
            top: Math.round(y),
            left: Math.round((BOARD.width - rule) / 2)
        });
        y += 2;

        y += 0.6 * size * LEADING;
        await place(
            setLine({
                face: FACES.italic,
                size: size * 0.43,
                colour: cloth.quiet,
                text: profile.mission || 'Letters from the mission'
            })
        );

        const span = [profile.startDate, profile.returnDate].filter(Boolean).map(coverDate);
        if (span.length) {
            y += 1.4 * size * 0.43 * LEADING;
            await place(
                setLine({
                    face: FACES.regular,
                    size: size * 0.4,
                    colour: cloth.quiet,
                    text: span.join(' \u2013 ')
                })
            );
        }

        y = BOARD.height - MARGIN.bottom - 14;
        await place(
            setLine({ face: FACES.italic, size: 11, colour: cloth.quiet, text: 'pdayletters.com' })
        );

        return await sharp({
            create: {
                width: BOARD.width,
                height: BOARD.height,
                channels: 4,
                background: cloth.paper
            }
        })
            .composite(layers)
            // JPEG because this is a photograph of a book on somebody else's
            // checkout page, and it is the one format every such page has
            // been able to show for thirty years.
            .jpeg({ quality: 82, mozjpeg: true })
            .toBuffer();
    } catch (error) {
        log?.warn?.('book.noThumbnail', { message: error.message });
        return null;
    }
}
