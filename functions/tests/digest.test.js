// Telling people a letter arrived.
//
// The plan's own verification list is most of what follows: one recipient on
// two archives gets one email describing both; the window boundary is checked
// by back-dating; a hidden letter never appears. The rest is the arithmetic
// of a nudge -- an empty month sends nothing but still ends, a suppressed
// address is skipped without asking what is new, and a send that fails does
// not come back tomorrow.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { ROLE } from '../src/lib/acl.js';
import { digestEmail, lettersSince, newFor, runDigests, snippetOf } from '../src/lib/digest.js';
import { recordMembership } from '../src/lib/memberships.js';
import { recordOptOut, issueOptOut } from '../src/lib/optout.js';
import { setSiteProfile, touchSiteActivity } from '../src/lib/sites.js';
import { readUser, setDigest, DIGEST } from '../src/lib/users.js';

const silent = { info() {}, warn() {}, error() {} };
const KEY = 'a-signing-key-from-key-vault';
const BASE = 'https://pdayletters.com';
const THEM = 'grandma@example.com';

const ONE = 'elder.example';
const TWO = 'sister.example';

const AT = (iso) => () => new Date(iso);

const letter = (fields) => ({
    id: fields.id,
    subject: fields.subject ?? 'A letter',
    originalDate: fields.originalDate ?? '2026-08-03T00:00:00.000Z',
    receivedAt: fields.receivedAt ?? '2026-08-03T12:00:00.000Z',
    bodyHtml: fields.bodyHtml ?? '<p>Hello from the mission.</p>',
    bodyText: fields.bodyText ?? '',
    photos: fields.photos ?? [],
    hidden: fields.hidden ?? false
});

async function archive(store, { slug, name, posts, lastReceivedAt }) {
    await store.writeBlob(
        'rendered',
        `${slug}/posts.json`,
        Buffer.from(JSON.stringify(posts), 'utf8'),
        { contentType: 'application/json' }
    );
    await setSiteProfile({ tables: store, slug, missionaryDisplayName: name });
    if (lastReceivedAt !== undefined) {
        await touchSiteActivity({
            tables: store,
            slug,
            lastPostAt: posts.at(-1)?.originalDate ?? '2026-08-03T00:00:00.000Z',
            receivedAt: lastReceivedAt
        });
    }
}

const recorder = (status = 'sent') => {
    const sent = [];
    return {
        sent,
        send: async (message) => {
            sent.push(message);
            return { status };
        }
    };
};

describe('the opening of a letter, in an inbox', () => {
    test('the markup is read as text, not stripped of angle brackets', () => {
        const post = letter({ id: 'a', bodyHtml: '<p>We taught <b>Ana</b> today.</p><p>She said yes.</p>' });
        assert.equal(snippetOf(post, ONE), 'We taught Ana today. She said yes.');
    });

    test('a letter with no markup falls back to its plain text', () => {
        const post = letter({ id: 'a', bodyHtml: '', bodyText: '  Rain all week.\n\nStill happy.  ' });
        assert.equal(snippetOf(post, ONE), 'Rain all week. Still happy.');
    });

    test('a long letter is cut at a word and marked as cut', () => {
        const post = letter({ id: 'a', bodyHtml: `<p>${'walking '.repeat(60)}</p>` });
        const snippet = snippetOf(post, ONE);
        assert.ok(snippet.length <= 181, `too long: ${snippet.length}`);
        assert.ok(snippet.endsWith('\u2026'));
        assert.ok(!snippet.includes('walkin\u2026'), 'cut in the middle of a word');
    });
});

