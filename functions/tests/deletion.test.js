// Deleting an archive, and taking it back.
//
// The property most of this file is really about: after `deleteSite`, every
// existing authorization path in the service refuses every member, without any
// of those paths knowing that deletion exists. So the tests reach through the
// real gates rather than asserting on the deletion module's own return value.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import { deleteSite, restoreSite, pendingDeletions, PURGE_DAYS } from '../src/lib/deletion.js';
import { resolveAccess, resolveRole, readAcl, ROLE } from '../src/lib/acl.js';
import { membershipsFor, recordMembership } from '../src/lib/memberships.js';
import { gate } from '../src/lib/api.js';
import { TABLES } from '../src/lib/tables.js';

const SLUG = 'elder.example';
const MUM = 'mum@example.com';
const GRAN = 'gran@example.com';
const OPERATOR = 'ops@pdayletters.com';
const env = { OPERATOR_EMAILS: OPERATOR };

const NOW = () => new Date('2026-08-08T09:00:00Z');
const silent = { info() {}, warn() {}, error() {} };

const MEMBERS = [
    { email: MUM, role: ROLE.owner },
    { email: GRAN, role: ROLE.reader }
];

async function seeded({ members = MEMBERS } = {}) {
    const store = memoryStore();
    store.acl(SLUG, members);
    store.blobs.set(`rendered/${SLUG}/posts.json`, {
        bytes: Buffer.from('[]'),
        etag: 'e2'
    });
    for (const member of members) {
        await recordMembership({ tables: store, email: member.email, slug: SLUG, role: member.role });
    }
    return store;
}

const remove = (store, extra = {}) =>
    deleteSite({ store, tables: store, slug: SLUG, by: MUM, now: NOW, log: silent, ...extra });

const restore = (store, extra = {}) =>
    restoreSite({ store, tables: store, slug: SLUG, by: OPERATOR, now: NOW, log: silent, ...extra });

const header = (email) =>
    Buffer.from(JSON.stringify({ userDetails: email, identityProvider: 'aad' })).toString('base64');

const request = (email) => ({
    headers: { get: (name) => (name === 'x-ms-client-principal' ? header(email) : null) },
    params: { slug: SLUG }
});

describe('what stops working immediately', () => {
    test('the owner who pressed the button', async () => {
        const store = await seeded();
        await remove(store);

        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: MUM } }), null);
    });

    test('and every reader, without any of them being told', async () => {
        const store = await seeded();
        await remove(store);

        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: GRAN } }), null);
    });

    test('the content API answers 404, not a special deleted status', async () => {
        // Indistinguishable from an archive that never existed, which is what
        // the service already promises a signed-in stranger.
        const store = await seeded();
        await remove(store);

        const result = await gate({ store, request: request(GRAN), log: silent });
        assert.equal(result.denied.status, 404);
    });

    test('it leaves the root list and the switcher', async () => {
        const store = await seeded();
        assert.equal((await membershipsFor({ tables: store, email: GRAN })).length, 1);

        await remove(store);

        assert.deepEqual(await membershipsFor({ tables: store, email: GRAN }), []);
    });

    test('nothing is queued to be sent to anybody', async () => {
        // Being told you have been cut out of a family's archive is a message
        // the family should get to write themselves.
        const store = await seeded();
        await remove(store);

        assert.deepEqual([...store.queues.keys()], []);
    });
});

describe('what is deliberately still there', () => {
    test('the letters, all of them', async () => {
        // The whole point of the thirty days. Immediate to everyone, permanent
        // later -- and the second half is the purge timer's job, not this
        // module's.
        const store = await seeded();
        await remove(store);

        assert.ok(store.blobs.has(`rendered/${SLUG}/posts.json`));
    });

    test('an operator can still read them', async () => {
        // Not a special case for deletion. Operator authority resolves above
        // the ACL and never consulted it, so the access the restore path needs
        // was already there.
        const store = await seeded();
        await remove(store);

        assert.deepEqual(await resolveAccess({ store, slug: SLUG, principal: { email: OPERATOR }, env }), {
            role: ROLE.owner,
            viaOperator: true
        });
    });

    test('and the member list, kept where the purge will find it', async () => {
        const store = await seeded();
        await remove(store);

        assert.deepEqual(store.json('config', `${SLUG}/deleted-acl.json`), {
            slug: SLUG,
            members: MEMBERS
        });
    });

    test('kept verbatim, not re-rendered from the members alone', async () => {
        // readAcl returns only the members array, so building the copy from
        // its output drops everything else acl.json carries -- `slug` today,
        // and whatever gets added to the file later. A restore that silently
        // rewrites the one file the whole service authorizes against is the
        // format drift memory-store.js was taught to catch.
        const store = await seeded();
        const before = store.blobs.get(`config/${SLUG}/acl.json`).bytes;

        await remove(store);

        assert.deepEqual(store.blobs.get(`config/${SLUG}/deleted-acl.json`).bytes, before);
    });
});

