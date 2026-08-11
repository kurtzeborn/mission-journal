// The `DELETE /api/site/{slug}` endpoint.
//
// The lib is tested next door in deletion.test.js. What is checked here is
// everything between the wire and it: who is refused, and the typed
// confirmation -- which is the one part of this design that has to be enforced
// twice, because a check living only in the browser is one a retried fetch
// never has to pass.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { remove } from '../src/functions/site.js';
import { memoryStore } from './memory-store.js';
import { readAcl, ROLE } from '../src/lib/acl.js';
import { pendingDeletions } from '../src/lib/deletion.js';
import { recordMembership } from '../src/lib/memberships.js';

const SLUG = 'elder.example';
const MUM = 'mum@example.com';
const GRAN = 'gran@example.com';

const MEMBERS = [
    { email: MUM, role: ROLE.owner },
    { email: GRAN, role: ROLE.reader }
];

const silent = { log() {}, info() {}, warn() {}, error() {} };

const header = (email) =>
    Buffer.from(JSON.stringify({ userDetails: email, identityProvider: 'aad' })).toString('base64');

const request = ({ as, body = {}, slug = SLUG, broken = false }) => ({
    headers: { get: (name) => (name === 'x-ms-client-principal' ? (as ? header(as) : null) : null) },
    params: { slug },
    method: 'DELETE',
    url: `https://pdayletters.com/api/site/${slug}`,
    json: async () => {
        if (broken) throw new Error('not json');
        return body;
    }
});

async function seeded() {
    const store = memoryStore();
    store.acl(SLUG, MEMBERS);
    for (const member of MEMBERS) {
        await recordMembership({ tables: store, email: member.email, slug: SLUG, role: member.role });
    }
    return store;
}

const call = (store, options) =>
    remove({ request: request(options), context: silent, store, tables: store });

describe('who may delete an archive', () => {
    test('an owner, having typed the name', async () => {
        const store = await seeded();

        const response = await call(store, { as: MUM, body: { confirm: SLUG } });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.members, 2);
        assert.equal(await readAcl(store, SLUG), null);
    });

    test('a reader gets 403, and the archive survives', async () => {
        // Not 404. A reader already knows this archive exists, so the honest
        // answer discloses nothing and saves them hunting for a broken link.
        const store = await seeded();

        const response = await call(store, { as: GRAN, body: { confirm: SLUG } });

        assert.equal(response.status, 403);
        assert.deepEqual(await readAcl(store, SLUG), MEMBERS);
    });

    test('a signed-in stranger gets 404, as everywhere else', async () => {
        const store = await seeded();

        const response = await call(store, { as: 'stranger@example.com', body: { confirm: SLUG } });

        assert.equal(response.status, 404);
        assert.deepEqual(await readAcl(store, SLUG), MEMBERS);
    });

    test('nobody at all gets 401', async () => {
        const store = await seeded();

        const response = await call(store, { body: { confirm: SLUG } });

        assert.equal(response.status, 401);
        assert.deepEqual(await readAcl(store, SLUG), MEMBERS);
    });

    test('a traversal slug never reaches a blob path', async () => {
        const store = await seeded();

        const response = await call(store, {
            as: MUM,
            slug: '../config/other',
            body: { confirm: '../config/other' }
        });

        assert.equal(response.status, 404);
        assert.deepEqual(await readAcl(store, SLUG), MEMBERS);
    });
});

describe('the confirmation, checked again on the server', () => {
    const refused = async (body) => {
        const store = await seeded();
        const response = await call(store, { as: MUM, ...body });

        assert.equal(response.status, 400);
        assert.deepEqual(await readAcl(store, SLUG), MEMBERS);
        assert.deepEqual(await pendingDeletions({ tables: store }), []);
        return response;
    };

    test('an empty body deletes nothing', async () => {
        await refused({ body: {} });
    });

    test('a body that is not JSON at all deletes nothing', async () => {
        await refused({ broken: true });
    });

    test('the wrong archive name deletes nothing', async () => {
        // The case this exists for: two archives open in two tabs.
        await refused({ body: { confirm: 'other.example' } });
    });

    test('a near miss deletes nothing', async () => {
        await refused({ body: { confirm: 'elder.exampl' } });
    });

    test('and neither does the wrong case', async () => {
        await refused({ body: { confirm: 'Elder.Example' } });
    });

    test('a stray space either side is accepted', async () => {
        // Copied by hand from the prompt beside the box. A trailing space is
        // not a different intention.
        const store = await seeded();

        const response = await call(store, { as: MUM, body: { confirm: `  ${SLUG}\n` } });

        assert.equal(response.status, 200);
    });
});

describe('what is recorded', () => {
    test('who pressed it, not who owns the archive', async () => {
        const store = await seeded();
        store.acl(SLUG, [...MEMBERS, { email: 'dad@example.com', role: ROLE.owner }]);

        await call(store, { as: 'dad@example.com', body: { confirm: SLUG } });

        assert.equal((await pendingDeletions({ tables: store }))[0].deletedBy, 'dad@example.com');
    });

    test('a reason, when one was given', async () => {
        const store = await seeded();

        await call(store, { as: MUM, body: { confirm: SLUG, reason: 'abuse report #14' } });

        assert.equal((await pendingDeletions({ tables: store }))[0].reason, 'abuse report #14');
    });

    test('a pasted essay is cut rather than stored whole', async () => {
        const store = await seeded();

        await call(store, { as: MUM, body: { confirm: SLUG, reason: 'x'.repeat(5000) } });

        assert.equal((await pendingDeletions({ tables: store }))[0].reason.length, 500);
    });

    test('and the date it becomes permanent goes back to the browser', async () => {
        const store = await seeded();

        const response = await call(store, { as: MUM, body: { confirm: SLUG } });

        assert.match(response.jsonBody.purgeAfter, /^\d{4}-\d{2}-\d{2}T/);
    });
});
