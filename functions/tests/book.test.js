import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inflateSync } from 'node:zlib';

import {
    COLUMN,
    MARGIN,
    PAGE,
    SHEET_LEAST,
    albumPageCount,
    albumPlan,
    albumRows,
    albumSpread,
    albumTarget,
    buildInterior,
    byMonth,
    contentsPages,
    contentsSheets,
    dateLine,
    inReadingOrder,
    mirror,
    monthLabel,
    photoBox,
    printPhoto,
    reserve
} from '../src/lib/book.js';
import { memoryStore } from './memory-store.js';

// Reading the finished PDF back is the only honest check here. The layout is
// hundreds of small arithmetic decisions and asserting on any one of them in
// isolation tests the assertion rather than the book, so most of what follows
// builds a real document and then asks it questions.
const readPdf = async (stream) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
};

// What was actually drawn, which pdfkit compresses. Every stream in the file
// is tried and the ones that are not deflated -- the JPEGs, mostly -- simply
// refuse, which is all the empty catch means.
const drawnIn = (bytes) => {
    const raw = bytes.toString('latin1');
    const out = [];

    for (const match of raw.matchAll(/stream\r?\n/g)) {
        const from = match.index + match[0].length;
        const to = raw.indexOf('endstream', from);
        if (to < 0) continue;

        try {
            out.push(inflateSync(bytes.subarray(from, to)).toString('latin1'));
        } catch {
            // Not a content stream.
        }
    }

    return out.join('\n');
};

const post = (id, date, subject, overrides = {}) => ({
    id,
    originalDate: `${date}T12:00:00.000Z`,
    subject,
    bodyHtml: '<p>We walked out early and the streets were still wet.</p>',
    photos: [],
    ...overrides
});

const range = (count) =>
    Array.from({ length: count }, (_, n) => ({ id: `p${n}`, width: 2400, height: 1600 }));

describe('the order a book runs in', () => {
    test('turns the newest-first payload back into a mission', () => {
        const posts = [post('c', '2026-03-01', 'Third'), post('b', '2026-02-01', 'Second'), post('a', '2026-01-01', 'First')];

        assert.deepEqual(
            inReadingOrder(posts).map((entry) => entry.id),
            ['a', 'b', 'c']
        );
    });

    test('leaves the payload it was handed alone', () => {
        const posts = [post('b', '2026-02-01', 'Second'), post('a', '2026-01-01', 'First')];
        inReadingOrder(posts);

        assert.deepEqual(
            posts.map((entry) => entry.id),
            ['b', 'a']
        );
    });
});

describe('the date over a letter', () => {
    test('writes the day out in full', () => {
        assert.equal(dateLine({ originalDate: '2026-01-04T09:00:00.000Z' }), 'Sunday, January 4, 2026');
    });

    test('reads the day in UTC rather than wherever the server is', () => {
        // An evening timestamp is the one that slips a day westward, which is
        // where every date-off-by-one in this codebase has come from.
        assert.equal(dateLine({ originalDate: '2026-01-04T23:30:00.000Z' }), 'Sunday, January 4, 2026');
    });

    test('says nothing rather than something wrong when the date is missing', () => {
        assert.equal(dateLine({}), '');
        assert.equal(dateLine({ originalDate: 'sometime' }), '');
    });
});

describe('which way the gutter faces', () => {
    test('leaves right-hand pages where they were set', () => {
        assert.equal(mirror(1), 0);
        assert.equal(mirror(7), 0);
    });

    test('slides left-hand pages across by the difference between the margins', () => {
        const across = -(MARGIN.inside - MARGIN.outside);
        assert.equal(mirror(2), across);
        assert.equal(mirror(8), across);
    });

    test('keeps the column the same width on both, which is what makes the shift legal', () => {
        assert.equal(COLUMN, PAGE.width - MARGIN.inside - MARGIN.outside);
        assert.ok(MARGIN.inside > MARGIN.outside);
    });
});