describe('the record left for the timer', () => {
    test('says when it becomes permanent', async () => {
        const store = await seeded();
        const result = await remove(store);

        assert.equal(result.purgeAfter, '2026-09-07T09:00:00.000Z');
        assert.equal(PURGE_DAYS, 30);
    });

    test('says who did it and why', async () => {
        const store = await seeded();
        await remove(store, { by: OPERATOR, reason: 'abuse report #14' });

        const [row] = await pendingDeletions({ tables: store });
        assert.equal(row.slug, SLUG);
        assert.equal(row.deletedBy, OPERATOR);
        assert.equal(row.reason, 'abuse report #14');
    });

    test('an owner owes no reason', async () => {
        const store = await seeded();
        await remove(store);

        assert.equal((await pendingDeletions({ tables: store }))[0].reason, '');
    });

    test('soonest first, so the timer reads in the order it acts', async () => {
        const store = await seeded();
        store.acl('other.example', MEMBERS);
        await deleteSite({
            store,
            tables: store,
            slug: 'other.example',
            by: MUM,
            now: () => new Date('2026-08-01T09:00:00Z'),
            log: silent
        });
        await remove(store);

        assert.deepEqual(
            (await pendingDeletions({ tables: store })).map((row) => row.slug),
            ['other.example', SLUG]
        );
    });

    test('an archive that was never there is refused, and records nothing', async () => {
        const store = memoryStore();

        assert.deepEqual(await remove(store), { error: 'no such site' });
        assert.deepEqual(await pendingDeletions({ tables: store }), []);
    });
});

describe('restoring it', () => {
    test('gives every member back exactly what they had', async () => {
        const store = await seeded();
        await remove(store);
        await restore(store);

        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: MUM } }), ROLE.owner);
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: GRAN } }), ROLE.reader);
    });

    test('puts back the same bytes that were taken away', async () => {
        const store = await seeded();
        const before = store.blobs.get(`config/${SLUG}/acl.json`).bytes;

        await remove(store);
        await restore(store);

        assert.deepEqual(store.blobs.get(`config/${SLUG}/acl.json`).bytes, before);
    });

    test('and puts it back on their lists', async () => {
        const store = await seeded();
        await remove(store);
        await restore(store);

        const mine = await membershipsFor({ tables: store, email: GRAN });
        assert.equal(mine.length, 1);
        assert.equal(mine[0].role, ROLE.reader);
    });

    test('the rows are rebuilt from the ACL, not replayed from a second record', async () => {
        // memberships.js is emphatic that the ACL is the authority and the
        // rows are derived. Restoring through the same repair path drift
        // recovery uses is what keeps that true.
        const store = await seeded();
        await remove(store);
        await store.upsertEntity(TABLES.memberships, {
            partitionKey: 'stranger@example.com',
            rowKey: SLUG,
            role: ROLE.owner
        });

        await restore(store);

        assert.deepEqual(await membershipsFor({ tables: store, email: 'stranger@example.com' }), []);
    });

    test('clears the record, so the timer stops looking', async () => {
        const store = await seeded();
        await remove(store);
        await restore(store);

        assert.deepEqual(await pendingDeletions({ tables: store }), []);
    });

    test('and takes the copy of the member list away with it', async () => {
        const store = await seeded();
        await remove(store);
        await restore(store);

        assert.equal(store.blobs.has(`config/${SLUG}/deleted-acl.json`), false);
    });

    test('an archive that was not deleted cannot be restored', async () => {
        const store = await seeded();

        assert.deepEqual(await restore(store), { error: 'not deleted' });
        assert.deepEqual(await readAcl(store, SLUG), MEMBERS);
    });

    test('refuses when somebody else has started using the slug', async () => {
        // The letters were deleted, the name was not reserved, and a forward
        // has since started a fresh archive under it. Writing a dead family's
        // member list over a live one would hand strangers a stranger's mail.
        const store = await seeded();
        await remove(store);
        store.acl(SLUG, [{ email: 'newfamily@example.com', role: ROLE.owner }]);

        assert.deepEqual(await restore(store), { error: 'slug in use' });
    });

    test('and leaves the new occupants untouched when it refuses', async () => {
        const store = await seeded();
        await remove(store);
        store.acl(SLUG, [{ email: 'newfamily@example.com', role: ROLE.owner }]);

        await restore(store);

        assert.deepEqual(await readAcl(store, SLUG), [
            { email: 'newfamily@example.com', role: ROLE.owner }
        ]);
    });
});
