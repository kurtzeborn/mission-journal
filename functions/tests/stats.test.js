// How big the service is, counted from what is already written down.
//
// Nothing here is authoritative -- every number is derived from an index kept
// for another purpose -- so what is worth testing is not the arithmetic but the
// places where an obvious sum would be wrong: a grandmother following two
// missionaries is one person, an archive nobody has written to yet is zero
// rather than an error, and a family hiding half their letters still has them.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import { serviceStats } from '../src/lib/stats.js';
import { stats } from '../src/functions/deletions.js';
import { touchSiteActivity } from '../src/lib/sites.js';
import { recordMembership } from '../src/lib/memberships.js';
import { recordVisit } from '../src/lib/visits.js';
import { ROLE } from '../src/lib/acl.js';

const OPERATOR = 'scott@example.org';
const silent = { info() {}, warn() {}, error() {} };

const letter = (fields = {}) => ({ ulid: '01ARZ3NDEKTSV4RRFFQ69G5FAV', date: '2026-08-01', ...fields });

const pictures = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, width: 800, height: 600 }));

/** An archive with a site row and, when given some, a rendered posts file. */
async function archive(store, slug, posts) {
    await touchSiteActivity({
        tables: store,
        slug,
        lastPostAt: '2026-08-01T00:00:00.000Z',
        receivedAt: '2026-08-01T00:00:00.000Z'
    });
    if (posts) {
        await store.writeBlob(
            'rendered',
            `${slug}/posts.json`,
            Buffer.from(JSON.stringify(posts), 'utf8')
        );
    }
}

const byId = (archives) => new Map(archives.map((a) => [a.slug, a]));

describe('counting the service', () => {
    test('letters, photographs and people, per archive and in total', async () => {
        const store = memoryStore();

        await archive(store, 'elder.one', [
            letter({ photos: pictures(3) }),
            letter({ photos: pictures(1) })
        ]);
        await archive(store, 'elder.two', [letter({ photos: [] })]);

        await recordMembership({ tables: store, email: 'mum@example.com', slug: 'elder.one', role: ROLE.owner });
        await recordMembership({ tables: store, email: 'gran@example.com', slug: 'elder.one', role: ROLE.reader });
        await recordMembership({ tables: store, email: 'dad@example.com', slug: 'elder.two', role: ROLE.owner });

        const { totals, archives } = await serviceStats({ store, tables: store, log: silent });

        assert.deepEqual(totals, {
            archives: 2,
            letters: 3,
            hidden: 0,
            photos: 4,
            people: 3,
            daily: 0,
            monthly: 0
        });

        const found = byId(archives);
        assert.deepEqual(found.get('elder.one'), {
            slug: 'elder.one',
            people: 2,
            letters: 2,
            hidden: 0,
            photos: 4,
            daily: 0,
            monthly: 0
        });
        assert.equal(found.get('elder.two').letters, 1);
    });

    test('a grandmother following two missionaries is one person', async () => {
        // The per-archive counts add up to three and the honest answer is two.
        // Summing the columns is exactly the mistake this guards.
        const store = memoryStore();

        await archive(store, 'elder.one', [letter()]);
        await archive(store, 'elder.two', [letter()]);

        for (const slug of ['elder.one', 'elder.two']) {
            await recordMembership({ tables: store, email: 'gran@example.com', slug, role: ROLE.reader });
        }
        await recordMembership({ tables: store, email: 'mum@example.com', slug: 'elder.one', role: ROLE.owner });

        const { totals, archives } = await serviceStats({ store, tables: store, log: silent });

        assert.equal(totals.people, 2);
        assert.deepEqual(
            byId(archives).get('elder.one').people + byId(archives).get('elder.two').people,
            3
        );
    });

    test('an archive nobody has written to yet is zeroes, not a failure', async () => {
        // The ordinary state of a claimed archive between the claim and the
        // first letter. There is no posts.json at all.
        const store = memoryStore();
        await archive(store, 'elder.new');

        const { totals, archives } = await serviceStats({ store, tables: store, log: silent });

        assert.equal(totals.archives, 1);
        assert.deepEqual(archives[0], {
            slug: 'elder.new',
            people: 0,
            letters: 0,
            hidden: 0,
            photos: 0,
            daily: 0,
            monthly: 0
        });
    });

    test('an unreadable archive costs its own numbers and nobody else theirs', async () => {
        // A report that throws takes four working tables off the page with it.
        const store = memoryStore();
        await archive(store, 'elder.broken');
        await store.writeBlob('rendered', 'elder.broken/posts.json', Buffer.from('{not json', 'utf8'));
        await archive(store, 'elder.fine', [letter({ photos: pictures(2) })]);

        const { totals } = await serviceStats({ store, tables: store, log: silent });

        assert.equal(totals.archives, 2);
        assert.equal(totals.letters, 1);
        assert.equal(totals.photos, 2);
    });

    test('hidden letters are counted beside the total, not taken out of it', async () => {
        // A family hiding half their letters is worth seeing, and it is
        // invisible in a total that has already had them removed.
        const store = memoryStore();
        await archive(store, 'elder.one', [letter(), letter({ hidden: true }), letter({ hidden: true })]);

        const { totals } = await serviceStats({ store, tables: store, log: silent });

        assert.equal(totals.letters, 3);
        assert.equal(totals.hidden, 2);
    });
});

