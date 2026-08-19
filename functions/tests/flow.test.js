// The service-wide arrivals view.
//
// This is a report rather than a decision -- nothing here grants anything or
// destroys anything -- so what is worth testing is not correctness in the
// usual sense but whether it can be *trusted*. A monitoring page that quietly
// omits an archive, or that reports a claimed site as still holding letters,
// or that agrees with itself by construction, is worse than no page at all:
// somebody looks at it, sees nothing wrong, and stops looking.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { serviceFlow, STATE } from '../src/lib/flow.js';
import { touchSiteActivity, forgetSite } from '../src/lib/sites.js';
import { TABLES } from '../src/lib/tables.js';
import { DELETION_RECORD } from '../src/lib/deletion.js';
import { memoryStore } from './memory-store.js';

const utf8 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');

const held = async (store, slug, { letters = 1, manifest = {} } = {}) => {
    for (let n = 0; n < letters; n++) {
        await store.writeBlob('pending', `${slug}/0${n}.eml`, Buffer.from('raw'));
    }
    await store.writeBlob('pending', `${slug}/claim.json`, utf8({ slug, ...manifest }));
};

const deleted = (store, slug) =>
    store.upsertEntity(TABLES.deletions, {
        partitionKey: slug,
        rowKey: DELETION_RECORD,
        deletedAt: '2026-08-01T00:00:00.000Z',
        purgeAfter: '2026-08-31T00:00:00.000Z'
    });

const bySlug = (flow) => new Map(flow.archives.map((row) => [row.slug, row]));

const flowOf = (store) => serviceFlow({ store, tables: store });

describe('the two dates are different questions', () => {
    test('a backlog is not an archive gone quiet', async () => {
        // The case the whole second column exists for. A family forwarding two
        // years of mail in an evening is the busiest this archive has ever
        // been, and on `lastPostAt` alone it reads as eighteen months silent.
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2025-02-11T09:00:00.000Z',
            receivedAt: '2026-08-19T21:30:00.000Z'
        });

        const [archive] = (await flowOf(store)).archives;

        assert.equal(archive.lastPostAt, '2025-02-11T09:00:00.000Z');
        assert.equal(archive.lastReceivedAt, '2026-08-19T21:30:00.000Z');
    });

    test('and the arrival is what the service reports as its own last sign of life', async () => {
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2025-02-11T09:00:00.000Z',
            receivedAt: '2026-08-19T21:30:00.000Z'
        });

        assert.equal((await flowOf(store)).lastReceivedAt, '2026-08-19T21:30:00.000Z');
    });

    test('a row from before arrivals were recorded stays blank rather than agreeing', async () => {
        // Filling this in from `lastPostAt` would make the two columns agree by
        // construction on exactly the archives with the longest history, which
        // is where a real gap is most likely to be.
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2025-02-11T09:00:00.000Z'
        });

        const [archive] = (await flowOf(store)).archives;

        assert.equal(archive.lastReceivedAt, '');
        assert.equal(archive.lastPostAt, '2025-02-11T09:00:00.000Z');
    });

    test('and it still ranks on the letter it has rather than sinking to the bottom', async () => {
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'has.history',
            lastPostAt: '2026-08-01T09:00:00.000Z'
        });
        await touchSiteActivity({
            tables: store,
            slug: 'just.started',
            lastPostAt: '2020-01-01T09:00:00.000Z',
            receivedAt: '2020-01-01T09:00:00.000Z'
        });

        const order = (await flowOf(store)).archives.map((row) => row.slug);

        assert.deepEqual(order, ['has.history', 'just.started']);
    });

    test('a later letter moves both dates on', async () => {
        const store = memoryStore();
        const slug = 'elder.example';
        await touchSiteActivity({
            tables: store,
            slug,
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:05:00.000Z'
        });
        await touchSiteActivity({
            tables: store,
            slug,
            lastPostAt: '2026-08-08T09:00:00.000Z',
            receivedAt: '2026-08-08T09:05:00.000Z'
        });

        const [archive] = (await flowOf(store)).archives;

        assert.equal(archive.lastPostAt, '2026-08-08T09:00:00.000Z');
        assert.equal(archive.lastReceivedAt, '2026-08-08T09:05:00.000Z');
    });
});

