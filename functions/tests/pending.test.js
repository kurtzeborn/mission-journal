// Who a held archive is waiting on.
//
// The manifest was built to describe the letters, so the address on it is the
// missionary they are about. On a forwarded site that is the one person a
// claim link must never go to, and for a fortnight the only other record of
// who to write to was the envelope on the blob -- which is where these tests
// start, because that fortnight is not hypothetical and the sites it stranded
// are still on disk.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { holdPending, listPending, pendingRecipient } from '../src/lib/pending.js';
import { memoryStore } from './memory-store.js';

const NOW = () => new Date('2026-08-23T12:00:00Z');
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const hold = (store, over = {}) =>
    holdPending({
        store,
        slug: 'elder.example',
        ulid: '01TEST0000000000000000000',
        raw: Buffer.from('a letter'),
        envelope: { to: 'post@pdayletters.com', from: 'mum@example.com' },
        subject: 'Week one',
        sender: 'elder.example@missionary.org',
        hasDirect: false,
        now: NOW,
        log: silent,
        ...over
    });

const manifestOf = (store, slug = 'elder.example') =>
    JSON.parse(store.blobs.get(`pending/${slug}/claim.json`).bytes.toString('utf8'));

describe('remembering who forwarded it', () => {
    test('a forwarded site records the forwarder alongside the missionary', async () => {
        const store = memoryStore();
        await hold(store, { forwarder: 'mum@example.com' });

        const manifest = manifestOf(store);
        assert.equal(manifest.sender, 'elder.example@missionary.org');
        assert.equal(manifest.forwarder, 'mum@example.com');
    });

    test('the first forwarder keeps the site, because they hold the link', async () => {
        const store = memoryStore();
        await hold(store, { forwarder: 'mum@example.com' });
        await hold(store, { ulid: '01TEST0000000000000000001', forwarder: 'aunt@example.com' });

        assert.equal(manifestOf(store).forwarder, 'mum@example.com');
    });

    test('a direct send records none, having none', async () => {
        const store = memoryStore();
        await hold(store, { hasDirect: true });

        assert.equal(manifestOf(store).forwarder, null);
    });
});

describe('choosing where a claim link goes', () => {
    test('the last address offered wins, because it holds the link being replaced', async () => {
        const store = memoryStore();
        await hold(store, { forwarder: 'mum@example.com' });

        const manifest = {
            ...manifestOf(store),
            emailedAddresses: ['mum@example.com', 'dad@example.com']
        };

        assert.equal(
            await pendingRecipient({ store, slug: 'elder.example', manifest }),
            'dad@example.com'
        );
    });

    test('then the forwarder', async () => {
        const store = memoryStore();
        await hold(store, { forwarder: 'mum@example.com' });

        assert.equal(
            await pendingRecipient({ store, slug: 'elder.example', manifest: manifestOf(store) }),
            'mum@example.com'
        );
    });

    test('a direct site is answered to the missionary, who wrote to us', async () => {
        const store = memoryStore();
        await hold(store, { hasDirect: true });

        assert.equal(
            await pendingRecipient({ store, slug: 'elder.example', manifest: manifestOf(store) }),
            'elder.example@missionary.org'
        );
    });

    test('a forwarded site with no forwarder falls back to the envelope, not the missionary', async () => {
        // The stranded case: held before the forwarder was written down.
        // Answering `sender` here would email a missionary a credential for
        // an archive about them that they never asked anyone to make.
        const store = memoryStore();
        await hold(store);

        const to = await pendingRecipient({
            store,
            slug: 'elder.example',
            manifest: manifestOf(store)
        });

        assert.equal(to, 'mum@example.com');
    });

    test('and the newest letter is the one asked, not the oldest', async () => {
        const store = memoryStore();
        await hold(store);
        await hold(store, {
            ulid: '01TEST0000000000000000009',
            envelope: { to: 'post@pdayletters.com', from: 'aunt@example.com' }
        });

        assert.equal(
            await pendingRecipient({ store, slug: 'elder.example', manifest: manifestOf(store) }),
            'aunt@example.com'
        );
    });

    test('nothing at all is an empty answer rather than a wrong one', async () => {
        const store = memoryStore();

        assert.equal(
            await pendingRecipient({
                store,
                slug: 'elder.example',
                manifest: { slug: 'elder.example', hasDirect: false, sender: 'x@missionary.org' }
            }),
            ''
        );
    });
});

describe('listing what is waiting', () => {
    test('reports the count, the countdown, and whether anyone was ever told', async () => {
        const store = memoryStore();
        await hold(store, { forwarder: 'mum@example.com' });
        await hold(store, { ulid: '01TEST0000000000000000002', forwarder: 'mum@example.com' });

        const [site] = await listPending({ store, log: silent });

        assert.equal(site.slug, 'elder.example');
        assert.equal(site.recipient, 'mum@example.com');
        assert.equal(site.messageCount, 2);
        assert.equal(site.offerCount, 0);
        assert.equal(site.offeredAt, null);
        assert.equal(site.hasDirect, false);
        assert.ok(site.expiresAt);
    });

    test('a claimed site has stopped waiting', async () => {
        const store = memoryStore();
        await hold(store, { forwarder: 'mum@example.com' });

        const manifest = { ...manifestOf(store), claimedAt: '2026-08-23T12:00:00.000Z' };
        await store.writeBlob(
            'pending',
            'elder.example/claim.json',
            Buffer.from(JSON.stringify(manifest)),
            { contentType: 'application/json' }
        );

        assert.deepEqual(await listPending({ store, log: silent }), []);
    });

    test('the soonest to expire is first, because that is the one with a deadline', async () => {
        const store = memoryStore();
        await hold(store, { slug: 'elder.later', forwarder: 'mum@example.com' });
        await hold(store, {
            slug: 'elder.sooner',
            ulid: '01TEST0000000000000000003',
            forwarder: 'dad@example.com',
            now: () => new Date('2026-08-20T12:00:00Z')
        });

        const slugs = (await listPending({ store, log: silent })).map((site) => site.slug);
        assert.deepEqual(slugs, ['elder.sooner', 'elder.later']);
    });

    test('a manifest nobody can parse is shown rather than skipped', async () => {
        // The opposite of what the purge and reminder sweeps do. They decline
        // to act on what they cannot read; this is the page for finding out
        // what is stuck, and unreadable is the stuckest a site gets.
        const store = memoryStore();
        await store.writeBlob('pending', 'elder.broken/claim.json', Buffer.from('{ not json'), {
            contentType: 'application/json'
        });

        const [site] = await listPending({ store, log: silent });

        assert.equal(site.slug, 'elder.broken');
        assert.equal(site.unreadable, true);
    });
});
