// The record of a first letter turned away, and the three doors out of one.
//
// A rejection is the most invisible outcome in the service: it writes nothing,
// renders nothing, and tells only the person it happened to. If they follow
// the advice and fail again, `nudgeOnce` has already spoken and stays quiet.
// So the case these tests exist for is the one that produces silence at both
// ends -- a family stuck, and nobody on this side able to see it.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runIngest } from '../src/lib/ingest.js';
import { classify, CLASS, DISPOSITION } from '../src/lib/classify.js';
import { extractOriginal } from '../src/lib/extract.js';
import { nudgeOnce, forgetNudge, NUDGE } from '../src/lib/nudge.js';
import {
    KEEP_DAYS,
    forgetRejection,
    listRejections,
    purgeRejections,
    recordRejection
} from '../src/lib/rejections.js';
import { settledIn } from '../src/functions/rejections.js';
import { validUlid } from '../src/lib/paths.js';
import { TABLES } from '../src/lib/tables.js';
import { memoryStore } from './memory-store.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const config = { authservId: 'mx.cloudflare.net', missionaryDomains: ['missionary.org'] };
const silent = { info() {}, warn() {}, error() {} };
const NOW = () => new Date('2026-08-03T12:00:00Z');
const later = (days) => () => new Date(Date.parse('2026-08-03T12:00:00Z') + days * 86400000);

const recorder = () => {
    const mailer = { sent: [], send: async (m) => (mailer.sent.push(m), { status: 'sent' }) };
    return mailer;
};

const forward = async (store, name, { ulid = '01TEST0000000000000000000', bypass = '', mailer } = {}) => {
    store.seed(ulid, await raw(name));
    return runIngest({
        ulid,
        store,
        tables: store,
        mailer: mailer ?? recorder(),
        config,
        log: silent,
        now: NOW,
        bypass,
        // The whole subject here is what happens when the embedded signature
        // does not hold, so it never does.
        verifyDkim: async () => ({ verified: false, reason: 'test', signatures: [] })
    });
};

const kept = (store) => store.listEntities(TABLES.rejections);

describe('what a refused first letter leaves behind', () => {
    test('an inline forward leaves a row somebody can act on', async () => {
        const store = memoryStore();
        const result = await forward(store, 'outlook-web-inline');

        assert.equal(result.status, 'rejected');

        const rows = await kept(store);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].partitionKey, 'elder.example');
        assert.equal(rows[0].rowKey, '01TEST0000000000000000000');
        assert.equal(rows[0].reason, 'bootstrap-not-attached');
        assert.equal(rows[0].sender, 'scott@kurtzeborn.org');
        assert.ok(rows[0].subject, 'nothing on the row says which letter it was');
    });

    test('and so does an attachment whose signature did not survive', async () => {
        const store = memoryStore();
        await forward(store, 'outlook-web-attached');

        const rows = await kept(store);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].reason, 'bootstrap-unverified');
    });

    test('the row is kept exactly as long as the message it names', async () => {
        // Both doors out of a rejection re-read `inbox/{ulid}.raw`, which the
        // account expires after thirty days. A row that outlived it would be
        // an offer of help that cannot be honoured.
        const store = memoryStore();
        await forward(store, 'outlook-web-inline');

        const [row] = await kept(store);
        const days = (Date.parse(row.forgetAfter) - Date.parse(row.at)) / 86400000;
        assert.equal(days, KEEP_DAYS);
    });

    test('but a rejection that is not somebody stuck leaves nothing', async () => {
        // Strangers, spammers and loops. A list that fills with those is a
        // list nobody reads, and the rows this exists for would be buried.
        const store = memoryStore();

        for (const reason of ['forwarder-not-on-acl', 'author-not-missionary', 'no-recoverable-original']) {
            const wrote = await recordRejection({
                tables: store,
                ulid: '01TEST0000000000000000000',
                slug: 'elder.example',
                verdict: { reason, sender: 'someone@example.com' },
                extracted: {},
                now: NOW,
                log: silent
            });
            assert.equal(wrote, false, `${reason} was recorded`);
        }

        assert.equal((await kept(store)).length, 0);
    });

    test('and failing to record one does not lose the letter twice', async () => {
        // This runs inside the rejection path, after the sender has already
        // been answered. Throwing here would send a handled rejection to the
        // poison queue and run the whole thing four more times.
        const store = memoryStore();
        store.upsertEntity = async () => {
            throw new Error('table is not there');
        };

        const result = await forward(store, 'outlook-web-inline');
        assert.equal(result.status, 'rejected');
    });
});