describe('what order the page is in', () => {
    test('most recently active first, not longest silent first', async () => {
        // Longest-silent sounds like the right way round for a monitoring page
        // and is not: a missionary who came home is silent forever and
        // legitimately so, and within a year the top of that list would be
        // nothing but finished archives.
        const store = memoryStore();
        for (const [slug, at] of [
            ['quiet.one', '2024-03-02T00:00:00.000Z'],
            ['busy.one', '2026-08-19T00:00:00.000Z'],
            ['middling.one', '2026-01-05T00:00:00.000Z']
        ]) {
            await touchSiteActivity({ tables: store, slug, lastPostAt: at, receivedAt: at });
        }

        const order = (await flowOf(store)).archives.map((row) => row.slug);

        assert.deepEqual(order, ['busy.one', 'middling.one', 'quiet.one']);
    });

    test('the headline is the newest arrival anywhere, whichever archive it was', async () => {
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'quiet.one',
            lastPostAt: '2024-03-02T00:00:00.000Z',
            receivedAt: '2024-03-02T00:00:00.000Z'
        });
        await touchSiteActivity({
            tables: store,
            slug: 'busy.one',
            lastPostAt: '2026-08-19T00:00:00.000Z',
            receivedAt: '2026-08-19T00:00:00.000Z'
        });

        assert.equal((await flowOf(store)).lastReceivedAt, '2026-08-19T00:00:00.000Z');
    });

    test('an empty service says so without inventing a date', async () => {
        const flow = await flowOf(memoryStore());

        assert.deepEqual(flow.archives, []);
        assert.equal(flow.lastReceivedAt, '');
    });
});

describe('what state each archive is in', () => {
    test('an ordinary one is live', async () => {
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:00:00.000Z'
        });

        assert.equal((await flowOf(store)).archives[0].state, STATE.live);
    });

    test('a deleted one is named as deleted rather than looking like a working site', async () => {
        // Deletion leaves the site row in place, so without this the archive
        // sits here indistinguishable from a live one -- and this page is
        // where somebody goes to be told otherwise.
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:00:00.000Z'
        });
        await deleted(store, 'elder.example');

        assert.equal((await flowOf(store)).archives[0].state, STATE.deleted);
    });

    test('a slug with letters and no site row is pending', async () => {
        const store = memoryStore();
        await held(store, 'elder.new', {
            letters: 3,
            manifest: {
                lastMessageAt: '2026-08-18T12:00:00.000Z',
                expiresAt: '2026-09-01T12:00:00.000Z'
            }
        });

        const [archive] = (await flowOf(store)).archives;

        assert.equal(archive.state, STATE.pending);
        assert.equal(archive.held, 3);
        assert.equal(archive.lastReceivedAt, '2026-08-18T12:00:00.000Z');
        assert.equal(archive.expiresAt, '2026-09-01T12:00:00.000Z');
    });

    test('and it ranks alongside the real ones on the date its letters arrived', async () => {
        // A pending site is the one row here about a family nobody has met,
        // and it is also the likeliest thing to be wrong. Sorting it to the
        // bottom would hide it.
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.old',
            lastPostAt: '2026-01-01T00:00:00.000Z',
            receivedAt: '2026-01-01T00:00:00.000Z'
        });
        await held(store, 'elder.new', {
            manifest: { lastMessageAt: '2026-08-18T12:00:00.000Z' }
        });

        const order = (await flowOf(store)).archives.map((row) => row.slug);

        assert.deepEqual(order, ['elder.new', 'elder.old']);
    });

    test('a pending slug appears even when its manifest will not parse', async () => {
        // An unreadable manifest is exactly the sort of thing this page must
        // not hide, so the slug survives on the strength of its letters alone.
        const store = memoryStore();
        await store.writeBlob('pending', 'elder.broken/01.eml', Buffer.from('raw'));
        await store.writeBlob('pending', 'elder.broken/claim.json', Buffer.from('{ not json'));

        const [archive] = (await flowOf(store)).archives;

        assert.equal(archive.slug, 'elder.broken');
        assert.equal(archive.state, STATE.pending);
        assert.equal(archive.held, 1);
    });

    test('a manifest with no letters left beside it is not an archive', async () => {
        // Promotion deletes the blobs and leaves the manifest, so a claimed
        // site would otherwise reappear here forever as pending.
        const store = memoryStore();
        await store.writeBlob(
            'pending',
            'elder.claimed/claim.json',
            utf8({ slug: 'elder.claimed', claimedAt: '2026-02-01T00:00:00.000Z' })
        );

        assert.deepEqual((await flowOf(memoryStore())).archives, []);
        assert.deepEqual((await flowOf(store)).archives, []);
    });
});

