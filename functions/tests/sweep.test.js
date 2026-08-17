// Sweep tests.
//
// The job deletes rows nothing reads, which makes its failure modes quiet in
// both directions: sweeping nothing looks identical to having nothing to
// sweep, and sweeping too much looks like nothing at all until an archive
// takes two hundred letters on a day whose count was thrown away. Both
// directions are asserted here rather than left to the log line.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { sweepArrivals, RETAIN_DAYS } from '../src/lib/sweep.js';
import { withinDailyCap } from '../src/lib/cap.js';
import { TABLES } from '../src/lib/tables.js';

const TODAY = new Date('2026-08-16T12:00:00Z');
const at = (days) => new Date(TODAY.getTime() + days * 24 * 60 * 60 * 1000);
const quiet = { error: () => {}, info: () => {}, log: () => {} };

const arrivalsOn = (tables, day, count, slug = 'elder.example') => {
    for (let n = 0; n < count; n += 1) {
        tables.upsertEntity(TABLES.arrivals, { partitionKey: `${slug}:${day}`, rowKey: `u${day}-${n}` });
    }
};

describe('sweeping finished arrival rows', () => {
    test('rows past the window go and rows inside it stay', async () => {
        const tables = memoryStore();
        arrivalsOn(tables, '2026-07-01', 5); // 46 days back
        arrivalsOn(tables, '2026-08-01', 3); // 15 days back
        arrivalsOn(tables, '2026-08-16', 2); // today

        const result = await sweepArrivals({ tables, now: () => TODAY, log: quiet });

        assert.equal(result.scanned, 10);
        assert.equal(result.deleted, 5);
        assert.equal(result.kept, 5);
        assert.equal(result.oldest, '2026-07-01');

        const left = await tables.listEntities(TABLES.arrivals);
        assert.equal(left.length, 5);
        assert.ok(left.every((row) => !row.partitionKey.endsWith('2026-07-01')));
    });

    test("today's count is never touched, which is the one thing that would matter", async () => {
        // The cap counts rows in today's partition. A sweep that took those
        // would reset an archive's allowance mid-flood, which is precisely the
        // moment the cap exists for.
        const tables = memoryStore();
        arrivalsOn(tables, '2026-08-16', 199);

        await sweepArrivals({ tables, now: () => TODAY, log: quiet });

        const verdict = await withinDailyCap({
            tables,
            slug: 'elder.example',
            ulid: 'next',
            now: () => TODAY,
            log: quiet
        });
        assert.equal(verdict.ok, true);
        assert.equal(verdict.count, 200);
    });

    test('a partition key it does not understand is left alone', async () => {
        // Deleting rows the job cannot explain would make any future change to
        // the key format silently destructive.
        const tables = memoryStore();
        tables.upsertEntity(TABLES.arrivals, { partitionKey: 'no-date-here', rowKey: 'a' });
        tables.upsertEntity(TABLES.arrivals, { partitionKey: 'elder:2026-07-01', rowKey: 'b' });

        const result = await sweepArrivals({ tables, now: () => TODAY, log: quiet });

        assert.equal(result.deleted, 1);
        assert.equal(result.kept, 1);
        const left = await tables.listEntities(TABLES.arrivals);
        assert.deepEqual(left.map((row) => row.partitionKey), ['no-date-here']);
    });

    test('a slug containing a colon still reads its own date', async () => {
        // The date is matched at the end rather than by splitting, because a
        // local part may legally contain a colon and splitting would read the
        // wrong half.
        const tables = memoryStore();
        tables.upsertEntity(TABLES.arrivals, { partitionKey: 'odd:name:2026-07-01', rowKey: 'a' });

        const result = await sweepArrivals({ tables, now: () => TODAY, log: quiet });
        assert.equal(result.deleted, 1);
    });

    test('the boundary is inclusive of the window', async () => {
        const tables = memoryStore();
        arrivalsOn(tables, at(-RETAIN_DAYS).toISOString().slice(0, 10), 1);
        arrivalsOn(tables, at(-RETAIN_DAYS - 1).toISOString().slice(0, 10), 1);

        const result = await sweepArrivals({ tables, now: () => TODAY, log: quiet });
        assert.equal(result.kept, 1);
        assert.equal(result.deleted, 1);
    });

    test('a dry run reports without deleting', async () => {
        const tables = memoryStore();
        arrivalsOn(tables, '2026-07-01', 4);

        const result = await sweepArrivals({ tables, now: () => TODAY, dryRun: true, log: quiet });

        assert.equal(result.deleted, 4);
        assert.equal((await tables.listEntities(TABLES.arrivals)).length, 4);
    });

    test('running it twice is the same as running it once', async () => {
        const tables = memoryStore();
        arrivalsOn(tables, '2026-07-01', 3);

        await sweepArrivals({ tables, now: () => TODAY, log: quiet });
        const second = await sweepArrivals({ tables, now: () => TODAY, log: quiet });

        assert.equal(second.scanned, 0);
        assert.equal(second.deleted, 0);
    });

    test('one row that will not delete does not stop the rest', async () => {
        const tables = memoryStore();
        arrivalsOn(tables, '2026-07-01', 3);
        const real = tables.deleteEntity.bind(tables);
        let calls = 0;
        tables.deleteEntity = async (...args) => {
            calls += 1;
            if (calls === 2) throw new Error('conflict');
            return real(...args);
        };

        const result = await sweepArrivals({ tables, now: () => TODAY, log: quiet });

        assert.equal(result.deleted, 2);
        assert.equal(result.failed, 1);
    });

    test('an unreadable table reports nothing rather than throwing', async () => {
        // The timer host retries a throw. Nothing is broken by not sweeping,
        // so there is nothing worth retrying.
        const tables = memoryStore();
        tables.listEntities = async () => {
            throw new Error('table offline');
        };

        const result = await sweepArrivals({ tables, log: quiet });
        assert.deepEqual(result, { scanned: 0, deleted: 0, kept: 0, failed: 0, oldest: null });
    });

    test('no table store at all is a no-op', async () => {
        const result = await sweepArrivals({ tables: null, log: quiet });
        assert.equal(result.scanned, 0);
    });
});
