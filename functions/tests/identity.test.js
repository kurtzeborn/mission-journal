// Identity tests: what happens when the address stops being the person.
//
// The interesting cases are all about *change*. An ACL that never moves is
// already covered by members.test.js; what is new here is a Gmail user who
// signs in spelled differently, a Microsoft account whose primary address is
// changed at work, and the same human arriving through both providers.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { ROLE, resolveAccess, resolveRole } from '../src/lib/acl.js';
import { identityKey } from '../src/lib/principal.js';
import { identityRow, reconcileIdentity } from '../src/lib/identity.js';
import { membershipsFor, recordMembership } from '../src/lib/memberships.js';
import { TABLES } from '../src/lib/tables.js';

const silent = { info() {}, warn() {}, error() {} };
const NOW = () => new Date('2026-08-24T12:00:00Z');
const SLUG = 'elder.example';

const OWNER = 'parent@example.com';
const READER = 'first.last@gmail.com';

const who = (email, provider = 'google', userId = 'sub-123') => ({ email, provider, userId });

const member = (email, role, extra = {}) => ({
    email,
    role,
    verifiedMissionary: false,
    addedAt: '2026-08-01T00:00:00Z',
    ...extra
});

async function site(members, slug = SLUG) {
    const store = memoryStore();
    await store.writeBlob(
        'config',
        `${slug}/acl.json`,
        Buffer.from(JSON.stringify({ slug, members }, null, 2), 'utf8'),
        { contentType: 'application/json' }
    );
    for (const m of members) {
        await recordMembership({ tables: store, email: m.email, slug, role: m.role, now: NOW });
    }
    return store;
}

const aclOf = (store, slug = SLUG) => store.json('config', `${slug}/acl.json`).members;

/** What the endpoint does: fetch the list, then reconcile against it. */
async function signIn(store, principal) {
    const sites = await membershipsFor({ tables: store, email: principal.email });
    return reconcileIdentity({ store, tables: store, principal, sites, now: NOW, log: silent });
}

// --- the key --------------------------------------------------------------

describe('naming a sign-in', () => {
    test('the provider is part of the key', () => {
        assert.equal(identityKey(who(OWNER, 'google', 'abc')), 'google:abc');
        assert.notEqual(
            identityKey(who(OWNER, 'google', 'abc')),
            identityKey(who(OWNER, 'aad', 'abc'))
        );
    });

    test('there is no key without both halves', () => {
        assert.equal(identityKey({ email: OWNER, provider: 'google' }), null);
        assert.equal(identityKey({ email: OWNER, userId: 'abc' }), null);
        assert.equal(identityKey(null), null);
    });
});

// --- binding --------------------------------------------------------------

describe('the first time somebody signs in', () => {
    test('their identity is stamped onto the archives they are already on', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);

        const result = await signIn(store, who(READER));

        assert.equal(result.status, 'bound');
        const them = aclOf(store).find((m) => m.email === READER);
        assert.equal(them.identity, 'google:sub-123');
        // Nobody else was touched.
        assert.equal(aclOf(store).find((m) => m.email === OWNER).identity, undefined);
    });

    test('signing in again writes nothing', async () => {
        const store = await site([member(READER, ROLE.reader)]);
        await signIn(store, who(READER));

        const before = JSON.stringify(aclOf(store));
        const result = await signIn(store, who(READER));

        assert.equal(result.status, 'known');
        assert.equal(JSON.stringify(aclOf(store)), before);
    });

    test('a provider that gives us no id changes nothing', async () => {
        const store = await site([member(READER, ROLE.reader)]);

        const result = await reconcileIdentity({
            store, tables: store, principal: { email: READER }, sites: [], now: NOW, log: silent
        });

        assert.equal(result.status, 'anonymous');
        assert.equal(aclOf(store)[0].identity, undefined);
        assert.equal(await store.getEntity(TABLES.identities, 'identity', identityRow('x')), null);
    });
});

// --- the address changing -------------------------------------------------