describe('how much room the contents need', () => {
    const over = (count, { from = 1, each = 1 } = {}) =>
        byMonth(
            Array.from({ length: count }, (_, n) => ({
                subject: `Letter ${n}`,
                originalDate: `2026-${String(from + Math.floor(n / each)).padStart(2, '0')}-0${(n % 9) + 1}`
            }))
        );

    test('takes a leaf even for a mission of one letter', () => {
        assert.equal(contentsPages([]), 1);
        assert.equal(contentsPages(over(1)), 1);
    });

    test('gives a two-year mission a couple of leaves', () => {
        // Forty letters over ten months, which is what the archives look like.
        assert.equal(contentsPages(over(40, { each: 4 })), 2);
    });

    test('grows a leaf at a time', () => {
        assert.ok(contentsPages(over(400, { each: 20 })) > contentsPages(over(100, { each: 20 })));
    });

    test('keeps a month whole on one leaf', () => {
        // A heading at the foot of a leaf, or a run of subjects at the top of
        // one with nothing above them saying what month they are, both read as
        // faults. Neither happens while a month still fits on a leaf.
        for (const count of [40, 61, 80, 111]) {
            for (const sheet of contentsSheets(over(count, { each: 3 }))) {
                assert.notEqual(sheet.at(-1).kind, 'month', `a month ended a sheet of ${count}`);
                assert.equal(sheet[0].kind, 'month', `a sheet of ${count} began mid-month`);
            }
        }
    });
});

describe('gathering the letters into months', () => {
    test('names a month the way somebody would say it', () => {
        assert.equal(monthLabel({ originalDate: '2026-08-03T12:00:00Z' }), 'August 2026');
    });

    test('keeps a letter with no date rather than dropping it', () => {
        assert.equal(monthLabel({}), 'Undated');
        assert.equal(byMonth([{ subject: 'Lost' }])[0].letters.length, 1);
    });

    test('runs the months in the order of the book, across a change of year', () => {
        const months = byMonth([
            { subject: 'a', originalDate: '2025-12-01' },
            { subject: 'b', originalDate: '2025-12-28' },
            { subject: 'c', originalDate: '2026-01-04' }
        ]);

        assert.deepEqual(
            months.map((month) => month.label),
            ['December 2025', 'January 2026']
        );
        assert.equal(months[0].letters.length, 2);
    });
});

describe('the rectangle a photograph gets', () => {
    test('gives a landscape picture the whole column', () => {
        const rect = photoBox({ width: 2400, height: 1600 });
        assert.equal(rect.width, COLUMN);
        assert.ok(Math.abs(rect.height - COLUMN * (1600 / 2400)) < 0.01);
    });

    test('holds a portrait picture back so the text keeps its page', () => {
        const rect = photoBox({ width: 1800, height: 2400 });
        const usable = PAGE.height - MARGIN.top - MARGIN.bottom;

        assert.ok(rect.width < COLUMN);
        assert.ok(rect.height <= usable * 0.63);
        // Still the same picture, only smaller.
        assert.ok(Math.abs(rect.height / rect.width - 2400 / 1800) < 0.01);
    });

    test('assumes a shape rather than dividing by zero when the size was never recorded', () => {
        const rect = photoBox({ width: 0, height: 0 });
        assert.ok(rect.width > 0 && rect.height > 0);
    });
});

describe('preparing a photograph for the press', () => {
    test('says nothing was there rather than throwing', async () => {
        const store = memoryStore();
        assert.equal(await printPhoto({ store, slug: 'x', photoId: 'p1', widthPoints: 200 }), null);
    });

    test('reads the rendition, never the original', async () => {
        const store = memoryStore();
        await store.writeBlob('raw', 'x/photos/p1.jpg', Buffer.from('original'));

        assert.equal(await printPhoto({ store, slug: 'x', photoId: 'p1', widthPoints: 200 }), null);
    });
});

describe('how many leaves the album gets', () => {
    test('gives a letter with nothing attached no album at all', () => {
        assert.equal(albumPageCount(0), 0);
    });

    test('never crowds more than six onto a page', () => {
        for (let count = 1; count <= 40; count += 1) {
            const pages = albumPageCount(count);
            for (const leaf of albumSpread(range(count), { pages })) {
                assert.ok(leaf.length <= 6, `${count} over ${pages} put ${leaf.length} on a leaf`);
            }
        }
    });

    test('spends no more leaves than the pictures need', () => {
        // Only chapters pad now, so a looser spread buys nothing and costs a
        // sheet. Six fit a page; the seventh is what asks for a second.
        assert.equal(albumPageCount(6), 1);
        assert.equal(albumPageCount(7), 2);
        assert.equal(albumPageCount(12), 2);
        assert.equal(albumPageCount(13), 3);
    });

    test('deals every picture out once, in order', () => {
        const photos = range(17);
        const dealt = albumSpread(photos, { pages: 4 }).flat();

        assert.deepEqual(dealt, photos);
    });

    test('deals them out evenly', () => {
        const sizes = albumSpread(range(17), { pages: 4 }).map((leaf) => leaf.length);

        assert.equal(Math.max(...sizes) - Math.min(...sizes), 1);
    });
});