describe('reading the list back', () => {
    const row = (slug, ulid, at) => ({
        tables: null,
        slug,
        ulid,
        verdict: { reason: 'bootstrap-unverified', sender: 'mum@example.com' },
        extracted: { outerSubject: 'Week one' },
        now: () => new Date(at),
        log: silent
    });

    const seeded = async (store, entries) => {
        for (const [slug, ulid, at] of entries) {
            await recordRejection({ ...row(slug, ulid, at), tables: store });
        }
    };

    test('newest first, because the useful row is the one that just failed', async () => {
        const store = memoryStore();
        await seeded(store, [
            ['elder.one', '01AAA00000000000000000000', '2026-08-01T09:00:00Z'],
            ['elder.two', '01BBB00000000000000000000', '2026-08-03T09:00:00Z'],
            ['elder.three', '01CCC00000000000000000000', '2026-08-02T09:00:00Z']
        ]);

        const listed = await listRejections({ tables: store, now: NOW });
        assert.deepEqual(
            listed.map((r) => r.slug),
            ['elder.two', 'elder.three', 'elder.one']
        );
    });

    test('a row past its own date is not offered', async () => {
        const store = memoryStore();
        await seeded(store, [['elder.one', '01AAA00000000000000000000', '2026-08-01T09:00:00Z']]);

        assert.equal((await listRejections({ tables: store, now: later(40) })).length, 0);
    });

    test('and a slug that has an archive now is dropped, not just hidden', async () => {
        // This is what empties the list: the buttons on the page exist to make
        // the archive appear, so the row that offered them retires itself the
        // moment one of them works.
        const store = memoryStore();
        await seeded(store, [
            ['elder.one', '01AAA00000000000000000000', '2026-08-01T09:00:00Z'],
            ['elder.two', '01BBB00000000000000000000', '2026-08-02T09:00:00Z']
        ]);
        store.acl('elder.one', [{ email: 'mum@example.com', role: 'owner' }]);

        const listed = await listRejections({
            tables: store,
            settled: settledIn(store),
            now: NOW
        });

        assert.deepEqual(
            listed.map((r) => r.slug),
            ['elder.two']
        );
        assert.equal((await kept(store)).length, 1, 'the answered row was left in the table');
    });

    test('a site merely holding letters counts as settled too', async () => {
        // A bypass produces a *pending* archive, not a live one. If only an
        // ACL retired the row, every successful bypass would leave its own
        // rejection sitting on the page underneath it.
        const store = memoryStore();
        await seeded(store, [['elder.one', '01AAA00000000000000000000', '2026-08-01T09:00:00Z']]);
        await store.writeBlob('pending', 'elder.one/claim.json', Buffer.from('{}'), {});

        assert.equal(
            (await listRejections({ tables: store, settled: settledIn(store), now: NOW })).length,
            0
        );
    });

    test('the sweep forgets what the inbox has already forgotten', async () => {
        const store = memoryStore();
        await seeded(store, [
            ['elder.one', '01AAA00000000000000000000', '2026-08-01T09:00:00Z'],
            ['elder.two', '01BBB00000000000000000000', '2026-09-20T09:00:00Z']
        ]);

        const swept = await purgeRejections({ tables: store, now: later(40), log: silent });

        assert.equal(swept.forgotten, 1);
        assert.deepEqual((await kept(store)).map((r) => r.partitionKey), ['elder.two']);
    });

    test('and a row can be dropped by hand', async () => {
        const store = memoryStore();
        await seeded(store, [['elder.one', '01AAA00000000000000000000', '2026-08-01T09:00:00Z']]);

        await forgetRejection({ tables: store, slug: 'elder.one', ulid: '01AAA00000000000000000000' });
        assert.equal((await kept(store)).length, 0);
    });
});

