// What a person has asked us to do.
//
// The interesting part of this table is not the reading and writing, which is
// three columns in one partition. It is the rules about absence: a row that
// does not exist means silence, a row with no `digestAt` means due now, and a
// frequency nobody recognizes means off. Each of those is the safe answer to
// a different accident, and each is easy to break by tidying.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { TABLES } from '../src/lib/tables.js';
import {
    DIGEST,
    digestSchedule,
    digestDue,
    everyUser,
    markDigested,
    readUser,
    setDigest,
    validFrequency
} from '../src/lib/users.js';

const THEM = 'grandma@example.com';
const AT = (iso) => () => new Date(iso);

describe('what counts as an answer', () => {
    test('the two frequencies we offer are kept', () => {
        assert.equal(validFrequency('monthly'), DIGEST.monthly);
        assert.equal(validFrequency('weekly'), DIGEST.weekly);
    });

    test('anything else is off, so a hand-edited row cannot start mail', () => {
        assert.equal(validFrequency('daily'), DIGEST.off);
        assert.equal(validFrequency(''), DIGEST.off);
        assert.equal(validFrequency(undefined), DIGEST.off);
        assert.equal(validFrequency('MONTHLY'), DIGEST.off);
    });
});

describe('recording what somebody chose', () => {
    test('an address nobody has answered for has no row at all', async () => {
        const store = memoryStore();
        assert.equal(await readUser({ tables: store, email: THEM }), null);
    });

    test('the address is the partition, lowercased and trimmed', async () => {
        const store = memoryStore();
        await setDigest({
            tables: store,
            email: '  GrandMa@Example.COM ',
            frequency: DIGEST.monthly,
            weekday: 2,
            week: 2,
            now: AT('2026-08-01T00:00:00Z')
        });

        const row = await readUser({ tables: store, email: THEM });
        assert.equal(row.partitionKey, THEM);
        assert.equal(row.digestFrequency, DIGEST.monthly);
        assert.equal(row.digestWeekday, 2);
        assert.equal(row.digestWeek, 2);
    });

    test('the window starts when they answered, not when the mission did', async () => {
        const store = memoryStore();
        await setDigest({
            tables: store,
            email: THEM,
            frequency: DIGEST.monthly,
            now: AT('2026-08-01T00:00:00Z')
        });

        const row = await readUser({ tables: store, email: THEM });
        assert.equal(row.digestAt, '2026-08-01T00:00:00.000Z');
        assert.equal(row.createdAt, '2026-08-01T00:00:00.000Z');
    });

    test('changing the schedule preserves the letter window and starts the new calendar now', async () => {
        const store = memoryStore();
        await setDigest({
            tables: store,
            email: THEM,
            frequency: DIGEST.monthly,
            weekday: 1,
            week: 1,
            now: AT('2026-08-01T00:00:00Z')
        });
        await setDigest({
            tables: store,
            email: THEM,
            frequency: DIGEST.weekly,
            weekday: 6,
            week: 1,
            now: AT('2026-08-09T00:00:00Z')
        });

        const row = await readUser({ tables: store, email: THEM });
        assert.equal(row.digestFrequency, DIGEST.weekly);
        assert.equal(row.digestAt, '2026-08-01T00:00:00.000Z');
        assert.equal(row.digestScheduleAt, '2026-08-09T00:00:00.000Z');
        assert.equal(digestDue({ row, now: AT('2026-08-10T13:15:00Z') }), false);
        assert.equal(digestDue({ row, now: AT('2026-08-15T13:15:00Z') }), true);
    });

    test('an empty address is refused rather than filed under nothing', async () => {
        const store = memoryStore();
        await assert.rejects(() => setDigest({ tables: store, email: '  ', frequency: DIGEST.monthly }));
    });
});

describe('whether a cycle is over', () => {
    test('off is never due, however long it has been', () => {
        const row = { digestFrequency: DIGEST.off, digestAt: '2020-01-01T00:00:00.000Z' };
        assert.equal(digestDue({ row, now: AT('2026-08-01T00:00:00Z') }), false);
    });

    test('a row written before this field existed is due immediately', () => {
        const row = { digestFrequency: DIGEST.monthly };
        assert.equal(digestDue({ row, now: AT('2026-08-01T00:00:00Z') }), true);
    });

    test('an unreadable date is due rather than never', () => {
        const row = { digestFrequency: DIGEST.weekly, digestAt: 'sometime last spring' };
        assert.equal(digestDue({ row, now: AT('2026-08-01T00:00:00Z') }), true);
    });

    test('weekly waits for the chosen weekday', () => {
        const row = {
            digestFrequency: DIGEST.weekly,
            digestWeekday: 2,
            digestWeek: 1,
            digestAt: '2026-08-01T13:15:00.000Z'
        };
        assert.equal(digestDue({ row, now: AT('2026-08-03T13:15:00Z') }), false);
        assert.equal(digestDue({ row, now: AT('2026-08-04T13:15:00Z') }), true);
    });

    test('a missed weekly run catches up once rather than waiting another week', () => {
        const row = {
            digestFrequency: DIGEST.weekly,
            digestWeekday: 2,
            digestWeek: 1,
            digestAt: '2026-08-01T13:15:00.000Z'
        };
        assert.equal(digestDue({ row, now: AT('2026-08-05T13:15:00Z') }), true);
        row.digestAt = '2026-08-05T13:15:00.000Z';
        assert.equal(digestDue({ row, now: AT('2026-08-06T13:15:00Z') }), false);
    });

    test('monthly uses the selected occurrence of the weekday', () => {
        const row = {
            digestFrequency: DIGEST.monthly,
            digestWeekday: 2,
            digestWeek: 2,
            digestAt: '2026-08-01T13:15:00.000Z'
        };
        assert.equal(digestDue({ row, now: AT('2026-08-10T13:15:00Z') }), false);
        assert.equal(digestDue({ row, now: AT('2026-08-11T13:15:00Z') }), true);
    });

    test('old rows inherit the occurrence of their last digest', () => {
        const row = {
            digestFrequency: DIGEST.monthly,
            digestAt: '2026-08-20T13:15:00.000Z'
        };
        assert.deepEqual(digestSchedule(row), { weekday: 4, week: 3 });
        assert.equal(digestDue({ row, now: AT('2026-09-16T13:15:00Z') }), false);
        assert.equal(digestDue({ row, now: AT('2026-09-17T13:15:00Z') }), true);
    });
});

describe('finding everybody who is due', () => {
    test('the scan ignores any row that is not a profile', async () => {
        const store = memoryStore();
        await setDigest({ tables: store, email: THEM, frequency: DIGEST.monthly, now: AT('2026-08-01T00:00:00Z') });
        await store.upsertEntity(TABLES.users, {
            partitionKey: THEM,
            rowKey: 'something-a-later-feature-added',
            digestFrequency: DIGEST.weekly
        });

        const rows = await everyUser({ tables: store });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].rowKey, 'profile');
    });

    test('marking a cycle done moves the window and nothing else', async () => {
        const store = memoryStore();
        await setDigest({ tables: store, email: THEM, frequency: DIGEST.weekly, now: AT('2026-08-01T00:00:00Z') });
        await markDigested({ tables: store, email: THEM, at: '2026-08-08T13:15:00.000Z' });

        const row = await readUser({ tables: store, email: THEM });
        assert.equal(row.digestAt, '2026-08-08T13:15:00.000Z');
        assert.equal(row.digestFrequency, DIGEST.weekly);
        assert.equal(row.createdAt, '2026-08-01T00:00:00.000Z');
    });
});
