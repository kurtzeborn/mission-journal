import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    BOOKS,
    STATE,
    bookName,
    coverProfile,
    latestBook,
    manifestName,
    missingForBook,
    proofName,
    readBook,
    requestBook,
    runBook,
    statusName
} from '../src/lib/publish.js';
import { memoryStore } from './memory-store.js';

const SLUG = 'isaac.backman';

const post = (id, date, subject, extra = {}) => ({
    id,
    originalDate: `${date}T12:00:00.000Z`,
    subject,
    bodyHtml: '<p>We walked out early and the streets were still wet.</p>',
    photos: [],
    ...extra
});

const seed = (posts, profile = { displayName: 'Elder Isaac Backman', mission: 'Chile Santiago' }) => {
    const store = memoryStore();

    store.blobs.set(`rendered/${SLUG}/posts.json`, {
        bytes: Buffer.from(JSON.stringify(posts), 'utf8'),
        metadata: {},
        etag: 'etag-posts'
    });

    if (profile) {
        store.blobs.set(`config/${SLUG}/profile.json`, {
            bytes: Buffer.from(JSON.stringify({ slug: SLUG, ...profile }), 'utf8'),
            metadata: {},
            etag: 'etag-profile'
        });
    }

    return store;
};

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

const letters = [
    post('a', '2026-01-04', 'Week one'),
    post('b', '2026-02-08', 'Transfers again'),
    post('c', '2026-03-15', 'A baptism')
];

describe('what a site needs before it can be printed', () => {
    it('refuses only over the name, which is the title of the book', () => {
        assert.deepEqual(missingForBook({ displayName: 'Elder Isaac Backman', mission: 'Chile Santiago' }), []);
        assert.deepEqual(missingForBook({ mission: 'Chile Santiago' }), ['displayName']);
    });

    it('asks for a mission without insisting on one', () => {
        assert.deepEqual(missingForBook({ displayName: 'Elder Isaac Backman' }), ['mission']);
    });

    it('dates the cover from the letters when nobody has said otherwise', () => {
        const filled = coverProfile({ displayName: 'Elder Isaac Backman' }, letters);

        assert.equal(filled.startDate, '2026-01-04');
        assert.equal(filled.returnDate, '2026-03-15');
    });

    it('leaves dates the owner did set alone', () => {
        const filled = coverProfile(
            { displayName: 'Elder Isaac Backman', startDate: '2025-12-01', returnDate: '2027-12-01' },
            letters
        );

        assert.equal(filled.startDate, '2025-12-01');
        assert.equal(filled.returnDate, '2027-12-01');
    });
});

describe('asking for a book', () => {
    it('records that one is being built before it asks for it to be built', async () => {
        const store = seed(letters);
        const result = await requestBook({ store, slug: SLUG, principal: { userDetails: 'mum@example.com' }, log: quiet });

        const status = store.json(BOOKS, statusName(SLUG, result.id));
        assert.equal(status.state, STATE.building);
        assert.deepEqual(store.queues.get('book'), [JSON.stringify({ slug: SLUG, id: result.id })]);
    });

    it('will not print a site with no name on it', async () => {
        const store = seed(letters, { mission: 'Chile Santiago' });
        const result = await requestBook({ store, slug: SLUG, log: quiet });

        assert.equal(result.error, 'incomplete');
        assert.deepEqual(result.missing, ['displayName']);
        assert.equal(store.queues.get('book'), undefined);
    });

    it('hands back the build already running rather than starting a second', async () => {
        const store = seed(letters);
        const first = await requestBook({ store, slug: SLUG, log: quiet });
        const second = await requestBook({ store, slug: SLUG, log: quiet });

        assert.equal(second.error, 'building');
        assert.equal(second.id, first.id);
        assert.equal(store.queues.get('book').length, 1);
    });

    it('starts again once a build has been running far too long to still be running', async () => {
        const store = seed(letters);
        const first = await requestBook({ store, slug: SLUG, now: new Date('2026-06-01T00:00:00.000Z'), log: quiet });
        const second = await requestBook({ store, slug: SLUG, now: new Date('2026-06-01T02:00:00.000Z'), log: quiet });

        assert.notEqual(second.id, first.id);
        assert.equal(store.queues.get('book').length, 2);
    });

    it('names books so that the newest one sorts last', async () => {
        const store = seed(letters);
        const first = await requestBook({ store, slug: SLUG, now: new Date('2026-06-01T00:00:00.000Z'), log: quiet });
        const second = await requestBook({ store, slug: SLUG, now: new Date('2026-07-01T00:00:00.000Z'), log: quiet });

        assert.ok(first.id < second.id, `${first.id} should sort before ${second.id}`);
        assert.equal((await latestBook({ store, slug: SLUG }))?.id, second.id);
    });
});