describe('laying photographs out in an album', () => {
    const wide = { id: 'w', width: 2400, height: 1600 };
    const tall = { id: 't', width: 1600, height: 2400 };

    const stacked = (rows) => rows.reduce((sum, row) => sum + row.height, 0) + 10 * (rows.length - 1);

    test('fills the column exactly on every full row', () => {
        const rows = albumRows([wide, wide, wide, wide, wide, wide], { target: 120 });

        for (const row of rows.slice(0, -1)) {
            const used =
                row.photos.reduce((sum, photo) => sum + row.height * (photo.width / photo.height), 0) +
                10 * (row.photos.length - 1);
            assert.ok(Math.abs(used - COLUMN) < 0.01, `row came to ${used}`);
        }
    });

    test('never stretches a lone leftover across the page', () => {
        const rows = albumRows([wide, wide, wide, tall], { target: 120 });
        const last = rows.at(-1);

        assert.ok(last.height <= 120);
    });

    test('keeps every photograph, in the order they arrived', () => {
        const photos = [wide, tall, wide, wide, tall, wide, wide];
        const flat = albumRows(photos, { target: 110 }).flatMap((row) => row.photos);

        assert.deepEqual(flat, photos);
    });

    test('makes the pictures as large as one page will take', () => {
        const usable = PAGE.height - MARGIN.top - MARGIN.bottom;
        const photos = [wide, wide, wide, tall];
        const target = albumTarget(photos, { height: usable });

        assert.ok(stacked(albumRows(photos, { target })) <= usable);
        // And is maximal: nudging the target up regroups the rows into
        // something that no longer fits. Asserting a share of the page filled
        // would be asserting something untrue -- rows must span the column
        // exactly, so four pictures come out as two rows of two and leave a
        // third of the leaf over whatever target is chosen.
        assert.ok(stacked(albumRows(photos, { target: target * 1.1 })) > usable);
    });

    test('stops shrinking rather than turning a mission into contact sheets', () => {
        const many = Array.from({ length: 60 }, () => wide);
        const target = albumTarget(many, { height: PAGE.height - MARGIN.top - MARGIN.bottom });

        assert.ok(target >= 84);
    });
});

describe('filling a leaf that has nothing else on it', () => {
    const wide = { id: 'w', width: 2400, height: 1600 };
    const tall = { id: 't', width: 1600, height: 2400 };
    const usable = PAGE.height - MARGIN.top - MARGIN.bottom;

    const leaf = (count) => Array.from({ length: count }, (_, n) => (n % 2 ? tall : wide));
    const stacked = (rows) => rows.reduce((sum, row) => sum + row.height, 0) + 10 * (rows.length - 1);
    const widths = (rows) =>
        rows.map(
            (row) =>
                row.photos.reduce((sum, photo) => sum + row.height * (photo.width / photo.height), 0) +
                10 * (row.photos.length - 1)
        );

    test('gives two photographs the page rather than a strip across the middle', () => {
        // Packed to the column, two landscape pictures come out side by side
        // and a hand's width tall, marooned in eleven inches of paper. Set
        // one above the other they are four inches each and the leaf is
        // nearly full -- nearly, because a picture may not be wider than the
        // column however much height is going spare.
        const rows = albumPlan([wide, wide], { height: usable });

        assert.ok(stacked(rows) > usable * 0.9, `used only ${Math.round(stacked(rows))} of ${usable}`);
        assert.ok(Math.min(...rows.map((row) => row.height)) > 250);
    });

    test('makes a page of two far larger than a page of six', () => {
        // The same shape throughout, because that is the only way the
        // comparison means anything: a page of six upright pictures is taller
        // per row than a page of two flat ones and would win on height while
        // losing on every other count.
        const two = albumPlan([wide, wide], { height: usable });
        const six = albumPlan(Array.from({ length: 6 }, () => wide), { height: usable });

        assert.ok(Math.min(...two.map((row) => row.height)) > Math.max(...six.map((row) => row.height)) * 1.5);
    });

    test('sets six photographs of a shape at one size rather than three', () => {
        // Judged on paper covered, a leaf of six comes out two small, two
        // large and two small, because one picture blown up pays for two
        // shrunk. Nobody arranging a page by hand has ever done that.
        const rows = albumPlan(Array.from({ length: 6 }, () => wide), { height: usable });
        const heights = rows.map((row) => row.height);

        assert.equal(rows.length, 3);
        assert.ok(Math.max(...heights) - Math.min(...heights) < 0.01);
    });

    test('never runs past the column or off the foot of the page', () => {
        for (let count = 1; count <= 6; count += 1) {
            const rows = albumPlan(leaf(count), { height: usable });

            assert.ok(Math.max(...widths(rows)) <= COLUMN + 0.01, `${count} overran the column`);
            assert.ok(stacked(rows) <= usable + 0.01, `${count} overran the page`);
        }
    });

    test('keeps every photograph, in the order they arrived', () => {
        const photos = leaf(5);
        const flat = albumPlan(photos, { height: usable }).flatMap((row) => row.photos);

        assert.deepEqual(flat, photos);
    });

    test('has nothing to arrange when there are no photographs', () => {
        assert.deepEqual(albumPlan([], { height: usable }), []);
    });
});

