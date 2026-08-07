// The daily ceiling on one archive's inbound letters.
//
// Two things are being protected at once and they pull against each other: a
// family forwarding two years of letters in one sitting must get all of them,
// and a forwarding loop must be stopped long before it has produced thousands
// of posts and a storage bill. Most of what is asserted here is the first of
// those, because that is the one whose failure looks like the service losing
// somebody's mail.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withinDailyCap, DAILY_CAP } from '../src/lib/cap.js';
import { runIngest } from '../src/lib/ingest.js';
import { TABLES } from '../src/lib/tables.js';
import { memoryStore } from './memory-store.js';

const SLUG = 'elder.example';
const silent = { info() {}, warn() {}, error() {} };
const at = (when) => () => new Date(when);
const NOW = at('2026-08-03T12:00:00Z');

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const arrive = (tables, ulid, now = NOW, cap = undefined) =>
    withinDailyCap({ tables, slug: SLUG, ulid, now, cap, log: silent });

const arriveMany = async (tables, count, now = NOW, cap = undefined) => {
    const results = [];
    for (let i = 0; i < count; i++) results.push(await arrive(tables, `ulid-${i}`, now, cap));
    return results;
};

describe('the size of the allowance', () => {
    test('clears a whole mission forwarded in one sitting', async () => {
        // The scenario this must not break: a family finds the service after
        // two years and forwards the lot. About a hundred weekly letters.
        const store = memoryStore();

        const results = await arriveMany(store, 120);

        assert.equal(results.every((r) => r.ok), true, 'a real backfill was refused');
    });

    test('and is nowhere near a loop', async () => {
        assert.ok(DAILY_CAP >= 120, 'too low to clear a full-mission backfill');
        assert.ok(DAILY_CAP <= 500, 'high enough to let a loop run up a real bill');
    });
});

describe('when the ceiling is reached', () => {
    test('the letter over the line is refused', async () => {
        const store = memoryStore();
        await arriveMany(store, 5, NOW, 5);

        const result = await arrive(store, 'one-too-many', NOW, 5);

        assert.equal(result.ok, false);
        assert.equal(result.count, 5);
    });

    test('and it is refused every time, not just once', async () => {
        // A loop does not stop because it was told no. Nothing may be admitted
        // by a counter that quietly stops advancing.
        const store = memoryStore();
        await arriveMany(store, 5, NOW, 5);

        for (let i = 0; i < 50; i++) {
            assert.equal((await arrive(store, `flood-${i}`, NOW, 5)).ok, false);
        }
    });

    test('a refused letter leaves no row, so it cannot fill the count further', async () => {
        const store = memoryStore();
        await arriveMany(store, 5, NOW, 5);

        await arrive(store, 'refused', NOW, 5);

        const rows = await store.listEntities(TABLES.arrivals, { partitionKey: `${SLUG}:2026-08-03` });
        assert.equal(rows.length, 5);
    });

    test('it says so at error level, because that is what an alert watches', async () => {
        const store = memoryStore();
        const said = [];
        const log = { info() {}, warn() {}, error: (message) => said.push(message) };
        await arriveMany(store, 2, NOW, 2);

        await withinDailyCap({ tables: store, slug: SLUG, ulid: 'over', now: NOW, cap: 2, log });

        assert.deepEqual(said, ['ingest: daily cap reached']);
    });
});

describe('what the count is scoped to', () => {
    test('tomorrow starts again', async () => {
        const store = memoryStore();
        await arriveMany(store, 5, NOW, 5);

        const result = await arrive(store, 'next-day', at('2026-08-04T00:30:00Z'), 5);

        assert.equal(result.ok, true);
    });

    test('one archive filling up does not refuse another', async () => {
        const store = memoryStore();
        await arriveMany(store, 5, NOW, 5);

        const other = await withinDailyCap({
            tables: store,
            slug: 'sister.example',
            ulid: 'theirs',
            now: NOW,
            cap: 5,
            log: silent
        });

        assert.equal(other.ok, true);
    });
});