describe('building the book', () => {
    it('leaves a PDF, a manifest and a finished status behind', async () => {
        const store = seed(letters);
        const { id } = await requestBook({ store, slug: SLUG, log: quiet });

        await runBook({ message: { slug: SLUG, id }, store, log: quiet });

        const pdf = store.blobs.get(`${BOOKS}/${bookName(SLUG, id)}`);
        assert.ok(pdf.bytes.subarray(0, 5).toString('latin1') === '%PDF-', 'that is not a PDF');
        assert.equal(pdf.contentType, 'application/pdf');

        const status = await readBook({ store, slug: SLUG, id });
        assert.equal(status.state, STATE.ready);
        assert.equal(status.letters, 3);
        assert.ok(status.pages >= 24);

        const manifest = store.json(BOOKS, manifestName(SLUG, id));
        assert.deepEqual(
            manifest.posts.map((entry) => entry.id),
            ['a', 'b', 'c']
        );
    });

    it('leaves a copy that can be shown to somebody as well as one that can be printed', async () => {
        const store = seed(letters);
        const { id } = await requestBook({ store, slug: SLUG, log: quiet });

        await runBook({ message: { slug: SLUG, id }, store, log: quiet });

        const print = store.blobs.get(`${BOOKS}/${bookName(SLUG, id)}`);
        const proof = store.blobs.get(`${BOOKS}/${proofName(SLUG, id)}`);

        assert.ok(proof, 'no proof was written');
        assert.equal(proof.contentType, 'application/pdf');

        // The mark is the difference, and it is the only difference that is
        // safe to assert on here -- these letters carry no photographs, so
        // the resolution the proof also drops changes nothing about the
        // bytes. `ExtGState` is the wash of grey it is written in, and the
        // print file has no transparency in it anywhere.
        assert.ok(proof.bytes.toString('latin1').includes('/ExtGState'));
        assert.ok(!print.bytes.toString('latin1').includes('/ExtGState'));
    });

    it('keeps a held letter out of a permanent object', async () => {
        const store = seed([...letters, post('d', '2026-04-01', 'Not for the family', { hidden: true })]);
        const { id } = await requestBook({ store, slug: SLUG, log: quiet });

        await runBook({ message: { slug: SLUG, id }, store, log: quiet });

        const manifest = store.json(BOOKS, manifestName(SLUG, id));
        assert.deepEqual(
            manifest.posts.map((entry) => entry.id),
            ['a', 'b', 'c']
        );
    });

    it('says why it could not build rather than failing silently', async () => {
        const store = seed([]);
        const { id } = await requestBook({ store, slug: SLUG, log: quiet });

        const result = await runBook({ message: { slug: SLUG, id }, store, log: quiet });

        assert.equal(result.status, 'failed');
        const status = await readBook({ store, slug: SLUG, id });
        assert.equal(status.state, STATE.failed);
        assert.match(status.error, /no letters/);
    });

    it('gives up rather than waits when the build fails after the upload has started', { timeout: 20000 }, async () => {
        // A corrupt rendition record, which is the shape of every failure
        // that lands mid-book: by the time it is discovered the PDF stream
        // exists, storage is reading it, and most of the file has already
        // gone. Abandoning that stream quietly leaves the upload waiting for
        // bytes that will never come -- the invocation then runs to the
        // platform's timeout with nothing written, the status blob says
        // "building" until the stale sweep gives up on it, and the owner
        // watches a spinner for three quarters of an hour. It has to fail
        // out loud instead, which is what the timeout on this test is for.
        const store = seed([...letters, post('d', '2026-04-01', 'Corrupt', { photos: {} })]);
        const { id } = await requestBook({ store, slug: SLUG, log: quiet });

        const result = await runBook({ message: { slug: SLUG, id }, store, log: quiet });

        assert.equal(result.status, 'failed');
        const status = await readBook({ store, slug: SLUG, id });
        assert.equal(status.state, STATE.failed);
    });

    it('does nothing at all when the site went away between the request and the build', async () => {
        const store = seed(letters);
        const result = await runBook({ message: { slug: SLUG, id: 'never-asked-for' }, store, log: quiet });

        assert.equal(result.status, 'missing');
        assert.equal(store.blobs.has(`${BOOKS}/${bookName(SLUG, 'never-asked-for')}`), false);
    });

    it('refuses a message it cannot act on', async () => {
        const result = await runBook({ message: { slug: SLUG }, store: seed(letters), log: quiet });

        assert.equal(result.status, 'rejected');
    });
});