describe('the room a line has beside a picture', () => {
    const float = { side: 'left', top: 100, bottom: 200, width: 180 };
    const at = (y, over = {}) => reserve({ float, y, height: 16, ...over });

    test('gives a line the whole column when nothing is floating', () => {
        assert.deepEqual(reserve({ float: null, y: 300, height: 16 }), { x: MARGIN.inside, width: COLUMN });
    });

    test('pushes a line clear of a picture hanging on the left', () => {
        const band = at(120);

        assert.ok(band.x > MARGIN.inside, 'the line should start right of the picture');
        assert.equal(band.x + band.width, MARGIN.inside + COLUMN, 'and still end at the column edge');
    });

    test('shortens a line beside a picture hanging on the right without moving it', () => {
        const band = reserve({ float: { ...float, side: 'right' }, y: 120, height: 16 });

        assert.equal(band.x, MARGIN.inside);
        assert.ok(band.width < COLUMN);
    });

    test('gives back the column once the line has cleared the picture', () => {
        assert.equal(at(200).width, COLUMN);
    });

    test('keeps the column for a line that finishes above the picture', () => {
        assert.equal(at(80).width, COLUMN);
    });

    test('counts a line that only just overlaps as being beside it', () => {
        // Ninety plus a line's leading reaches into the picture, so the line
        // is beside it even though most of the line is not. Anything laxer
        // and the first line of a wrap prints straight through the photograph.
        assert.ok(at(90).width < COLUMN);
    });

    test('takes the indent of a list off the column as well', () => {
        assert.deepEqual(reserve({ float: null, y: 300, height: 16, indent: 18 }), {
            x: MARGIN.inside + 18,
            width: COLUMN - 18
        });
    });
});

