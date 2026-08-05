// The seam between a handler and the libraries it calls.
//
// Everything below the handlers is well covered, and that is exactly why this
// file exists. `readPrincipal` had a test proving it returns `{ email, ... }`.
// `redeemClaim` had a test proving it refuses a caller with no email. The line
// joining them asked for `principal.userDetails` -- a field name that belongs
// to the raw Static Web Apps header and not to the object in front of it -- so
// every claim in production was refused, and all 257 tests passed.
//
// Nothing here touches the network, a clock, a port, or Azure. The handlers
// take their store as an argument, so a fake goes in and the assertions are
// about status codes and stored bytes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import { redeem, describe as describeClaimHandler } from '../src/functions/claim.js';
import { memberships } from '../src/functions/memberships.js';
import { holdPending } from '../src/lib/pending.js';
import { attachClaimToken } from '../src/lib/claim.js';

const KEY = 'a-signing-key-from-key-vault';
const SLUG = 'elder.example';
const NOW = () => new Date('2026-08-03T12:00:00Z');

const silent = { info() {}, warn() {}, error() {}, log() {} };

// A Static Web Apps principal arrives base64-encoded on a header. Built here
// the way the platform builds it -- `userDetails` and all -- because a test
// that handed the handler an already-correct object would assert nothing about
// the field the handler actually has to read.
function principalHeader({ userDetails, identityProvider = 'aad' }) {
    return Buffer.from(
        JSON.stringify({ identityProvider, userId: 'abc123', userDetails, userRoles: [] }),
        'utf8'
    ).toString('base64');
}

function request({ principal = null, body = {} } = {}) {
    const headers = principal ? { 'x-ms-client-principal': principalHeader(principal) } : {};
    return {
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        json: async () => body
    };
}

// One held letter for a site nobody owns yet, and a token that opens it. The
// letter's bytes are not a real message on purpose: promotion is allowed to
// fail on it, and the assertions here are about who ends up owning the
// archive, not about what gets published into it.
async function readySite() {
    const store = memoryStore();
    await holdPending({
        store,
        slug: SLUG,
        ulid: '01TEST0000000000000000000',
        raw: Buffer.from('not a parseable message', 'utf8'),
        envelope: { to: 'post@pdayletters.com', from: `${SLUG}@missionary.org` },
        subject: 'Week 1',
        sender: `${SLUG}@missionary.org`,
        messageId: '<week1@missionary.org>',
        hasDirect: true,
        now: NOW,
        log: silent
    });

    const issued = await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });
    assert.equal(issued.status, 'issued', 'the fixture itself must be claimable');
    return { store, token: issued.token };
}

const aclOf = (store) => store.json('config', `${SLUG}/acl.json`);

describe('the claim redeem handler', () => {
    test('the signed-in address becomes the owner', async () => {
        const { store, token } = await readySite();

        const response = await redeem({
            request: request({ principal: { userDetails: 'Parent@Example.COM' }, body: { token } }),
            context: silent,
            store,
            tables: store,
            key: KEY
        });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.status, 'ok');

        // The whole point. If the handler reads the wrong field off the
        // principal, this is `unauthenticated` and there is no ACL at all.
        const owner = aclOf(store).members.find((m) => m.role === 'owner');
        assert.equal(owner.email, 'parent@example.com');
    });

    test('a caller with no session is refused before anything is spent', async () => {
        const { store, token } = await readySite();

        const response = await redeem({
            request: request({ body: { token } }),
            context: silent,
            store,
            tables: store,
            key: KEY
        });

        assert.equal(response.status, 401);
        assert.equal(response.jsonBody.status, 'unauthenticated');
        assert.equal(store.json('pending', `${SLUG}/claim.json`).claimedAt, null);
    });

    test('a principal carrying no address is refused as unauthenticated, not as a bad link', async () => {
        const { store, token } = await readySite();

        const response = await redeem({
            request: request({ principal: { userDetails: '' }, body: { token } }),
            context: silent,
            store,
            tables: store,
            key: KEY
        });

        // 401 rather than 409. The claim page redirects on 401 and shows "this
        // link cannot be used" on anything it has no copy for, so a session
        // problem reported as a 409 tells the claimant their link is broken.
        assert.equal(response.status, 401);
    });

    test('a missing token is refused without consulting the store', async () => {
        const response = await redeem({
            request: request({ principal: { userDetails: 'parent@example.com' } }),
            context: silent,
            store: null,
            tables: null,
            key: KEY
        });

        assert.equal(response.status, 400);
        assert.equal(response.jsonBody.status, 'invalid');
    });

    test('an unconfigured signing key refuses rather than trusting the token', async () => {
        const { store, token } = await readySite();

        const response = await redeem({
            request: request({ principal: { userDetails: 'parent@example.com' }, body: { token } }),
            context: silent,
            store,
            tables: store,
            key: null
        });

        assert.equal(response.status, 503);
        assert.equal(response.jsonBody.status, 'unavailable');
    });
});

describe('the claim describe handler', () => {
    test('an anonymous caller can read a pending site', async () => {
        const { store, token } = await readySite();

        const response = await describeClaimHandler({
            request: request({ body: { token } }),
            context: silent,
            store,
            key: KEY
        });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.status, 'ready');
        assert.equal(response.jsonBody.sender, `${SLUG}@missionary.org`);
    });

    test('a bad token still answers 200, so a scanner learns nothing from the code', async () => {
        const { store } = await readySite();

        const response = await describeClaimHandler({
            request: request({ body: { token: 'not-a-token' } }),
            context: silent,
            store,
            key: KEY
        });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.status, 'invalid');
    });
});

describe('the memberships handler', () => {
    test('an owner is told about the site they just claimed', async () => {
        const { store, token } = await readySite();

        await redeem({
            request: request({ principal: { userDetails: 'Parent@Example.COM' }, body: { token } }),
            context: silent,
            store,
            tables: store,
            key: KEY
        });

        const response = await memberships({
            request: request({ principal: { userDetails: 'Parent@Example.COM' } }),
            tables: store
        });

        assert.equal(response.status, 200);

        // The silent half of the same bug: reading the wrong field here returns
        // an empty list, and an owner is shown a home page saying they have no
        // archives rather than an error saying anything went wrong.
        assert.deepEqual(
            response.jsonBody.memberships.map((m) => m.slug),
            [SLUG]
        );
    });

    test('a caller with no session is refused', async () => {
        const store = memoryStore();
        const response = await memberships({ request: request(), tables: store });

        assert.equal(response.status, 401);
    });
});
