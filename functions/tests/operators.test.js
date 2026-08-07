// The service-wide operator role.
//
// This is the standing exception to the promise the rest of the service is
// built around, so most of what is asserted here is about the exception being
// narrow, visible, and impossible to grant from inside the product.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { operatorEmails, isOperator } from '../src/lib/operators.js';
import { resolveAccess, resolveRole, ROLE } from '../src/lib/acl.js';
import { memoryStore } from './memory-store.js';

const SLUG = 'elder.example';
const OPERATOR = 'ops@pdayletters.com';
const env = { OPERATOR_EMAILS: OPERATOR };

const who = (email) => ({ email });
const access = (store, email, environment = env) =>
    resolveAccess({ store, slug: SLUG, principal: who(email), env: environment });

describe('reading the setting', () => {
    test('accepts the separators a human actually types', async () => {
        const parsed = operatorEmails({ OPERATOR_EMAILS: 'a@x.com, b@x.com;c@x.com  d@x.com' });
        assert.deepEqual([...parsed].sort(), ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']);
    });

    test('is case-insensitive on both sides', async () => {
        assert.equal(isOperator('OPS@X.com', { OPERATOR_EMAILS: 'ops@x.COM' }), true);
    });

    test('unset means nobody, never everybody', async () => {
        // The default in every environment but production, and the direction a
        // misconfiguration has to fail in.
        assert.equal(isOperator('anyone@example.com', {}), false);
        assert.equal(isOperator('anyone@example.com', { OPERATOR_EMAILS: '' }), false);
        assert.equal(isOperator('anyone@example.com', { OPERATOR_EMAILS: '   ' }), false);
    });

    test('an empty address is not an operator', async () => {
        assert.equal(isOperator('', { OPERATOR_EMAILS: 'ops@x.com' }), false);
        assert.equal(isOperator(null, { OPERATOR_EMAILS: 'ops@x.com' }), false);
        assert.equal(isOperator(undefined, { OPERATOR_EMAILS: '' }), false);
    });
});

describe('what an operator can reach', () => {
    test('an archive they have never been added to', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'mum@example.com', role: ROLE.owner }]);

        assert.deepEqual(await access(store, OPERATOR), { role: ROLE.owner, viaOperator: true });
    });

    test('an archive that has no ACL at all', async () => {
        // A pending site renders nothing and has no ACL, and inspecting one
        // before its window lapses is the only disposal route for a site that
        // spam created.
        const store = memoryStore();

        assert.deepEqual(await access(store, OPERATOR), { role: ROLE.owner, viaOperator: true });
    });

    test('and is an owner, not a reader', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'mum@example.com', role: ROLE.owner }]);

        assert.equal(await resolveRole({ store, slug: SLUG, principal: who(OPERATOR), env }), ROLE.owner);
    });
});

describe('what is unchanged for everybody else', () => {
    test('a stranger is still nobody', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'mum@example.com', role: ROLE.owner }]);

        assert.deepEqual(await access(store, 'stranger@example.com'), {
            role: null,
            viaOperator: false
        });
    });

    test('an owner is still an owner, and not flagged', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'mum@example.com', role: ROLE.owner }]);

        assert.deepEqual(await access(store, 'mum@example.com'), {
            role: ROLE.owner,
            viaOperator: false
        });
    });

    test('a reader is still a reader', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'gran@example.com', role: ROLE.reader }]);

        assert.deepEqual(await access(store, 'gran@example.com'), {
            role: ROLE.reader,
            viaOperator: false
        });
    });

    test('a typo in a role is still refused rather than read as reader', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'gran@example.com', role: 'redaer' }]);

        assert.equal((await access(store, 'gran@example.com')).role, null);
    });

    test('with the setting unset, nothing about the ACL changes', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'mum@example.com', role: ROLE.owner }]);

        assert.equal((await access(store, OPERATOR, {})).role, null);
        assert.equal((await access(store, 'mum@example.com', {})).role, ROLE.owner);
    });
});

describe('when the operator also belongs to the archive', () => {
    test('being an owner there is theirs by the ACL, and is not flagged', async () => {
        // Their own family's archive. A banner here would be noise, and worse
        // than noise: a warning that fires when nothing is wrong is one people
        // learn to stop reading.
        const store = memoryStore();
        store.acl(SLUG, [{ email: OPERATOR, role: ROLE.owner }]);

        assert.deepEqual(await access(store, OPERATOR), { role: ROLE.owner, viaOperator: false });
    });

    test('being only a reader there still yields owner, and is flagged', async () => {
        // The owner powers came from the setting rather than from the family's
        // list, so this is the one case where saying otherwise would let
        // operator authority go unannounced.
        const store = memoryStore();
        store.acl(SLUG, [{ email: OPERATOR, role: ROLE.reader }]);

        assert.deepEqual(await access(store, OPERATOR), { role: ROLE.owner, viaOperator: true });
    });
});

describe('what being an operator does not do', () => {
    test('it writes nothing to the ACL', async () => {
        // The whole design rests on this: operators never appear in an owner's
        // People list, never populate the switcher or the root archive list,
        // and removing one is a single config change rather than a fan-out
        // write across every archive in the service.
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'mum@example.com', role: ROLE.owner }]);
        const before = JSON.stringify(store.json('config', `${SLUG}/acl.json`));

        await access(store, OPERATOR);

        assert.equal(JSON.stringify(store.json('config', `${SLUG}/acl.json`)), before);
    });

    test('it writes nothing to memberships', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'mum@example.com', role: ROLE.owner }]);

        await access(store, OPERATOR);

        assert.deepEqual(await store.listEntities('memberships', { partitionKey: OPERATOR }), []);
    });

    test('an unsigned-in caller is nobody, operator setting or not', async () => {
        const store = memoryStore();

        assert.deepEqual(await resolveAccess({ store, slug: SLUG, principal: null, env }), {
            role: null,
            viaOperator: false
        });
    });
});