describe('which letters are new', () => {
    test('freshness is the arrival, not the date on the letter', async () => {
        const store = memoryStore();
        await archive(store, {
            slug: ONE,
            name: 'Elder Example',
            posts: [
                // Two years old and forwarded last night. This is the backlog
                // case: nothing here is dated inside the window.
                letter({ id: 'old', originalDate: '2024-05-01T00:00:00.000Z', receivedAt: '2026-08-04T09:00:00.000Z' })
            ]
        });

        const found = await lettersSince({ store, slug: ONE, since: '2026-08-01T00:00:00.000Z' });
        assert.deepEqual(found.map((post) => post.id), ['old']);
    });

    test('a letter that arrived before the window is not new', async () => {
        const store = memoryStore();
        await archive(store, {
            slug: ONE,
            name: 'Elder Example',
            posts: [
                letter({ id: 'before', receivedAt: '2026-07-30T00:00:00.000Z' }),
                letter({ id: 'after', receivedAt: '2026-08-02T00:00:00.000Z' })
            ]
        });

        const found = await lettersSince({ store, slug: ONE, since: '2026-08-01T00:00:00.000Z' });
        assert.deepEqual(found.map((post) => post.id), ['after']);
    });

    test('a hidden letter is never mentioned, because a digest is a reader', async () => {
        const store = memoryStore();
        await archive(store, {
            slug: ONE,
            name: 'Elder Example',
            posts: [
                letter({ id: 'shown', receivedAt: '2026-08-02T00:00:00.000Z' }),
                letter({ id: 'hidden', receivedAt: '2026-08-02T01:00:00.000Z', hidden: true })
            ]
        });

        const found = await lettersSince({ store, slug: ONE, since: '2026-08-01T00:00:00.000Z' });
        assert.deepEqual(found.map((post) => post.id), ['shown']);
    });

    test('photographs are counted and never linked', async () => {
        const store = memoryStore();
        await archive(store, {
            slug: ONE,
            name: 'Elder Example',
            posts: [letter({ id: 'a', photos: [{ id: 'p1' }, { id: 'p2' }] })]
        });

        const [found] = await lettersSince({ store, slug: ONE, since: '2026-08-01T00:00:00.000Z' });
        assert.equal(found.photos, 2);
        assert.equal(typeof found.photos, 'number');
    });

    test('an archive whose file cannot be parsed is skipped, not fatal', async () => {
        const store = memoryStore();
        await store.writeBlob('rendered', `${ONE}/posts.json`, Buffer.from('{ not json', 'utf8'), {
            contentType: 'application/json'
        });

        assert.deepEqual(await lettersSince({ store, slug: ONE, since: '2026-08-01T00:00:00.000Z' }), []);
    });
});

describe('what one person has to catch up on', () => {
    async function following({ lastReceivedOne, lastReceivedTwo } = {}) {
        const store = memoryStore();

        await archive(store, {
            slug: ONE,
            name: 'Elder Example',
            posts: [letter({ id: 'one-a', subject: 'Week 4', receivedAt: '2026-08-02T00:00:00.000Z' })],
            lastReceivedAt: lastReceivedOne
        });
        await archive(store, {
            slug: TWO,
            name: 'Sister Example',
            posts: [letter({ id: 'two-a', subject: 'Transfer', receivedAt: '2026-08-03T00:00:00.000Z' })],
            lastReceivedAt: lastReceivedTwo
        });

        await recordMembership({ tables: store, email: THEM, slug: ONE, role: ROLE.reader, now: AT('2026-07-01T00:00:00Z') });
        await recordMembership({ tables: store, email: THEM, slug: TWO, role: ROLE.reader, now: AT('2026-07-01T00:00:00Z') });

        return store;
    }

    test('two archives are one list, so one email can describe both', async () => {
        const store = await following();
        const archives = await newFor({ store, tables: store, email: THEM, since: '2026-08-01T00:00:00.000Z' });

        assert.deepEqual(archives.map((one) => one.slug).sort(), [ONE, TWO]);
        assert.equal(archives.reduce((total, one) => total + one.letters.length, 0), 2);
    });

    test('an archive that has been quiet all month is skipped without reading it', async () => {
        const store = await following({ lastReceivedOne: '2026-07-20T00:00:00.000Z' });
        const archives = await newFor({ store, tables: store, email: THEM, since: '2026-08-01T00:00:00.000Z' });

        assert.deepEqual(archives.map((one) => one.slug), [TWO]);
    });

    test('a site with no name is described by its slug rather than by nothing', async () => {
        const store = memoryStore();
        await store.writeBlob(
            'rendered',
            `${ONE}/posts.json`,
            Buffer.from(JSON.stringify([letter({ id: 'a', receivedAt: '2026-08-02T00:00:00.000Z' })]), 'utf8'),
            { contentType: 'application/json' }
        );
        await recordMembership({ tables: store, email: THEM, slug: ONE, role: ROLE.reader, now: AT('2026-07-01T00:00:00Z') });

        const [only] = await newFor({ store, tables: store, email: THEM, since: '2026-08-01T00:00:00.000Z' });
        assert.equal(only.name, ONE);
    });
});