describe('setting a whole book', () => {
    const posts = [
        post('c', '2026-03-08', 'Transfers again'),
        post('b', '2026-02-08', 'A very long subject that will not fit on a single line of the contents page'),
        post('a', '2026-01-04', 'Week one')
    ];

    const build = (overrides = {}) =>
        buildInterior({
            store: memoryStore(),
            slug: 'isaac.backman',
            posts,
            profile: { displayName: 'Elder Isaac Backman' },
            madeAt: '2026-06-01T00:00:00.000Z',
            ...overrides
        });

    test('produces a PDF', async () => {
        const { stream, done } = build();
        const [bytes] = await Promise.all([readPdf(stream), done]);

        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    });

    test('hands the printer a page count it will accept', async () => {
        const { stream, done } = build();
        const [, result] = await Promise.all([readPdf(stream), done]);

        // Both of these are Peecho's rules rather than ours, and both of them
        // are refusals: a book under two dozen sheets has no spine to bind
        // and an odd count has nowhere to print the back cover. Three short
        // letters come nowhere near the floor, so this is the padding being
        // exercised as much as the count.
        assert.ok(result.pages >= SHEET_LEAST, `only ${result.pages} pages`);
        assert.equal(result.pages % 2, 0, `${result.pages} pages is odd`);
    });

    test('counts the covers, because the printer does', async () => {
        // The page total is what the spine is calculated from, so it has to
        // mean sheets of paper rather than leaves of the book -- and the only
        // way to know it is telling the truth is to count the pages in the
        // file. The folios in `opens` number the book instead and stop two
        // short of this, which is the covers.
        const { stream, done } = build();
        const [bytes, result] = await Promise.all([readPdf(stream), done]);

        const written = bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? [];
        assert.equal(written.length, result.pages);
    });

    test('marks the reviewing copy without moving a single page of it', async () => {
        // The whole claim the proof makes is that it is the book. If the mark
        // pushed anything about the layout around then approving the proof
        // would be approving a different object to the one that gets bound,
        // and the contents page in the owner's hand would cite folios that
        // are not the folios in the parcel.
        const plain = build();
        const marked = build({ proof: true });

        const [plainBytes, printed] = await Promise.all([readPdf(plain.stream), plain.done]);
        const [markedBytes, proofed] = await Promise.all([readPdf(marked.stream), marked.done]);

        assert.equal(proofed.pages, printed.pages);
        assert.deepEqual(proofed.opens, printed.opens);

        // And it is actually written somewhere, on every sheet including the
        // covers -- each page's resources gain the graphics state that holds
        // the wash of gray. Counted there rather than in the content stream
        // because the content streams are compressed, and searched for the
        // state rather than the words because the text is drawn from a subset
        // font and the words are not in the file as words.
        const washes = markedBytes.toString('latin1').match(/\/ExtGState/g) ?? [];
        assert.ok(washes.length >= proofed.pages, `only ${washes.length} marks`);
        assert.equal((plainBytes.toString('latin1').match(/\/ExtGState/g) ?? []).length, 0);
    });

    test('sets a letter that carries a link, an underline and a strike', async () => {
        // Every one of these three used to take the whole book down. pdfkit
        // draws all of them from `options.textWidth`, which only its line
        // wrapper fills in and this book never uses, so each arrived at
        // `end()` as NaN -- thousands of lines of layout after the letter
        // that caused it, in a file that had already streamed most of itself
        // to storage. Nothing in the fixtures had a link in it, and the first
        // real archive to be printed did.
        const { stream, done } = build({
            posts: [
                post('a', '2026-01-04', 'Week one', {
                    bodyHtml:
                        '<p>We found the address at <a href="https://example.org/chapel">the chapel</a>' +
                        ' and <u>walked</u> back <s>twice</s>.</p>'
                })
            ]
        });
        const [bytes, result] = await Promise.all([readPdf(stream), done]);

        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
        assert.ok(result.pages >= SHEET_LEAST);

        // And the link is a link rather than blue words: the annotation is
        // written by hand now, so it is worth knowing it is still written.
        assert.match(bytes.toString('latin1'), /https:\/\/example\.org\/chapel/);
    });

    test('opens the first letter of a month on a left-hand page', async () => {
        // The chapter opening takes the recto, which drops the letter behind
        // it onto the verso -- so a one-page letter still has its photographs
        // on the leaf facing it. Every letter in this fixture is the first of
        // its month. It also has to survive the front matter, which is partly
        // what the title page and the word cloud are placed around.
        const { stream, done } = build();
        const [, result] = await Promise.all([readPdf(stream), done]);

        for (const opened of result.opens) {
            assert.equal(opened.page % 2, 0, `${opened.id} opened on page ${opened.page}`);
        }
    });

    test('still lands the month on a left-hand page however many photographs it carries', async () => {
        // An album of an odd length is what used to force the padding, so it
        // takes one to exercise the parity at all. Now the chapter opening
        // absorbs it instead.
        const { stream, done } = build({
            posts: posts.map((entry, index) => ({
                ...entry,
                photos: Array.from({ length: index * 3 }, (_, n) => ({
                    id: `${entry.id}-${n}`,
                    width: 2400,
                    height: 1600
                }))
            }))
        });
        const [, result] = await Promise.all([readPdf(stream), done]);

        for (const opened of result.opens) {
            assert.equal(opened.page % 2, 0, `${opened.id} opened on page ${opened.page}`);
        }
    });

    test('starts each later letter of a month on the very next page', async () => {
        // Four one-page letters in one month. Bringing every letter round
        // onto a verso used to put a blank leaf between each pair of them;
        // only the chapter pads now, so they run straight on.
        const { stream, done } = build({
            posts: [
                post('d', '2026-01-25', 'Week four'),
                post('c', '2026-01-18', 'Week three'),
                post('b', '2026-01-11', 'Week two'),
                post('a', '2026-01-04', 'Week one')
            ]
        });
        const [, result] = await Promise.all([readPdf(stream), done]);

        const folios = result.opens.map((opened) => opened.page);
        assert.equal(folios[0] % 2, 0, `the month opened on page ${folios[0]}`);
        assert.deepEqual(folios, [0, 1, 2, 3].map((n) => folios[0] + n));
    });

    test('never puts two letters on the same page', async () => {
        const { stream, done } = build();
        const [, result] = await Promise.all([readPdf(stream), done]);

        const seen = new Set(result.opens.map((opened) => opened.page));
        assert.equal(seen.size, result.opens.length);
    });

    test('runs the letter round a picture rather than under it', async () => {
        // The same letter twice, differing only in where its photograph sits.
        // With plenty of text after it the picture hangs in the margin and
        // the words fill the space beside it; with nothing after it there is
        // nothing to wrap, so it is set across the column instead and costs
        // the height of the whole picture. Wrapping has to be the shorter of
        // the two or it is not doing anything.
        const photo = '<img src="/api/photo/isaac.backman/p1/large.webp">';
        const words = `<p>${'We walked out early and the streets were still wet. '.repeat(44)}</p>`;
        const letter = (bodyHtml) => [
            { ...post('a', '2026-01-04', 'Week one'), bodyHtml, photos: [{ id: 'p1', width: 2400, height: 1600 }] }
        ];

        const set = async (bodyHtml) => {
            // Measuring layout, so the printer's rules are turned off. Padded
            // up to two dozen pages and rounded to an even count, both books
            // would come to the same length and the difference this test
            // exists to see would be paper.
            const { stream, done } = build({ posts: letter(bodyHtml), least: 0 });
            const [, result] = await Promise.all([readPdf(stream), done]);
            return result.pages;
        };

        const wrapped = await set(photo + words);
        const stacked = await set(words + photo);

        assert.ok(wrapped < stacked, `wrapped ${wrapped}, stacked ${stacked}`);
    });

    test('names the book on the file itself', async () => {
        const { stream, done } = build();
        const [bytes] = await Promise.all([readPdf(stream), done]);

        assert.match(bytes.toString('latin1'), /Elder Isaac Backman/);
    });

    test('falls back to the slug when there is no display name', async () => {
        const { stream, done } = build({ profile: {} });
        const [bytes] = await Promise.all([readPdf(stream), done]);

        assert.match(bytes.toString('latin1'), /isaac\.backman/);
    });

    test('paginates identically whether or not the photographs are there', async () => {
        // This is the invariant the contents page rests on. The measuring
        // pass fetches no bytes at all, so if a picture's presence changed
        // the layout by so much as a line, every page number printed in the
        // contents would be a lie -- and one nobody would catch until a book
        // came back from the printer.
        const withPhotos = posts.map((entry) =>
            entry.id === 'b'
                ? { ...entry, photos: [{ id: 'p1', width: 2400, height: 1600 }] }
                : entry
        );

        const empty = memoryStore();
        const first = buildInterior({
            store: empty,
            slug: 'isaac.backman',
            posts: withPhotos,
            profile: { displayName: 'Elder Isaac Backman' },
            madeAt: '2026-06-01T00:00:00.000Z'
        });
        const [, blank] = await Promise.all([readPdf(first.stream), first.done]);

        // Same book, same rectangles, but now the bytes are actually there.
        const filled = memoryStore();
        await filled.writeBlob(
            'rendered',
            'isaac.backman/photos/p1/large.webp',
            await pixels(2400, 1600)
        );
        const second = buildInterior({
            store: filled,
            slug: 'isaac.backman',
            posts: withPhotos,
            profile: { displayName: 'Elder Isaac Backman' },
            madeAt: '2026-06-01T00:00:00.000Z'
        });
        const [, printed] = await Promise.all([readPdf(second.stream), second.done]);

        assert.equal(printed.pages, blank.pages);
    });

    test('finishes a book whose photograph cannot be read', async () => {
        const store = memoryStore();
        await store.writeBlob('rendered', 'isaac.backman/photos/p1/large.webp', Buffer.from('not an image'));

        const warned = [];
        const { stream, done } = build({
            store,
            log: { warn: (event, detail) => warned.push({ event, detail }) },
            posts: posts.map((entry) =>
                entry.id === 'b'
                    ? { ...entry, photos: [{ id: 'p1', width: 2400, height: 1600 }] }
                    : entry
            )
        });
        const [bytes, result] = await Promise.all([readPdf(stream), done]);

        assert.ok(result.pages > 0);
        assert.ok(bytes.length > 0);
        assert.equal(warned[0]?.event, 'book.photoFailed');
    });

    test('leaves a photograph in its own proportions even when the recorded shape is wrong', async () => {
        // Dimensions are recorded once, at ingest, and nothing reads the
        // rendition back to check them -- so a letter written before a fix to
        // how orientation was read still claims a shape its picture does not
        // have, and for a while every photograph shot upright claimed the
        // landscape rectangle its sensor recorded. Handed a width and a
        // height, pdfkit makes the picture exactly that, and a face comes out
        // half again as wide as it should be. Cropped to the same rectangle
        // instead, nobody can tell.
        const store = memoryStore();
        await store.writeBlob('rendered', 'isaac.backman/photos/p1/large.webp', await pixels(600, 800));

        const { stream, done } = build({
            store,
            posts: [
                {
                    ...post('a', '2026-01-04', 'Week one'),
                    photos: [{ id: 'p1', width: 2400, height: 1600 }]
                }
            ]
        });
        const [bytes] = await Promise.all([readPdf(stream), done]);

        // pdfkit draws an image by scaling the unit square, so the matrix it
        // writes is the size on the page: `w 0 0 -h x y cm` and then the
        // picture. One photograph, so one of them.
        const drawn = [...drawnIn(bytes).matchAll(/([\d.]+) 0 0 -([\d.]+) [-\d.]+ [-\d.]+ cm\s+\/I\d+ Do/g)];

        assert.equal(drawn.length, 1);

        const shape = Number(drawn[0][1]) / Number(drawn[0][2]);
        assert.ok(Math.abs(shape - 600 / 800) < 0.01, `drawn ${shape.toFixed(3)} wide for every unit tall`);
    });
});

