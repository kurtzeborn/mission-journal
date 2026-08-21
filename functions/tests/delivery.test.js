// Whether we can tell an owner that their mail is not arriving.
//
// The thing under test is small; the thing it guards is not. Undeliverable
// mail is the one failure in this service whose symptom is silence, so every
// test here is really asking the same question: after this happened, would the
// people page say anything?

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { clearDelivery, deliveryKey, deliveryTrouble, recordDelivery } from '../src/lib/delivery.js';
import { TABLES } from '../src/lib/tables.js';
import { memoryStore } from './memory-store.js';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = () => new Date('2026-08-16T09:00:00Z');
const THEM = 'grandma@example.com';

const rowFor = (store, email) => store.getEntity(TABLES.deliveries, 'delivery', deliveryKey(email));

describe('writing down how a send went', () => {
    test('a bounce is recorded against the address', async () => {
        const store = memoryStore();
        await recordDelivery({ tables: store, email: THEM, status: 'bounced', slug: 'elder.example', now: NOW, log: quiet });

        const row = await rowFor(store, THEM);
        assert.equal(row.status, 'bounced');
        assert.equal(row.email, THEM);
        assert.equal(row.slug, 'elder.example');
        assert.equal(row.at, '2026-08-16T09:00:00.000Z');
    });

    test('the address is stored as well as hashed', async () => {
        // The key is a hash because a row key cannot hold every legal address.
        // The row is not, because the question this table exists to answer is
        // "why did grandmother stop hearing from us", and a table of hashes
        // cannot answer it.
        const store = memoryStore();
        await recordDelivery({ tables: store, email: 'MiXeD@Example.COM', status: 'failed', now: NOW, log: quiet });

        const row = await rowFor(store, 'mixed@example.com');
        assert.equal(row.email, 'mixed@example.com');
        assert.match(row.rowKey, /^[0-9a-f]{64}$/);
    });

    test('a later success clears an earlier failure', async () => {
        // Without this an address that recovers stays marked forever, and an
        // owner who sees a warning that never goes away learns to ignore the
        // one that matters.
        const store = memoryStore();
        await recordDelivery({ tables: store, email: THEM, status: 'bounced', now: NOW, log: quiet });
        await recordDelivery({ tables: store, email: THEM, status: 'sent', now: NOW, log: quiet });

        assert.equal((await rowFor(store, THEM)).status, 'sent');
        assert.equal((await deliveryTrouble({ tables: store, emails: [THEM], log: quiet })).size, 0);
    });

    test('the allowlist refusing is not held against the recipient', async () => {
        // `blocked` is a fact about our configuration. While the allowlist is
        // narrow it fires for almost everybody, and recording it would mark
        // most of the world as unreachable.
        const store = memoryStore();
        await recordDelivery({ tables: store, email: THEM, status: 'blocked', now: NOW, log: quiet });

        assert.equal(await rowFor(store, THEM), null);
    });

    test('a table that will not take the write does not fail the send', async () => {
        const store = memoryStore();
        store.upsertEntity = async () => {
            throw new Error('storage is having a day');
        };

        await recordDelivery({ tables: store, email: THEM, status: 'bounced', now: NOW, log: quiet });
    });

    test('nothing is written without an address or a status', async () => {
        const store = memoryStore();
        await recordDelivery({ tables: store, email: '', status: 'bounced', now: NOW, log: quiet });
        await recordDelivery({ tables: store, email: THEM, status: '', now: NOW, log: quiet });

        assert.equal((await store.listEntities(TABLES.deliveries, { partitionKey: 'delivery' })).length, 0);
    });
});

describe('forgetting all of it once they turn up', () => {
    test('signing in outranks the bounce that came before it', async () => {
        // Nothing that writes one of these rows recurs, so a mark left alone
        // is a mark left forever -- long after the person it is about has been
        // reading the letters for months.
        const store = memoryStore();
        await recordDelivery({ tables: store, email: THEM, status: 'bounced', now: NOW, log: quiet });

        await clearDelivery({ tables: store, emails: [THEM], log: quiet });

        assert.equal(await rowFor(store, THEM), null);
    });

    test('both addresses are forgotten, not just the one that signed in', async () => {
        // An invitation is sent to the address the owner typed and accepted by
        // whichever account they please. The bounce is against the first; the
        // people page looks up the second. Clearing only one leaves a row
        // nothing will ever read again and nothing will ever clear.
        const store = memoryStore();
        await recordDelivery({ tables: store, email: 'grandma@aol.com', status: 'failed', now: NOW, log: quiet });

        await clearDelivery({ tables: store, emails: ['g.example@gmail.com', 'grandma@aol.com'], log: quiet });

        assert.equal(await rowFor(store, 'grandma@aol.com'), null);
    });

    test('the case it arrives in does not decide whether it is found', async () => {
        const store = memoryStore();
        await recordDelivery({ tables: store, email: THEM, status: 'failed', now: NOW, log: quiet });

        await clearDelivery({ tables: store, emails: ['GRANDMA@Example.com'], log: quiet });

        assert.equal(await rowFor(store, THEM), null);
    });

    test('an address we never wrote to is not an error', async () => {
        // The common case by far: almost nobody has a row, and every sign-in
        // asks anyway.
        const store = memoryStore();
        await clearDelivery({ tables: store, emails: ['stranger@example.com', ''], log: quiet });
    });

    test('a table that will not delete does not fail the page that asked', async () => {
        const store = memoryStore();
        store.deleteEntity = async () => {
            throw new Error('storage is having a day');
        };

        await clearDelivery({ tables: store, emails: [THEM], log: quiet });
    });
});

describe('asking which of these people we cannot reach', () => {
    const trouble = (store, emails) => deliveryTrouble({ tables: store, emails, log: quiet });

    test('only the ones in trouble come back', async () => {
        const store = memoryStore();
        await recordDelivery({ tables: store, email: 'fine@example.com', status: 'sent', now: NOW, log: quiet });
        await recordDelivery({ tables: store, email: THEM, status: 'failed', now: NOW, log: quiet });

        const found = await trouble(store, ['fine@example.com', THEM, 'never.written.to@example.com']);
        assert.deepEqual([...found.keys()], [THEM]);
        assert.equal(found.get(THEM).status, 'failed');
        assert.equal(found.get(THEM).at, '2026-08-16T09:00:00.000Z');
    });

    test('the answer is keyed by the address as written, whatever case it came in', async () => {
        const store = memoryStore();
        await recordDelivery({ tables: store, email: THEM, status: 'failed', now: NOW, log: quiet });

        const found = await trouble(store, ['GRANDMA@Example.com']);
        assert.equal(found.get(THEM).status, 'failed');
    });

    test('no table at all is not an error, just no annotation', async () => {
        // The people page has to load when the side table telling it whose
        // mail is bouncing does not.
        assert.equal((await deliveryTrouble({ tables: null, emails: [THEM], log: quiet })).size, 0);
    });

    test('a row that will not read costs a warning, not the page', async () => {
        const store = memoryStore();
        await recordDelivery({ tables: store, email: THEM, status: 'bounced', now: NOW, log: quiet });
        store.getEntity = async () => {
            throw new Error('storage is having a day');
        };

        assert.equal((await trouble(store, [THEM])).size, 0);
    });

    test('the same address twice is asked about once', async () => {
        const store = memoryStore();
        let reads = 0;
        const real = store.getEntity.bind(store);
        store.getEntity = async (...args) => (reads++, real(...args));

        await trouble(store, [THEM, 'GRANDMA@example.com', THEM]);
        assert.equal(reads, 1);
    });
});