describe('the stats route', () => {
    const signedIn = (email) =>
        email
            ? Buffer.from(JSON.stringify({ userDetails: email, identityProvider: 'google' })).toString('base64')
            : null;

    const asking = (email) => ({
        method: 'GET',
        url: 'https://example.org/api/manage/stats',
        headers: { get: (name) => (name === 'x-ms-client-principal' ? signedIn(email) : null) }
    });

    const ask = async (email, store) => {
        const before = process.env.OPERATOR_EMAILS;
        process.env.OPERATOR_EMAILS = OPERATOR;
        try {
            return await stats(asking(email), silent, store, store);
        } finally {
            if (before === undefined) delete process.env.OPERATOR_EMAILS;
            else process.env.OPERATOR_EMAILS = before;
        }
    };

    test('answers an operator', async () => {
        const store = memoryStore();
        await archive(store, 'elder.one', [letter()]);

        const response = await ask(OPERATOR, store);

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.totals.archives, 1);
    });

    test('and refuses an owner of a real archive with a stranger\u2019s 404', async () => {
        const store = memoryStore();
        await archive(store, 'elder.one', [letter()]);

        assert.equal((await ask('mum@example.com', store)).status, 404);
        assert.equal((await ask(null, store)).status, 401);
    });

    test('and is never cached, because a stale dashboard is a lie', async () => {
        const response = await ask(OPERATOR, memoryStore());

        assert.match(response.headers['Cache-Control'], /no-store/);
    });
});

describe('how much of it is being read', () => {
    const NOW = new Date('2026-08-16T12:00:00Z');
    const back = (days) => new Date(NOW.getTime() - days * 86400000);

    test('the reading numbers ride along with the size ones', async () => {
        const store = memoryStore();
        await archive(store, 'elder.one', [letter()]);
        await archive(store, 'elder.two', [letter()]);

        await recordVisit({ tables: store, slug: 'elder.one', email: 'gran@example.com', now: () => NOW });
        await recordVisit({ tables: store, slug: 'elder.two', email: 'gran@example.com', now: () => NOW });
        await recordVisit({ tables: store, slug: 'elder.one', email: 'mum@example.com', now: () => back(5) });

        const { totals, archives } = await serviceStats({ store, tables: store, log: silent, now: () => NOW });
        const found = byId(archives);

        assert.deepEqual(
            { daily: found.get('elder.one').daily, monthly: found.get('elder.one').monthly },
            { daily: 1, monthly: 2 }
        );
        // One person read two archives today. The columns say one each and the
        // total says one, which is the same argument as the people count.
        assert.equal(totals.daily, 1);
        assert.equal(totals.monthly, 2);
    });

    test('an archive nobody has opened reads as zero rather than nothing', async () => {
        const store = memoryStore();
        await archive(store, 'elder.quiet', [letter()]);

        const { totals, archives } = await serviceStats({ store, tables: store, log: silent, now: () => NOW });

        assert.deepEqual({ daily: archives[0].daily, monthly: archives[0].monthly }, { daily: 0, monthly: 0 });
        assert.equal(totals.daily, 0);
    });
});
