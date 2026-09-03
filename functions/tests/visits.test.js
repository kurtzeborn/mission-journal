// Counting who is still reading.
//
// The failure modes here are all off-by-one people rather than exceptions: a
// person who refreshes twenty times must be one, a person who opens two
// archives must be two in the columns and one in the total, and the thirty-day
// window has to include both its ends. None of that shows up as an error, so it
// is asserted rather than watched.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import { recordVisit, activeReaders, visitorKey, ACTIVE_DAYS } from '../src/lib/visits.js';
import { sweepVisits, VISIT_RETAIN_DAYS } from '../src/lib/sweep.js';
import { TABLES } from '../src/lib/tables.js';

const TODAY = new Date('2026-08-16T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (days) => new Date(TODAY.getTime() + days * DAY_MS);
const quiet = { info() {}, warn() {}, error() {}, log() {} };

const now = () => TODAY;

/** A visit on a day relative to TODAY. */
const visit = (tables, email, slug, days = 0) =>
    recordVisit({ tables, slug, email, now: () => at(days), log: quiet });

describe('recording a visit', () => {
    test('the same person refreshing all afternoon is one row', async () => {
        const tables = memoryStore();

        for (let n = 0; n < 20; n += 1) await visit(tables, 'gran@example.com', 'elder.one');

        const rows = await tables.listEntities(TABLES.visits);
        assert.equal(rows.length, 1);
    });

    test('the address is hashed, and nothing in the row can be read back to it', async () => {
        const tables = memoryStore();

        await visit(tables, 'Gran@Example.com', 'elder.one');

        const [row] = await tables.listEntities(TABLES.visits);
        const written = JSON.stringify(row).toLowerCase();
        assert.equal(written.includes('gran@example.com'), false);
        assert.equal(written.includes('gran'), false);
        assert.match(row.rowKey, /^elder\.one\|[0-9a-f]{64}$/);
    });

    test('the same address in different letters is the same person', async () => {
        assert.equal(visitorKey('Gran@Example.com '), visitorKey('gran@example.com'));
    });

    test('a storage failure is swallowed, because a read must not fail over a counter', async () => {
        const broken = {
            upsertEntity: async () => {
                throw new Error('table service is having a day');
            }
        };

        assert.equal(await recordVisit({ tables: broken, slug: 'elder.one', email: 'a@b.c', log: quiet }), false);
    });

    test('nothing to record without a slug and an address', async () => {
        const tables = memoryStore();

        assert.equal(await recordVisit({ tables, slug: '', email: 'a@b.c', log: quiet }), false);
        assert.equal(await recordVisit({ tables, slug: 'elder.one', email: '', log: quiet }), false);
        assert.equal((await tables.listEntities(TABLES.visits)).length, 0);
    });
});

describe('counting who is reading', () => {
    test('today and the month, per archive and across the service', async () => {
        const tables = memoryStore();

        await visit(tables, 'mum@example.com', 'elder.one', 0);
        await visit(tables, 'gran@example.com', 'elder.one', 0);
        await visit(tables, 'uncle@example.com', 'elder.one', -8);

        const { totals, bySlug } = await activeReaders({ tables, now, log: quiet });

        assert.deepEqual(bySlug.get('elder.one'), { daily: 2, monthly: 3 });
        assert.deepEqual(totals, { daily: 2, monthly: 3 });
    });

    test('a grandmother reading two archives is two rows and one person', async () => {
        const tables = memoryStore();

        await visit(tables, 'gran@example.com', 'elder.one', 0);
        await visit(tables, 'gran@example.com', 'sister.two', 0);

        const { totals, bySlug } = await activeReaders({ tables, now, log: quiet });

        // Both readings are wanted: each archive was read by one person, and
        // one person read today. Summing the columns would say two.
        assert.equal(bySlug.get('elder.one').daily, 1);
        assert.equal(bySlug.get('sister.two').daily, 1);
        assert.equal(totals.daily, 1);
    });

    test('somebody who came every day this month is counted once in it', async () => {
        const tables = memoryStore();

        for (let back = 0; back < ACTIVE_DAYS; back += 1) {
            await visit(tables, 'gran@example.com', 'elder.one', -back);
        }

        const { totals } = await activeReaders({ tables, now, log: quiet });

        assert.equal(totals.monthly, 1);
        assert.equal(totals.daily, 1);
    });

    test('the window takes in its far end and stops there', async () => {
        const tables = memoryStore();

        await visit(tables, 'inside@example.com', 'elder.one', -(ACTIVE_DAYS - 1));
        await visit(tables, 'outside@example.com', 'elder.one', -ACTIVE_DAYS);

        const { totals } = await activeReaders({ tables, now, log: quiet });

        assert.equal(totals.monthly, 1);
    });

    test('an archive nobody has opened is absent rather than zero', async () => {
        // The caller fills a missing slug in with zero. Inventing rows here
        // would mean guessing which archives exist, which this cannot know.
        const tables = memoryStore();

        const { bySlug } = await activeReaders({ tables, now, log: quiet });

        assert.equal(bySlug.has('elder.quiet'), false);
    });

    test('an unreadable table is zeroes, because this is a report', async () => {
        const broken = {
            listEntities: async () => {
                throw new Error('no');
            }
        };

        const { totals, bySlug } = await activeReaders({ tables: broken, now, log: quiet });

        assert.deepEqual(totals, { daily: 0, monthly: 0 });
        assert.equal(bySlug.size, 0);
    });
});

describe('sweeping visit rows', () => {
    test('the retention window clears the window that is reported on', async () => {
        // A sweep that merely reached thirty days would take the far end of
        // its own report whenever it ran a little early.
        assert.ok(VISIT_RETAIN_DAYS > ACTIVE_DAYS);
    });

    test('rows older than the window go, and everything reported on stays', async () => {
        const tables = memoryStore();

        await visit(tables, 'old@example.com', 'elder.one', -(VISIT_RETAIN_DAYS + 5));
        await visit(tables, 'gran@example.com', 'elder.one', -(ACTIVE_DAYS - 1));
        await visit(tables, 'mum@example.com', 'elder.one', 0);

        const result = await sweepVisits({ tables, now, log: quiet });

        assert.equal(result.deleted, 1);
        assert.equal(result.kept, 2);
        assert.equal((await activeReaders({ tables, now, log: quiet })).totals.monthly, 2);
    });

    test('a partition it cannot read as a day is left alone', async () => {
        const tables = memoryStore();
        await tables.upsertEntity(TABLES.visits, { partitionKey: 'whenever', rowKey: 'elder.one|abc' });

        const result = await sweepVisits({ tables, now, log: quiet });

        assert.equal(result.deleted, 0);
        assert.equal(result.kept, 1);
    });
});
