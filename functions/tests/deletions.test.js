// The operator's door, and who it opens for.
//
// There is no owner-facing undo -- see the header of deletions.js for why --
// so these two routes are the entire recovery path for a deletion somebody
// regrets. Which makes them worth being unusually strict about: they are the
// one place in the service where a caller acts on an archive they were never
// granted anything on.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import { operatorGate } from '../src/lib/api.js';
import { received } from '../src/functions/deletions.js';
import { deleteSite, restoreSite, pendingDeletions } from '../src/lib/deletion.js';
import { touchSiteActivity } from '../src/lib/sites.js';
import { ROLE, readAcl } from '../src/lib/acl.js';
import { TABLES } from '../src/lib/tables.js';

const OPERATOR = 'scott@example.org';
const MUM = 'mum@example.com';
const SLUG = 'elder.example';
const MEMBERS = [
    { email: MUM, role: ROLE.owner },
    { email: 'gran@example.com', role: ROLE.reader }
];

const ENV = { OPERATOR_EMAILS: OPERATOR };
const silent = { info() {}, warn() {}, error() {} };
const at = (when) => () => new Date(when);

const signedIn = (email) =>
    email
        ? Buffer.from(JSON.stringify({ userDetails: email, identityProvider: 'google' })).toString(
              'base64'
          )
        : null;

const asking = (email, url = 'https://example.org/api/manage/deletions') => ({
    method: 'GET',
    url,
    headers: { get: (name) => (name === 'x-ms-client-principal' ? signedIn(email) : null) }
});

describe('who gets through the operator gate', () => {
    test('an operator does', async () => {
        const gated = operatorGate({ request: asking(OPERATOR), log: silent, env: ENV });

        assert.equal(gated.denied, undefined);
        assert.equal(gated.principal.email, OPERATOR);
    });

    test('an owner of an actual archive does not', async () => {
        // Owning an archive is authority over that archive. It is not
        // authority over the list of everybody else's deletions.
        assert.equal(operatorGate({ request: asking(MUM), log: silent, env: ENV }).denied.status, 404);
    });

    test('a stranger gets 404, not 403', async () => {
        // 403 would confirm the route exists. There is no reason to tell
        // somebody poking at /api/manage/ anything at all.
        const gated = operatorGate({ request: asking('nobody@example.com'), log: silent, env: ENV });

        assert.equal(gated.denied.status, 404);
    });

    test('and nobody at all gets 401', async () => {
        assert.equal(operatorGate({ request: asking(null), log: silent, env: ENV }).denied.status, 401);
    });

    test('with the list unset, not even the usual operator', async () => {
        // Unset means nobody, never everybody. A misconfiguration that opened
        // every archive to every signed-in visitor is not a failure this is
        // willing to have.
        assert.equal(operatorGate({ request: asking(OPERATOR), log: silent, env: {} }).denied.status, 404);
    });
});

describe('every operator call is written down', () => {
    test('including the ones that only read', async () => {
        // Reading the list of deleted archives is a privilege, and a
        // write-only trail would miss it entirely.
        const warnings = [];
        operatorGate({
            request: asking(OPERATOR),
            log: { warn: (message, detail) => warnings.push([message, detail]) },
            env: ENV
        });

        assert.equal(warnings.length, 1);
        const [message, detail] = warnings[0];
        assert.equal(message, 'OperatorAction');
        assert.equal(detail.actor, OPERATOR);
        assert.equal(detail.route, '/api/manage/deletions');
    });

    test('and a refusal is not, because nothing happened', async () => {
        const warnings = [];
        operatorGate({
            request: asking(MUM),
            log: { warn: (...args) => warnings.push(args) },
            env: ENV
        });

        assert.deepEqual(warnings, []);
    });
});

describe('the list an operator is shown', () => {
    const world = async () => {
        const store = memoryStore();
        for (const slug of ['a.one', 'b.two']) store.acl(slug, MEMBERS);
        await deleteSite({
            store,
            tables: store,
            slug: 'b.two',
            by: MUM,
            reason: 'wrong archive',
            now: at('2026-08-10T09:00:00Z'),
            log: silent
        });
        await deleteSite({
            store,
            tables: store,
            slug: 'a.one',
            by: MUM,
            now: at('2026-08-08T09:00:00Z'),
            log: silent
        });
        return store;
    };

    test('is what is still recoverable, soonest to expire first', async () => {
        // The order is the useful one: the top of the list is what runs out
        // first, which is the only thing on it that is urgent.
        const store = await world();

        const pending = await pendingDeletions({ tables: store });

        assert.deepEqual(
            pending.map((row) => row.slug),
            ['a.one', 'b.two']
        );
    });

    test('and says who did it, when, and why', async () => {
        const store = await world();

        const [, second] = await pendingDeletions({ tables: store });

        assert.equal(second.deletedBy, MUM);
        assert.equal(second.deletedAt, '2026-08-10T09:00:00.000Z');
        assert.equal(second.reason, 'wrong archive');
        assert.equal(second.purgeAfter, '2026-09-09T09:00:00.000Z');
    });

    test('and is empty when nothing is deleted, which is most of the time', async () => {
        assert.deepEqual(await pendingDeletions({ tables: memoryStore() }), []);
    });
});