describe('binding the book in a color', () => {
    const posts = [post('a', '2026-01-04', 'Week one')];

    const build = (overrides = {}) =>
        buildInterior({
            store: memoryStore(),
            slug: 'isaac.backman',
            posts,
            profile: { displayName: 'Elder Isaac Backman' },
            madeAt: '2026-06-01T00:00:00.000Z',
            ...overrides
        });

    // Two boards, front and back, each the whole sheet. Anything less is a
    // book with a white edge round its cover. The color is written after the
    // rectangle because that is the order pdfkit emits a filled path in, and
    // as `scn` in a named space rather than as `rg`.
    const boards = (bytes) => [
        ...drawnIn(bytes).matchAll(
            /0 0 612 792 re\s+\/DeviceRGB cs\s+([\d.]+) ([\d.]+) ([\d.]+) scn/g
        )
    ];

    test('paints both boards in the chosen cloth', async () => {
        const { stream, done } = build({ cover: { cloth: 'navy' } });
        const [bytes] = await Promise.all([readPdf(stream), done]);

        const painted = boards(bytes);
        assert.equal(painted.length, 2);

        // #223349, which pdfkit writes as three fractions of one.
        const [, red, green, blue] = painted[0];
        assert.ok(Math.abs(Number(red) - 0x22 / 255) < 0.01);
        assert.ok(Math.abs(Number(green) - 0x33 / 255) < 0.01);
        assert.ok(Math.abs(Number(blue) - 0x49 / 255) < 0.01);
    });

    test('binds a book nobody has chosen a color for', async () => {
        const { stream, done } = build();
        const [bytes] = await Promise.all([readPdf(stream), done]);

        // Whatever the default is, it is a color and it is on both boards.
        // A white cover is the one answer an owner has already rejected.
        assert.equal(boards(bytes).length, 2);
    });

    test('prints a picture across the top of the front board', async () => {
        const { stream, done } = build({ cover: { cloth: 'linen', bytes: await pixels(1600, 1200) } });
        const [bytes] = await Promise.all([readPdf(stream), done]);
        const drawing = drawnIn(bytes);

        // The band is a clip rather than a rectangle the picture is squashed
        // into: it is the full width of the board and a little over half its
        // height, and whatever is behind it is cropped to fit.
        assert.match(drawing, /0 0 612 411\.84 re\s+W/);

        // One picture, drawn at least as large as the band in both directions
        // -- which is what covering it means, and the opposite of stretching
        // to fit it.
        const drawn = [...drawing.matchAll(/([\d.]+) 0 0 -([\d.]+) [-\d.]+ [-\d.]+ cm\s+\/I\d+ Do/g)];

        assert.equal(drawn.length, 1);
        assert.ok(Number(drawn[0][1]) >= PAGE.width - 0.5);
        assert.ok(Number(drawn[0][2]) >= PAGE.height * 0.52 - 0.5);
    });

    test('does not move a single page by choosing a cover', async () => {
        // The measuring pass is given the color but not the picture, and
        // this is the reason that is safe: a cover is one page whatever is
        // printed on it. If it ever stopped being one page, the contents
        // would start naming the wrong folios and nothing else would say so.
        const plain = build();
        const [, first] = await Promise.all([readPdf(plain.stream), plain.done]);

        const dressed = build({ cover: { cloth: 'oxblood', bytes: await pixels(1600, 1200) } });
        const [, second] = await Promise.all([readPdf(dressed.stream), dressed.done]);

        assert.equal(second.pages, first.pages);
        assert.deepEqual(second.opens, first.opens);
    });

    test('still makes a book when the cover picture is unreadable', async () => {
        const warned = [];
        const { stream, done } = build({
            cover: { cloth: 'forest', bytes: Buffer.from('not an image') },
            log: { warn: (event, detail) => warned.push({ event, detail }) }
        });
        const [bytes, result] = await Promise.all([readPdf(stream), done]);

        assert.ok(result.pages > 0);
        assert.equal(boards(bytes).length, 2);
        assert.equal(warned[0]?.event, 'book.coverFailed');
    });
});