describe('the message itself', () => {
    const archives = [
        {
            slug: ONE,
            name: 'Elder Example',
            letters: [
                { id: '2026-08-02-abc', subject: 'Week 4', date: '2026-08-02T00:00:00.000Z', photos: 2, snippet: 'We taught Ana today.' }
            ]
        },
        {
            slug: TWO,
            name: 'Sister Example',
            letters: [
                { id: '2026-08-03-def', subject: 'Transfer', date: '2026-08-03T00:00:00.000Z', photos: 0, snippet: 'Moving north.' }
            ]
        }
    ];

    test('one archive is named in the subject, because the reader is already on its list', () => {
        const { subject } = digestEmail({ baseUrl: BASE, archives: [archives[0]] });
        assert.equal(subject, '1 new letter from Elder Example');
    });

    test('several archives are counted rather than listed', () => {
        const { subject, count } = digestEmail({ baseUrl: BASE, archives });
        assert.equal(subject, '2 new letters on Pday Letters');
        assert.equal(count, 2);
    });

    test('every letter is a link to that letter, not to the top of the archive', () => {
        const { text, html } = digestEmail({ baseUrl: BASE, archives });
        assert.ok(text.includes(`${BASE}/${ONE}/#panel-2026-08-02-abc`));
        assert.ok(html.includes(`${BASE}/${TWO}/#panel-2026-08-03-def`));
    });

    test('photographs are counted in words and no image is ever fetched', () => {
        const { text, html } = digestEmail({ baseUrl: BASE, archives });
        assert.ok(text.includes('2 photographs'));
        assert.ok(!html.includes('<img'), 'an image would be fetched and cached by the inbox');
    });

    test('both bodies point at the settings page, and at the opt-out when we can sign one', () => {
        const without = digestEmail({ baseUrl: BASE, archives });
        assert.ok(without.text.includes(`${BASE}/email`));
        assert.ok(!without.text.includes('/optout'));

        const with_ = digestEmail({ baseUrl: BASE, archives, optOutToken: 'signed-token' });
        assert.ok(with_.text.includes(`${BASE}/optout#signed-token`));
        assert.ok(with_.html.includes(`${BASE}/optout#signed-token`));
    });

    test('a subject line from a letter cannot become markup in the html', () => {
        const nasty = [{ ...archives[0], letters: [{ ...archives[0].letters[0], subject: '<script>x</script>' }] }];
        const { html } = digestEmail({ baseUrl: BASE, archives: nasty });
        assert.ok(!html.includes('<script>'));
        assert.ok(html.includes('&lt;script&gt;'));
    });
});

