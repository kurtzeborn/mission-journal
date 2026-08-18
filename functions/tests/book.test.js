import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    COLUMN,
    MARGIN,
    PAGE,
    buildInterior,
    contentsPages,
    dateLine,
    inReadingOrder,
    mirror,
    photoBox,
    printPhoto
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

const post = (id, date, subject, overrides = {}) => ({
    id,
    originalDate: `${date}T12:00:00.000Z`,
    subject,
    bodyHtml: '<p>We walked out early and the streets were still wet.</p>',
    photos: [],
    ...overrides
});

describe('the order a book runs in', () => {
    it('turns the newest-first payload back into a mission', () => {
        const posts = [post('c', '2026-03-01', 'Third'), post('b', '2026-02-01', 'Second'), post('a', '2026-01-01', 'First')];

        assert.deepEqual(
            inReadingOrder(posts).map((entry) => entry.id),
            ['a', 'b', 'c']
        );
    });

    it('leaves the payload it was handed alone', () => {
        const posts = [post('b', '2026-02-01', 'Second'), post('a', '2026-01-01', 'First')];
        inReadingOrder(posts);

        assert.deepEqual(
            posts.map((entry) => entry.id),
            ['b', 'a']
        );
    });
});

describe('the date over a letter', () => {
    it('writes the day out in full', () => {
        assert.equal(dateLine({ originalDate: '2026-01-04T09:00:00.000Z' }), 'Sunday, January 4, 2026');
    });

    it('reads the day in UTC rather than wherever the server is', () => {
        // An evening timestamp is the one that slips a day westward, which is
        // where every date-off-by-one in this codebase has come from.
        assert.equal(dateLine({ originalDate: '2026-01-04T23:30:00.000Z' }), 'Sunday, January 4, 2026');
    });

    it('says nothing rather than something wrong when the date is missing', () => {
        assert.equal(dateLine({}), '');
        assert.equal(dateLine({ originalDate: 'sometime' }), '');
    });
});

describe('which way the gutter faces', () => {
    it('leaves right-hand pages where they were set', () => {
        assert.equal(mirror(1), 0);
        assert.equal(mirror(7), 0);
    });

    it('slides left-hand pages across by the difference between the margins', () => {
        const across = -(MARGIN.inside - MARGIN.outside);
        assert.equal(mirror(2), across);
        assert.equal(mirror(8), across);
    });

    it('keeps the column the same width on both, which is what makes the shift legal', () => {
        assert.equal(COLUMN, PAGE.width - MARGIN.inside - MARGIN.outside);
        assert.ok(MARGIN.inside > MARGIN.outside);
    });
});

describe('how much room the contents need', () => {
    it('takes a leaf even for a mission of one letter', () => {
        assert.equal(contentsPages(0), 1);
        assert.equal(contentsPages(1), 1);
    });

    it('grows a leaf at a time', () => {
        assert.equal(contentsPages(32), 1);
        assert.equal(contentsPages(33), 2);
        assert.equal(contentsPages(120), 4);
    });
});

describe('the rectangle a photograph gets', () => {
    it('gives a landscape picture the whole column', () => {
        const rect = photoBox({ width: 2400, height: 1600 });
        assert.equal(rect.width, COLUMN);
        assert.ok(Math.abs(rect.height - COLUMN * (1600 / 2400)) < 0.01);
    });

    it('holds a portrait picture back so the text keeps its page', () => {
        const rect = photoBox({ width: 1800, height: 2400 });
        const usable = PAGE.height - MARGIN.top - MARGIN.bottom;

        assert.ok(rect.width < COLUMN);
        assert.ok(rect.height <= usable * 0.63);
        // Still the same picture, only smaller.
        assert.ok(Math.abs(rect.height / rect.width - 2400 / 1800) < 0.01);
    });

    it('assumes a shape rather than dividing by zero when the size was never recorded', () => {
        const rect = photoBox({ width: 0, height: 0 });
        assert.ok(rect.width > 0 && rect.height > 0);
    });
});

describe('preparing a photograph for the press', () => {
    it('says nothing was there rather than throwing', async () => {
        const store = memoryStore();
        assert.equal(await printPhoto({ store, slug: 'x', photoId: 'p1', widthPoints: 200 }), null);
    });

    it('reads the rendition, never the original', async () => {
        const store = memoryStore();
        await store.writeBlob('raw', 'x/photos/p1.jpg', Buffer.from('original'));

        assert.equal(await printPhoto({ store, slug: 'x', photoId: 'p1', widthPoints: 200 }), null);
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

    it('produces a PDF', async () => {
        const { stream, done } = build();
        const [bytes] = await Promise.all([readPdf(stream), done]);

        assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    });

    it('reports the page count the cover will need', async () => {
        const { stream, done } = build();
        const [, result] = await Promise.all([readPdf(stream), done]);

        // Title, contents, three letters each opening on a fresh page, and a
        // colophon. The exact number is layout's business; that there is one,
        // and that it is at least this, is the spine's.
        assert.ok(result.pages >= 6, `expected a book, got ${result.pages} pages`);
    });

    it('names the book on the file itself', async () => {
        const { stream, done } = build();
        const [bytes] = await Promise.all([readPdf(stream), done]);

        assert.match(bytes.toString('latin1'), /Elder Isaac Backman/);
    });

    it('falls back to the slug when there is no display name', async () => {
        const { stream, done } = build({ profile: {} });
        const [bytes] = await Promise.all([readPdf(stream), done]);

        assert.match(bytes.toString('latin1'), /isaac\.backman/);
    });

    it('paginates identically whether or not the photographs are there', async () => {
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

    it('finishes a book whose photograph cannot be read', async () => {
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