describe('letters held against a live archive', () => {
    test('are counted, because a nonzero count there is a failed promotion', async () => {
        // Promotion writes into `raw/` and only then deletes the held copy, so
        // anything still sitting here is the only copy of somebody's mail in a
        // container nothing reads. Ordinarily always zero, which is exactly
        // why it is worth a column.
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:00:00.000Z'
        });
        await store.writeBlob('pending', 'elder.example/01.eml', Buffer.from('raw'));

        const [archive] = (await flowOf(store)).archives;

        assert.equal(archive.state, STATE.live);
        assert.equal(archive.held, 1);
    });

    test('and the archive is listed once, not twice', async () => {
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:00:00.000Z'
        });
        await held(store, 'elder.example', { letters: 2 });

        assert.equal((await flowOf(store)).archives.length, 1);
    });

    test('and a claimed site reports zero rather than everything it ever held', async () => {
        // The count comes from the blobs rather than the manifest's
        // `messageCount`, which counts everything ever held and is never
        // decremented by promotion.
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:00:00.000Z'
        });
        await store.writeBlob(
            'pending',
            'elder.example/claim.json',
            utf8({ slug: 'elder.example', messageCount: 12, claimedAt: '2026-02-01T00:00:00.000Z' })
        );

        assert.equal((await flowOf(store)).archives[0].held, 0);
    });
});

describe('the page shows every archive there is', () => {
    test('live, deleted and pending together, each exactly once', async () => {
        // Partial answers are what make a monitoring page untrustworthy, and
        // the whole point of looking is to see whether something is missing.
        const store = memoryStore();
        for (const slug of ['live.one', 'gone.one']) {
            await touchSiteActivity({
                tables: store,
                slug,
                lastPostAt: '2026-08-01T09:00:00.000Z',
                receivedAt: '2026-08-01T09:00:00.000Z'
            });
        }
        await deleted(store, 'gone.one');
        await held(store, 'new.one', { manifest: { lastMessageAt: '2026-08-02T09:00:00.000Z' } });

        const rows = bySlug(await flowOf(store));

        assert.equal(rows.size, 3);
        assert.equal(rows.get('live.one').state, STATE.live);
        assert.equal(rows.get('gone.one').state, STATE.deleted);
        assert.equal(rows.get('new.one').state, STATE.pending);
    });

    test('an erased archive has left, because its row went with the letters', async () => {
        // Deletion keeps the row -- restoring an archive whose name had been
        // thrown away would put a family back with a blank masthead -- and
        // erasure is the promise that nothing is left.
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:00:00.000Z'
        });
        await forgetSite({ tables: store, slug: 'elder.example' });

        assert.deepEqual((await flowOf(store)).archives, []);
    });

    test('a row of another shape in the same table is not an archive', async () => {
        // Filtered on the row key rather than trusting the table to hold only
        // these, so a second row shape added later cannot silently become an
        // archive on somebody's screen.
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:00:00.000Z'
        });
        await store.upsertEntity(TABLES.sites, {
            partitionKey: 'elder.example',
            rowKey: 'something-else',
            lastPostAt: '2030-01-01T00:00:00.000Z'
        });

        const flow = await flowOf(store);

        assert.equal(flow.archives.length, 1);
        assert.equal(flow.lastReceivedAt, '2026-08-01T09:00:00.000Z');
    });

    test('a deletion tombstone of another shape does not mark an archive deleted', async () => {
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:00:00.000Z'
        });
        await store.upsertEntity(TABLES.deletions, {
            partitionKey: 'elder.example',
            rowKey: 'not-the-record'
        });

        assert.equal((await flowOf(store)).archives[0].state, STATE.live);
    });

    test('and the missionary name comes along so the slug is not the only clue', async () => {
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: 'elder.example',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            receivedAt: '2026-08-01T09:00:00.000Z'
        });
        await store.upsertEntity(TABLES.sites, {
            partitionKey: 'elder.example',
            rowKey: 'activity',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            lastReceivedAt: '2026-08-01T09:00:00.000Z',
            missionaryDisplayName: 'Elder Example'
        });

        assert.equal((await flowOf(store)).archives[0].name, 'Elder Example');
    });
});
