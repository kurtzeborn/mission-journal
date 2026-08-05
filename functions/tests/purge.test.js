// Purge tests.
//
// This is the only code in the system that destroys a letter, so most of what
// follows is about the cases where it must NOT act. A purge that deletes too
// little shows up as a storage bill; a purge that deletes too much shows up
// as a family asking where their letters went.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { purgeExpired, GRACE_DAYS } from '../src/lib/purge.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = () => new Date('2026-08-03T12:00:00Z');

const quiet = { info() {}, warn() {}, error() {}, log() {} };

const daysFromNow = (days) => new Date(NOW().getTime() + days * DAY_MS).toISOString();

async function pending(store, slug, manifest = {}, letters = 2) {
    for (let i = 0; i < letters; i++) {
        await store.writeBlob('pending', `${slug}/0000000000000000000000000${i}.eml`, Buffer.from(`letter ${i}`));
    }
    await store.writeBlob(
        'pending',
        `${slug}/claim.json`,
        Buffer.from(
            JSON.stringify({
                slug,
                expiresAt: daysFromNow(-1 - GRACE_DAYS),
                messageCount: letters,
                sender: 'elder@missionary.org',
                hasDirect: true,
                claimEmailCount: 1,
                claimedAt: null,
                ...manifest
            })
        )
    );
    return store;
}

const remaining = (store, slug) =>
    [...store.blobs.keys()].filter((key) => key.startsWith(`pending/${slug}/`));

describe('purging an expired pending site', () => {
    test('removes the letters and the manifest together', async () => {
        const store = await pending(memoryStore(), 'elder.gone');

        const result = await purgeExpired({ store, now: NOW, log: quiet });

        assert.equal(result.purged.length, 1);
        assert.equal(result.purged[0].letters, 2);
        assert.deepEqual(remaining(store, 'elder.gone'), []);
    });

    test('leaves every other site alone', async () => {
        const store = memoryStore();
        await pending(store, 'elder.gone');
        await pending(store, 'elder.here', { expiresAt: daysFromNow(30) });

        await purgeExpired({ store, now: NOW, log: quiet });

        assert.deepEqual(remaining(store, 'elder.gone'), []);
        assert.equal(remaining(store, 'elder.here').length, 3);
    });

    test('is safe to run twice', async () => {
        const store = await pending(memoryStore(), 'elder.gone');

        await purgeExpired({ store, now: NOW, log: quiet });
        const second = await purgeExpired({ store, now: NOW, log: quiet });

        assert.equal(second.scanned, 0);
        assert.equal(second.purged.length, 0);
    });

    test('deletes the letters before the manifest, so a crash can be resumed', async () => {
        const store = await pending(memoryStore(), 'elder.gone');

        // Fail on the manifest only, which is the last thing to go.
        const original = store.deleteBlob.bind(store);
        store.deleteBlob = async (container, name) => {
            if (name.endsWith('claim.json')) throw new Error('crashed');
            return original(container, name);
        };

        await assert.rejects(() => purgeExpired({ store, now: NOW, log: quiet }));

        // The letters are gone and the manifest survives -- still expired, so
        // the next run finishes the job. The reverse order would have left
        // .eml files that nothing would ever list again.
        const left = remaining(store, 'elder.gone');
        assert.deepEqual(left, ['pending/elder.gone/claim.json']);

        store.deleteBlob = original;
        await purgeExpired({ store, now: NOW, log: quiet });
        assert.deepEqual(remaining(store, 'elder.gone'), []);
    });
});

describe('what the purge refuses to touch', () => {
    test('a site whose window is still open', async () => {
        const store = await pending(memoryStore(), 'elder.here', { expiresAt: daysFromNow(1) });

        const result = await purgeExpired({ store, now: NOW, log: quiet });

        assert.equal(result.purged.length, 0);
        assert.equal(result.kept[0].reason, 'live');
        assert.equal(remaining(store, 'elder.here').length, 3);
    });

    test('a site inside the grace period', async () => {
        // Expired yesterday. The claim page still offers to send a fresh
        // link for an expired token, and that offer has to mean something.
        const store = await pending(memoryStore(), 'elder.here', { expiresAt: daysFromNow(-1) });

        const result = await purgeExpired({ store, now: NOW, log: quiet });

        assert.equal(result.purged.length, 0);
        assert.equal(result.kept[0].reason, 'live');
    });

    test('a claimed site that still has letters in it', async () => {
        // Promotion failed partway. These are unpublished originals with no
        // copy anywhere else, and they are also the evidence of the bug.
        const store = await pending(memoryStore(), 'elder.claimed', {
            claimedAt: '2026-01-01T00:00:00Z'
        });

        const result = await purgeExpired({ store, now: NOW, log: quiet });

        assert.equal(result.purged.length, 0);
        assert.equal(result.kept[0].reason, 'claimed');
        assert.equal(remaining(store, 'elder.claimed').length, 3);
    });

    test('a site whose expiry will not parse', async () => {
        const store = await pending(memoryStore(), 'elder.odd', { expiresAt: 'soon' });

        const result = await purgeExpired({ store, now: NOW, log: quiet });

        assert.equal(result.kept[0].reason, 'no-expiry');
        assert.equal(remaining(store, 'elder.odd').length, 3);
    });

    test('a site with no expiry at all', async () => {
        const store = await pending(memoryStore(), 'elder.odd', { expiresAt: undefined });
        const manifest = JSON.parse(
            store.blobs.get('pending/elder.odd/claim.json').bytes.toString('utf8')
        );
        delete manifest.expiresAt;
        await store.writeBlob('pending', 'elder.odd/claim.json', Buffer.from(JSON.stringify(manifest)));

        const result = await purgeExpired({ store, now: NOW, log: quiet });

        assert.equal(result.kept[0].reason, 'no-expiry');
    });

    test('a manifest that will not parse', async () => {
        const store = await pending(memoryStore(), 'elder.broken');
        await store.writeBlob('pending', 'elder.broken/claim.json', Buffer.from('{ not json'));

        const result = await purgeExpired({ store, now: NOW, log: quiet });

        assert.equal(result.kept[0].reason, 'unreadable');
        assert.equal(remaining(store, 'elder.broken').length, 3);
    });
});

describe('reporting', () => {
    test('a dry run judges without deleting', async () => {
        const store = await pending(memoryStore(), 'elder.gone');

        const result = await purgeExpired({ store, now: NOW, log: quiet, dryRun: true });

        assert.equal(result.purged.length, 1);
        assert.equal(result.dryRun, true);
        assert.equal(remaining(store, 'elder.gone').length, 3);
    });

    test('calls out a site that expired without ever being offered', async () => {
        // Nobody ignored us; we never asked. That is our bug, and it must not
        // be buried in a routine cleanup count.
        const store = await pending(memoryStore(), 'elder.gone', { claimEmailCount: 0 });

        const errors = [];
        await purgeExpired({ store, now: NOW, log: { ...quiet, error: (m, d) => errors.push([m, d]) } });

        const called = errors.find(([message]) => message.includes('without ever being offered'));
        assert.ok(called, 'expected an error-level log');
        assert.deepEqual(called[1].slugs, ['elder.gone']);
    });

    test('says nothing alarming when an offered site simply expired', async () => {
        const store = await pending(memoryStore(), 'elder.gone', { claimEmailCount: 3 });

        const errors = [];
        await purgeExpired({ store, now: NOW, log: { ...quiet, error: (m) => errors.push(m) } });

        assert.deepEqual(errors, []);
    });
});