describe('when the address changes underneath a membership', () => {
    test('the ACL entry moves with them', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);
        await signIn(store, who(READER));

        const result = await signIn(store, who('firstlast@gmail.com'));

        assert.equal(result.status, 'renamed');
        assert.deepEqual(result.slugs, [SLUG]);

        const emails = aclOf(store).map((m) => m.email);
        assert.deepEqual(emails, [OWNER, 'firstlast@gmail.com']);
    });

    test('the site list moves with them too', async () => {
        const store = await site([member(READER, ROLE.reader)]);
        await signIn(store, who(READER));
        await signIn(store, who('firstlast@gmail.com'));

        assert.deepEqual(
            (await membershipsFor({ tables: store, email: 'firstlast@gmail.com' })).map((m) => m.slug),
            [SLUG]
        );
        assert.deepEqual(await membershipsFor({ tables: store, email: READER }), []);
    });

    test('they can still read the archive, which is the point', async () => {
        const store = await site([member(READER, ROLE.reader)]);
        await signIn(store, who(READER));

        const moved = who('firstlast@gmail.com');
        await signIn(store, moved);

        assert.equal(await resolveRole({ store, slug: SLUG, principal: moved, env: {} }), ROLE.reader);
    });

    test('the identity alone is enough, before anything has been reconciled', async () => {
        const store = await site([
            member(READER, ROLE.reader, { identity: 'google:sub-123' })
        ]);

        const moved = who('somewhere.else@example.com');
        assert.equal(await resolveRole({ store, slug: SLUG, principal: moved, env: {} }), ROLE.reader);
    });

    test('an owner stays an owner', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);
        await signIn(store, who(OWNER, 'aad', 'oid-1'));
        await signIn(store, who('parent@newjob.example', 'aad', 'oid-1'));

        assert.equal(aclOf(store).find((m) => m.email === 'parent@newjob.example').role, ROLE.owner);
    });

    test('every archive they belong to moves, not just the first', async () => {
        const store = await site([member(READER, ROLE.reader)]);
        await store.writeBlob(
            'config',
            'sister.other/acl.json',
            Buffer.from(JSON.stringify({ slug: 'sister.other', members: [member(READER, ROLE.owner)] }), 'utf8'),
            { contentType: 'application/json' }
        );
        await recordMembership({ tables: store, email: READER, slug: 'sister.other', role: ROLE.owner, now: NOW });

        await signIn(store, who(READER));
        const result = await signIn(store, who('firstlast@gmail.com'));

        assert.equal(result.slugs.length, 2);
        assert.equal(aclOf(store, 'sister.other')[0].email, 'firstlast@gmail.com');
    });
});

// --- merging --------------------------------------------------------------

describe('when the address they moved to is already on the list', () => {
    test('the two rows become one', async () => {
        const store = await site([
            member(OWNER, ROLE.owner),
            member(READER, ROLE.reader),
            member('firstlast@gmail.com', ROLE.reader)
        ]);
        await signIn(store, who(READER));
        await signIn(store, who('firstlast@gmail.com'));

        const rows = aclOf(store).filter((m) => m.email === 'firstlast@gmail.com');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].identity, 'google:sub-123');
    });

    test('the stronger of the two roles survives', async () => {
        const store = await site([
            member(READER, ROLE.owner),
            member('firstlast@gmail.com', ROLE.reader)
        ]);
        await signIn(store, who(READER));
        await signIn(store, who('firstlast@gmail.com'));

        assert.equal(aclOf(store)[0].role, ROLE.owner);
    });
});

// --- what must not change -------------------------------------------------

describe('what binding an identity must never take away', () => {
    test('an address on the list still works with no identity anywhere', async () => {
        const store = await site([member(READER, ROLE.reader)]);
        assert.equal(
            await resolveRole({ store, slug: SLUG, principal: who(READER), env: {} }),
            ROLE.reader
        );
    });

    test('a bound entry still answers to its address through the other provider', async () => {
        const store = await site([member(READER, ROLE.reader)]);
        await signIn(store, who(READER, 'google', 'sub-123'));

        // Same person, same mailbox, signed in with Microsoft this time: a
        // different identity entirely, and the address is what saves them.
        assert.equal(
            await resolveRole({ store, slug: SLUG, principal: who(READER, 'aad', 'oid-9'), env: {} }),
            ROLE.reader
        );
    });

    test('an operator is an operator through either provider', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const env = { OPERATOR_EMAILS: 'scott@kurtzeborn.org' };

        for (const provider of ['google', 'aad']) {
            const seen = await resolveAccess({
                store, slug: SLUG, env,
                principal: who('scott@kurtzeborn.org', provider, `id-${provider}`)
            });
            assert.equal(seen.role, ROLE.owner);
            assert.equal(seen.viaOperator, true);
        }
    });

    test('a stranger is still a stranger', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        assert.equal(
            await resolveRole({ store, slug: SLUG, principal: who('nobody@example.com'), env: {} }),
            null
        );
    });
});