describe('putting an archive back', () => {
    const deleted = async () => {
        const store = memoryStore();
        store.acl(SLUG, MEMBERS);
        await deleteSite({ store, tables: store, slug: SLUG, by: MUM, now: at('2026-08-08T09:00:00Z'), log: silent });
        return store;
    };

    const restore = (store) =>
        restoreSite({ store, tables: store, slug: SLUG, by: OPERATOR, log: silent });

    test('the archive resolves again', async () => {
        const store = await deleted();

        const result = await restore(store);

        assert.equal(result.members, 2);
        assert.deepEqual(await readAcl(store, SLUG), MEMBERS);
    });

    test('with everybody who could read it before, and their roles', async () => {
        // The whole member list, not just the owner who deleted it. A restore
        // that quietly dropped the readers would look like it worked and would
        // lock a grandmother out.
        const store = await deleted();

        await restore(store);

        const rows = await store.listEntities(TABLES.memberships);
        assert.deepEqual(
            rows.map((row) => [row.partitionKey, row.rowKey]).sort(),
            [
                ['gran@example.com', SLUG],
                [MUM, SLUG]
            ].sort()
        );
    });

    test('and the appointment with the eraser is canceled', async () => {
        // Not cancelling it would restore the archive and destroy it anyway on
        // day thirty, which is the worst of both.
        const store = await deleted();

        await restore(store);

        assert.equal(await store.getEntity(TABLES.deletions, SLUG, 'record'), null);
    });

    test('twice is refused rather than doubled', async () => {
        const store = await deleted();
        await restore(store);

        assert.equal((await restore(store)).error, 'not deleted');
    });

    test('an archive that was never deleted is refused', async () => {
        const store = memoryStore();
        store.acl(SLUG, MEMBERS);

        assert.equal((await restore(store)).error, 'not deleted');
    });
});

describe('the slug somebody else has taken', () => {
    // Deletion does not reserve the name. A forward can start a fresh pending
    // site under it and a different family can claim that, which makes a
    // restore an act against strangers.
    test('is refused, loudly', async () => {
        const store = memoryStore();
        store.acl(SLUG, MEMBERS);
        await deleteSite({ store, tables: store, slug: SLUG, by: MUM, now: at('2026-08-08T09:00:00Z'), log: silent });
        store.acl(SLUG, [{ email: 'newfamily@example.com', role: ROLE.owner }]);

        const errors = [];
        const result = await restoreSite({
            store,
            tables: store,
            slug: SLUG,
            by: OPERATOR,
            log: { warn() {}, error: (...args) => errors.push(args) }
        });

        assert.equal(result.error, 'slug in use');
        assert.equal(errors.length, 1);
    });

    test('and the family standing there keeps their access', async () => {
        const store = memoryStore();
        store.acl(SLUG, MEMBERS);
        await deleteSite({ store, tables: store, slug: SLUG, by: MUM, now: at('2026-08-08T09:00:00Z'), log: silent });
        const newcomers = [{ email: 'newfamily@example.com', role: ROLE.owner }];
        store.acl(SLUG, newcomers);

        await restoreSite({ store, tables: store, slug: SLUG, by: OPERATOR, log: silent });

        assert.deepEqual(await readAcl(store, SLUG), newcomers);
    });
});

// The arrivals half of the same page. What it reports is tested next door in
// flow.test.js; what is checked here is that it is behind the same door as
// everything else under `/manage`, which is the only property it shares with
// the deletions routes and the only one that could quietly stop being true.
describe('the service-wide arrivals route', () => {
    // The handler reaches for `process.env` through `operatorGate`, which
    // deliberately threads no environment through -- there is no per-request
    // operator list, and an argument for one would be an invitation to pass
    // the wrong one.
    const withSetting = async (value, body) => {
        const before = process.env.OPERATOR_EMAILS;
        process.env.OPERATOR_EMAILS = value;
        try {
            return await body();
        } finally {
            if (before === undefined) delete process.env.OPERATOR_EMAILS;
            else process.env.OPERATOR_EMAILS = before;
        }
    };

    const ask = (email, store) =>
        withSetting(OPERATOR, () =>
            received(
                asking(email, 'https://example.org/api/manage/last-received'),
                silent,
                store,
                store
            )
        );

    test('answers an operator with every archive there is', async () => {
        const store = memoryStore();
        await touchSiteActivity({
            tables: store,
            slug: SLUG,
            lastPostAt: '2026-08-18T09:00:00.000Z',
            receivedAt: '2026-08-19T09:00:00.000Z'
        });

        const response = await ask(OPERATOR, store);

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.lastReceivedAt, '2026-08-19T09:00:00.000Z');
        assert.deepEqual(
            response.jsonBody.archives.map((row) => row.slug),
            [SLUG]
        );
    });

    test('and refuses an owner of a real archive with the same 404 as a stranger', async () => {
        // Owning an archive is authority over that archive. This route is
        // about every archive at once, which is why it can never be
        // owner-facing.
        const store = memoryStore();

        assert.equal((await ask(MUM, store)).status, 404);
        assert.equal((await ask('nobody@example.com', store)).status, 404);
    });

    test('and nobody at all gets 401', async () => {
        assert.equal((await ask(null, memoryStore())).status, 401);
    });

    test('and it is never cached, because a stale monitoring page is a lie', async () => {
        const response = await ask(OPERATOR, memoryStore());

        assert.match(response.headers['Cache-Control'], /no-store/);
    });
});