describe('the run', () => {
    async function ready({ frequency = DIGEST.monthly, answeredAt = '2026-07-01T00:00:00Z' } = {}) {
        const store = memoryStore();
        await archive(store, {
            slug: ONE,
            name: 'Elder Example',
            posts: [letter({ id: 'a', receivedAt: '2026-08-02T00:00:00.000Z' })],
            lastReceivedAt: '2026-08-02T00:00:00.000Z'
        });
        await recordMembership({ tables: store, email: THEM, slug: ONE, role: ROLE.reader, now: AT(answeredAt) });
        await setDigest({ tables: store, email: THEM, frequency, now: AT(answeredAt) });
        return store;
    }

    const run = (store, mailer, now) =>
        runDigests({ store, tables: store, mailer, key: KEY, baseUrl: BASE, now, log: silent });

    test('one recipient on one archive gets one email', async () => {
        const store = await ready();
        const mailer = recorder();

        const result = await run(store, mailer, AT('2026-08-05T13:15:00Z'));

        assert.deepEqual(result, { considered: 1, due: 1, sent: 1, empty: 0, failed: 0 });
        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].to, THEM);
        assert.equal(mailer.sent[0].headers['Auto-Submitted'], 'auto-generated');
        assert.ok(mailer.sent[0].headers['List-Unsubscribe'], 'a bulk message needs the header');
    });

    test('somebody whose cycle is not over is left alone', async () => {
        const store = await ready({ answeredAt: '2026-08-04T00:00:00Z' });
        const mailer = recorder();

        const result = await run(store, mailer, AT('2026-08-05T13:15:00Z'));

        assert.equal(result.due, 0);
        assert.equal(mailer.sent.length, 0);
    });

    test('never means never, whatever has arrived', async () => {
        const store = await ready({ frequency: DIGEST.off });
        const mailer = recorder();

        const result = await run(store, mailer, AT('2026-08-05T13:15:00Z'));

        assert.equal(result.due, 0);
        assert.equal(mailer.sent.length, 0);
    });

    test('an address that asked us to stop is not written to, preference or not', async () => {
        const store = await ready();
        await recordOptOut({
            tables: store,
            token: issueOptOut({ email: THEM, slug: ONE, key: KEY, now: AT('2026-08-03T00:00:00Z') }),
            key: KEY,
            now: AT('2026-08-03T00:00:00Z'),
            log: silent
        });
        const mailer = recorder();

        const result = await run(store, mailer, AT('2026-08-05T13:15:00Z'));

        assert.equal(mailer.sent.length, 0);
        assert.equal(result.empty, 1);

        // The preference is left standing rather than rewritten, because it is
        // what they get back if the suppression is ever lifted.
        assert.equal((await readUser({ tables: store, email: THEM })).digestFrequency, DIGEST.monthly);
    });

    test('a quiet month sends nothing but still ends', async () => {
        const store = await ready();
        const mailer = recorder();

        await run(store, mailer, AT('2026-08-05T13:15:00Z'));
        const second = await run(store, mailer, AT('2026-09-06T13:15:00Z'));

        assert.equal(second.due, 1);
        assert.equal(second.empty, 1);
        assert.equal(mailer.sent.length, 1, 'the same letter was described twice');
        assert.equal(
            (await readUser({ tables: store, email: THEM })).digestAt,
            '2026-09-06T13:15:00.000Z'
        );
    });

    test('a send that fails is not tried again tomorrow', async () => {
        const store = await ready();
        const mailer = recorder('failed');

        const result = await run(store, mailer, AT('2026-08-05T13:15:00Z'));

        assert.equal(result.failed, 1);
        assert.equal(
            (await readUser({ tables: store, email: THEM })).digestAt,
            '2026-08-05T13:15:00.000Z',
            'the window went back, so this nudge repeats daily'
        );
    });

    test('one address throwing does not stop the next one', async () => {
        const store = await ready();
        await setDigest({ tables: store, email: 'aunt@example.com', frequency: DIGEST.monthly, now: AT('2026-07-01T00:00:00Z') });

        const mailer = recorder();
        const exploding = {
            ...store,
            readBlob: async (container, name) => {
                if (name.startsWith(ONE)) throw new Error('storage is having a moment');
                return store.readBlob(container, name);
            }
        };

        const result = await runDigests({
            store: exploding,
            tables: store,
            mailer,
            key: KEY,
            baseUrl: BASE,
            now: AT('2026-08-05T13:15:00Z'),
            log: silent
        });

        assert.equal(result.due, 2);
        assert.equal(result.failed, 1);
        assert.equal(result.empty, 1, 'the address with no memberships still finished its cycle');
    });
});