describe('a message delivered twice', () => {
    test('is counted once', async () => {
        // The queue can redeliver, and a redelivery is our problem rather than
        // the sender's. Spending two of the day's allowance on one letter
        // would make the cap tighten every time the host retried.
        const store = memoryStore();

        await arrive(store, 'same-ulid');
        await arrive(store, 'same-ulid');
        await arrive(store, 'same-ulid');

        const rows = await store.listEntities(TABLES.arrivals, { partitionKey: `${SLUG}:2026-08-03` });
        assert.equal(rows.length, 1);
    });

    test('and is not refused', async () => {
        const store = memoryStore();

        await arrive(store, 'same-ulid');

        assert.equal((await arrive(store, 'same-ulid')).ok, true);
    });
});

describe('when the table is unhappy', () => {
    test('the letter goes through anyway', async () => {
        // A table refusing reads is not evidence of a loop. This is the one
        // guard whose malfunction would otherwise reject real mail, and the
        // bias everywhere else here is that a letter published in error is
        // reversible while a letter discarded is gone.
        const store = memoryStore();
        store.listEntities = async () => {
            throw new Error('table is down');
        };

        assert.equal((await arrive(store, 'during-an-outage')).ok, true);
    });

    test('and a failure to record one does not refuse it either', async () => {
        const store = memoryStore();
        store.insertEntity = async () => {
            throw new Error('table is down');
        };

        assert.equal((await arrive(store, 'during-an-outage')).ok, true);
    });

    test('a caller with no tables at all is not capped', async () => {
        assert.equal((await withinDailyCap({ tables: null, slug: SLUG, ulid: 'x' })).ok, true);
    });
});

describe('end to end, through ingest', () => {
    const config = { authservId: 'mx.cloudflare.net', missionaryDomains: ['missionary.org'] };

    const send = (store, ulid) =>
        runIngest({
            ulid,
            store,
            tables: store,
            config,
            log: silent,
            now: NOW,
            verifyDkim: async () => ({ verified: false, reason: 'test', signatures: [] })
        });

    const fill = async (store, count) => {
        for (let i = 0; i < count; i++) {
            await store.insertEntity(TABLES.arrivals, {
                partitionKey: `${SLUG}:2026-08-03`,
                rowKey: `earlier-${i}`
            });
        }
    };

    test('a letter arriving over the cap is refused and nothing is written', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'scott@kurtzeborn.org', role: 'owner' }]);
        await fill(store, DAILY_CAP);
        store.seed('01CAP00000000000000000000', await raw('direct-missionary'));

        const result = await send(store, '01CAP00000000000000000000');

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'daily-cap');
        assert.equal(store.blobs.has(`rendered/${SLUG}/posts.json`), false);
        assert.equal(store.queues.get('render'), undefined);
    });

    test('the same letter goes through when the day is not full', async () => {
        // The control. Without it the test above passes just as well against a
        // pipeline that is broken for some entirely different reason.
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'scott@kurtzeborn.org', role: 'owner' }]);
        store.seed('01CAP00000000000000000000', await raw('direct-missionary'));

        const result = await send(store, '01CAP00000000000000000000');

        assert.equal(result.status, 'stored');
    });

    test('an unclaimed site is capped too, and holds nothing over the line', async () => {
        // A loop into a site nobody has claimed costs the same and is worse:
        // there is no owner to notice.
        const store = memoryStore();
        await fill(store, DAILY_CAP);
        store.seed('01CAP00000000000000000000', await raw('direct-missionary'));

        const result = await send(store, '01CAP00000000000000000000');

        assert.equal(result.reason, 'daily-cap');
        assert.equal(
            [...store.blobs.keys()].some((k) => k.startsWith('pending/')),
            false
        );
    });
});