describe('the operator bypass', () => {
    test('starts an archive from a letter the rules refused', async () => {
        const store = memoryStore();
        const result = await forward(store, 'outlook-web-attached', {
            bypass: 'scott@example.org'
        });

        assert.notEqual(result.status, 'rejected');
        assert.ok(store.json('pending', 'elder.example/claim.json'), 'nothing was held');
    });

    test('and from an inline forward, which has no signature at all', async () => {
        // The case with no other answer: a family whose only mail client
        // cannot attach a message. Nothing about the letter proves anything,
        // which is exactly why this needs a person on it.
        const store = memoryStore();
        const result = await forward(store, 'outlook-web-inline', { bypass: 'scott@example.org' });

        assert.notEqual(result.status, 'rejected');
        assert.ok(store.json('pending', 'elder.example/claim.json'));
    });

    test('what it produces is still only a pending archive', async () => {
        // The forcing stops at the door. Nobody reads a bypassed letter until
        // somebody with the missionary's own mail has claimed the site.
        const store = memoryStore();
        await forward(store, 'outlook-web-attached', { bypass: 'scott@example.org' });

        assert.equal(store.json('config', 'elder.example/acl.json'), null);
    });

    test('without it the same letter is refused the same way', async () => {
        const store = memoryStore();
        const result = await forward(store, 'outlook-web-attached');

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'bootstrap-unverified');
    });

    test('and it cannot invent an original that was never there', async () => {
        // `no-recoverable-original` is not a judgement call an operator can
        // overrule. There is no letter to hold.
        const extracted = await extractOriginal(await raw('outlook-web-attached'));
        const verdict = classify({
            extracted: { ...extracted, source: 'none' },
            headers: extracted.headers,
            config,
            lookupAcl: () => null,
            dkimVerified: false,
            bypass: true
        });

        assert.equal(verdict.class, CLASS.rejected);
        assert.equal(verdict.reason, 'no-recoverable-original');
    });

    test('and it changes nothing for a site that already exists', async () => {
        // Bypass is about the bootstrap branch only. An archive with an ACL is
        // governed by membership, and a stranger must not become a member of
        // one by being replayed with the flag on.
        const extracted = await extractOriginal(await raw('outlook-web-attached'));
        const verdict = classify({
            extracted,
            headers: extracted.headers,
            config,
            lookupAcl: () => [{ email: 'someone.else@example.com', role: 'owner' }],
            dkimVerified: false,
            bypass: true
        });

        assert.equal(verdict.class, CLASS.rejected);
        assert.equal(verdict.reason, 'forwarder-not-on-acl');
    });

    test('a bootstrap it lets through is held, not published', async () => {
        const extracted = await extractOriginal(await raw('outlook-web-attached'));
        const verdict = classify({
            extracted,
            headers: extracted.headers,
            config,
            lookupAcl: () => null,
            dkimVerified: false,
            bypass: true
        });

        assert.equal(verdict.class, CLASS.bootstrap);
        assert.equal(verdict.disposition, DISPOSITION.hold);
        assert.equal(verdict.dkimVerified, false, 'the verdict claims evidence it does not have');
    });
});

describe('advising somebody a second time', () => {
    const advice = (tables, mailer) => ({
        tables,
        mailer,
        to: 'MUM@example.com',
        author: 'elder.one@missionary.org',
        slug: 'elder.one',
        kind: NUDGE.rebuilt,
        now: NOW,
        log: silent
    });

    test('the once-only rule holds until somebody clears it', async () => {
        // Right for the automatic path and wrong for a person: the advice
        // itself was wrong for every Outlook user until recently, and the
        // people who most need the corrected version are exactly the ones who
        // already received the old one.
        const store = memoryStore();
        const mailer = recorder();

        await nudgeOnce(advice(store, mailer));
        const second = await nudgeOnce(advice(store, mailer));
        assert.equal(second.status, 'duplicate');
        assert.equal(mailer.sent.length, 1);

        await forgetNudge({ tables: store, to: 'mum@example.com', slug: 'elder.one', kind: NUDGE.rebuilt });

        const third = await nudgeOnce(advice(store, mailer));
        assert.equal(third.status, 'sent');
        assert.equal(mailer.sent.length, 2);
    });

    test('clearing one kind does not clear the other', async () => {
        const store = memoryStore();
        const mailer = recorder();

        await nudgeOnce({ ...advice(store, mailer), kind: NUDGE.attach });
        await forgetNudge({ tables: store, to: 'mum@example.com', slug: 'elder.one', kind: NUDGE.rebuilt });

        const again = await nudgeOnce({ ...advice(store, mailer), kind: NUDGE.attach });
        assert.equal(again.status, 'duplicate');
    });
});

describe('what reaches storage from the page', () => {
    test('a ULID is checked, not trusted', () => {
        // It arrives from a URL and is concatenated into `inbox/{ulid}.raw`.
        const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

        assert.equal(validUlid(ULID), ULID);
        assert.equal(validUlid(ULID.toLowerCase()), ULID);
        assert.equal(validUlid(ULID.slice(0, 25)), null, 'a short one was accepted');
        assert.equal(validUlid('../../config/elder.one/acl'), null);
        assert.equal(validUlid('I'.repeat(26)), null, 'I is not in Crockford base32');
        assert.equal(validUlid(null), null);
    });
});
