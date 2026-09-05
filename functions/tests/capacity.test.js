// The two messages that tell an archive's owners it is running out of room.
//
// The thresholds are exercised by count rather than by driving letters through
// ingest, because what is being tested is the arithmetic that decides whether
// anybody hears anything -- ingest.test.js covers the wiring.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import { roomEmail, warnIfFilling, NEAR } from '../src/lib/capacity.js';
import { ARCHIVE_CAP } from '../src/lib/cap.js';

const SLUG = 'elder.example';
const BASE = 'https://pdayletters.com';
const silent = { info() {}, warn() {}, error() {} };

const MEMBERS = [
    // Mixed case on purpose: an ACL holds what somebody typed.
    { email: 'Mum@example.com', role: 'owner' },
    { email: 'dad@example.com', role: 'owner' },
    { email: 'gran@example.com', role: 'reader' }
];

const recorder = () => {
    const mailer = { sent: [], send: async (m) => (mailer.sent.push(m), { status: 'sent' }) };
    return mailer;
};

const archive = (members = MEMBERS) => {
    const store = memoryStore();
    store.acl(SLUG, members);
    return store;
};

const warn = (store, mailer, count, extra = {}) =>
    warnIfFilling({ store, mailer, slug: SLUG, count, baseUrl: BASE, log: silent, ...extra });

describe('when the owners hear about it', () => {
    test('an ordinary letter says nothing', async () => {
        const store = archive();

        for (const count of [1, 44, ARCHIVE_CAP - NEAR - 1, ARCHIVE_CAP - NEAR + 1, ARCHIVE_CAP - 1]) {
            const mailer = recorder();
            const result = await warn(store, mailer, count);
            assert.equal(result.status, 'quiet', `count ${count} should be quiet`);
            assert.equal(mailer.sent.length, 0, `count ${count} sent mail`);
        }
    });

    test('the first warning lands ten letters out', async () => {
        const store = archive();
        const mailer = recorder();

        await warn(store, mailer, ARCHIVE_CAP - NEAR);

        assert.equal(mailer.sent.length, 2);
        assert.match(mailer.sent[0].subject, /nearly full/);
    });

    test('the second lands as the archive fills, before anything is refused', async () => {
        const store = archive();
        const mailer = recorder();

        await warn(store, mailer, ARCHIVE_CAP);

        assert.equal(mailer.sent.length, 2);
        assert.match(mailer.sent[0].subject, /is full/);
    });

    // A count is passed through exactly once, so an equality test is the whole
    // of the rate limiting -- and deleting letters re-arms both warnings for
    // free, which a once-ever suppression row would have prevented.
    test('filling, emptying and filling again warns twice', async () => {
        const store = archive();
        const mailer = recorder();

        await warn(store, mailer, ARCHIVE_CAP);
        await warn(store, mailer, ARCHIVE_CAP - 30);
        await warn(store, mailer, ARCHIVE_CAP);

        assert.equal(mailer.sent.length, 4);
    });

    test('only owners are written to, and addresses are lowercased', async () => {
        const store = archive();
        const mailer = recorder();

        await warn(store, mailer, ARCHIVE_CAP);

        assert.deepEqual(
            mailer.sent.map((m) => m.to).sort(),
            ['dad@example.com', 'mum@example.com']
        );
    });

    test('it comes from the address a reply can reach a person at', async () => {
        const store = archive();
        const mailer = recorder();

        await warn(store, mailer, ARCHIVE_CAP);

        assert.equal(mailer.sent[0].from, 'Pday Letters <hello@pdayletters.com>');
        assert.equal(mailer.sent[0].headers['Auto-Submitted'], 'auto-generated');
    });

    test('an owner who asked us to stop is left alone', async () => {
        const store = archive();
        const mailer = recorder();

        // The opt-out row key is a hash, so the stub answers by call order
        // rather than by address: the first owner asked us to stop.
        let asked = 0;
        const tables = { getEntity: async () => (++asked === 1 ? { partitionKey: 'optout' } : null) };

        await warn(store, mailer, ARCHIVE_CAP, { tables });

        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].to, 'dad@example.com');
    });

    test('one bad address does not cost the other owner their warning', async () => {
        const store = archive();
        const mailer = {
            sent: [],
            send: async (m) => {
                if (m.to === 'mum@example.com') throw new Error('mailbox unavailable');
                mailer.sent.push(m);
                return { status: 'sent' };
            }
        };

        const result = await warn(store, mailer, ARCHIVE_CAP);

        assert.equal(result.sent, 1);
        assert.equal(mailer.sent[0].to, 'dad@example.com');
    });

    test('a site with no ACL and a run with no mailer are both quiet', async () => {
        const mailer = recorder();

        assert.equal((await warn(memoryStore(), mailer, ARCHIVE_CAP)).sent, 0);
        assert.equal((await warn(archive(), null, ARCHIVE_CAP)).status, 'skipped');
    });

    test('an archive of readers only has nobody to tell', async () => {
        const store = archive([{ email: 'gran@example.com', role: 'reader' }]);
        const mailer = recorder();

        const result = await warn(store, mailer, ARCHIVE_CAP);

        assert.equal(result.owners, 0);
        assert.equal(mailer.sent.length, 0);
    });
});

describe('what the messages say', () => {
    const near = roomEmail({ slug: SLUG, count: ARCHIVE_CAP - NEAR, baseUrl: BASE });
    const full = roomEmail({ slug: SLUG, count: ARCHIVE_CAP, baseUrl: BASE });

    test('the first one names the archive, the count and the room left', () => {
        assert.match(near.text, new RegExp(`${SLUG} holds ${ARCHIVE_CAP - NEAR} letters`));
        assert.match(near.text, new RegExp(`room for ${NEAR} more`));
        assert.match(near.text, /https:\/\/pdayletters\.com\/elder\.example\//);
    });

    test('the second says plainly that the next letter will not be added', () => {
        assert.match(full.text, /next letter sent to it will not be added/);
    });

    // The one fact that decides whether this is urgent. Without it an owner
    // reasonably assumes a refused letter is either safe forever or gone.
    test('the second names the thirty days', () => {
        assert.match(full.text, /thirty\s+days/);
        assert.doesNotMatch(near.text, /thirty/);
    });

    test('both offer a way out that is not deleting letters', () => {
        assert.match(near.text, /reply to this message/);
        assert.match(full.text, /reply to this message/);
    });

    // Visible on a lock screen, so it stays out of the subject -- the same
    // courtesy nudge.js keeps with a missionary's name.
    test('the archive is not named in either subject', () => {
        assert.doesNotMatch(near.subject, new RegExp(SLUG));
        assert.doesNotMatch(full.subject, new RegExp(SLUG));
        assert.notEqual(near.subject, full.subject);
    });

    test('the HTML carries the same link and escapes what it is given', () => {
        const nasty = roomEmail({ slug: 'a"><script>x</script>', count: ARCHIVE_CAP, baseUrl: BASE });
        assert.ok(!nasty.html.includes('<script>'));
        assert.match(full.html, /<a href="https:\/\/pdayletters\.com\/elder\.example\/"/);
    });
});