describe('the word cloud in the front of the book', () => {
    // Twenty words, the first twenty times as common as the last. A real
    // archive is shaped roughly like this and a fixture where everything
    // appears once would set the whole cloud at one size and prove nothing.
    const vocabulary = [
        'companion', 'transfer', 'baptism', 'district', 'investigator',
        'chapel', 'branch', 'president', 'apartment', 'scriptures',
        'conference', 'testimony', 'language', 'bicycle', 'laundry',
        'miracle', 'portuguese', 'service', 'temple', 'dinner'
    ];

    const wordy = (id, date, subject) =>
        post(id, date, subject, {
            bodyHtml: `<p>${vocabulary
                .map((word, rank) => `${word} `.repeat(vocabulary.length - rank))
                .join('')}</p>`
        });

    const build = (posts) =>
        buildInterior({
            store: memoryStore(),
            slug: 'isaac.backman',
            posts,
            profile: { displayName: 'Elder Isaac Backman' },
            madeAt: '2026-06-01T00:00:00.000Z'
        });

    // Every point size pdfkit was asked to set anything in, anywhere in the
    // file. A cloud is sixty words at sixty sizes, so it shows up here as a
    // crowd and its absence shows up as a handful.
    const sizes = (bytes) =>
        new Set([...drawnIn(bytes).matchAll(/\/F\d+ ([\d.]+) Tf/g)].map((match) => match[1]));

    test('takes a leaf that was going to be printed anyway', async () => {
        // The cloud sits on the title page's verso, which was always being
        // printed for the imprint, so it costs no sheet of its own. What it
        // does do is flip the parity of the front matter, and a chapter has
        // to open on a recto: title 1, cloud 2, one page of contents 3, a
        // blank 4, the chapter opening 5, the first letter 6.
        const { stream, done } = build([
            wordy('a', '2026-01-04', 'Week one'),
            wordy('b', '2026-02-08', 'Week six')
        ]);
        const [, result] = await Promise.all([readPdf(stream), done]);

        assert.equal(result.opens[0].page, 6);
    });

    test('sets the words at a whole range of sizes', async () => {
        const { stream, done } = build([
            wordy('a', '2026-01-04', 'Week one'),
            wordy('b', '2026-02-08', 'Week six')
        ]);
        const [bytes] = await Promise.all([readPdf(stream), done]);

        assert.ok(sizes(bytes).size > 20, `only ${sizes(bytes).size} sizes in the whole book`);
    });

    test('leaves the leaf blank rather than printing three words large', async () => {
        // An archive of two short letters has no cloud in it, and a handful of
        // words blown up to fill a page looks like a mistake rather than like
        // a summary. The leaf still gets printed, because it is the back of
        // the title page and everything after it is placed from there.
        const thin = build([post('a', '2026-01-04', 'Week one')]);
        const [thinBytes, result] = await Promise.all([readPdf(thin.stream), thin.done]);

        assert.equal(result.opens[0].page, 6);
        assert.ok(sizes(thinBytes).size < 20, 'something was set on the blank leaf');
    });
});

// A real WebP, because the transcode is the part being trusted.
async function pixels(width, height) {
    const { default: sharp } = await import('sharp');
    return sharp({
        create: { width, height, channels: 3, background: { r: 90, g: 140, b: 160 } }
    })
        .webp()
        .toBuffer();
}
