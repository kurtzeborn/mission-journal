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
import {
    publish,
    progress,
    deliver,
    review,
    cover,
    chooseTheCover,
    putCoverPicture
} from '../src/functions/book.js';
import { holdPending } from '../src/lib/pending.js';
import { attachClaimToken } from '../src/lib/claim.js';
import { deliveryKey, recordDelivery } from '../src/lib/delivery.js';
import { TABLES } from '../src/lib/tables.js';

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

function request({ principal = null, body = {}, params = {}, bytes = null, type = null } = {}) {
    const headers = principal ? { 'x-ms-client-principal': principalHeader(principal) } : {};
    if (type) headers['content-type'] = type;

    return {
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        params,
        json: async () => body,
        arrayBuffer: async () => (bytes ?? Buffer.alloc(0))
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

    test('asking which archives are mine clears the mark against my address', async () => {
        // The nearest thing this API has to a sign-in. Nothing that records a
        // delivery outcome recurs, so without a hook here a bounce is shown to
        // an owner for years after the person it names started signing in.
        const store = memoryStore();
        await recordDelivery({ tables: store, email: 'parent@example.com', status: 'failed', log: silent });

        await memberships({
            request: request({ principal: { userDetails: 'Parent@Example.COM' } }),
            tables: store
        });

        assert.equal(await store.getEntity(TABLES.deliveries, 'delivery', deliveryKey('parent@example.com')), null);
    });
});

describe('the book handlers', () => {
    const OWNER = 'mum@example.com';
    const READER = 'gran@example.com';

    const printable = () => {
        const store = memoryStore();
        store.acl(SLUG, [
            { email: OWNER, role: 'owner' },
            { email: READER, role: 'reader' }
        ]);
        store.blobs.set(`config/${SLUG}/profile.json`, {
            bytes: Buffer.from(JSON.stringify({ slug: SLUG, displayName: 'Elder Example' }), 'utf8'),
            metadata: {},
            etag: 'etag-profile'
        });
        return store;
    };

    const asOwner = (extra = {}) =>
        request({ principal: { userDetails: OWNER }, params: { slug: SLUG }, ...extra });

    test('an owner is handed a build to watch', async () => {
        const store = printable();
        const response = await publish({ request: asOwner(), context: silent, store });

        assert.equal(response.status, 202);
        assert.equal(response.jsonBody.state, 'building');
        assert.equal(store.queues.get('book').length, 1);
    });

    test('a reader cannot commit the family to a printed object', async () => {
        const store = printable();
        const response = await publish({
            request: request({ principal: { userDetails: READER }, params: { slug: SLUG } }),
            context: silent,
            store
        });

        assert.equal(response.status, 403);
        assert.equal(store.queues.get('book'), undefined);
    });

    test('a stranger is not told whether the site exists', async () => {
        const store = printable();
        const response = await publish({
            request: request({ principal: { userDetails: 'nobody@example.com' }, params: { slug: SLUG } }),
            context: silent,
            store
        });

        assert.equal(response.status, 404);
    });

    test('the status of a build says nothing about who asked for it', async () => {
        const store = printable();
        await publish({ request: asOwner(), context: silent, store });

        const response = await progress({ request: asOwner(), context: silent, store });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.state, 'building');
        assert.equal('requestedBy' in response.jsonBody, false);
    });

    test('a site nobody has published yet says so rather than failing', async () => {
        const response = await progress({ request: asOwner(), context: silent, store: printable() });

        assert.equal(response.status, 404);
    });

    test('a build says whether there is a printer to order it from', async () => {
        const store = printable();
        await publish({ request: asOwner(), context: silent, store });

        const was = process.env.PEECHO_API_KEY;
        try {
            delete process.env.PEECHO_API_KEY;
            const off = await progress({ request: asOwner(), context: silent, store });
            assert.equal(off.jsonBody.printing, false);

            process.env.PEECHO_API_KEY = 'a-key';
            const on = await progress({ request: asOwner(), context: silent, store });
            assert.equal(on.jsonBody.printing, true);
        } finally {
            if (was === undefined) delete process.env.PEECHO_API_KEY;
            else process.env.PEECHO_API_KEY = was;
        }
    });

    test('an unfinished book cannot be fetched in either form', async () => {
        const store = printable();
        await publish({ request: asOwner(), context: silent, store });

        // The fake refuses to sign a link to a blob that is not there, so
        // reaching for one at all would throw rather than return a status --
        // which is the assertion underneath this one: a building book must be
        // refused before that point.
        const print = await deliver({ request: asOwner(), context: silent, store });
        const proof = await review({ request: asOwner(), context: silent, store });

        assert.equal(print.status, 404);
        assert.equal(proof.status, 404);
    });

    test('an owner is offered a palette and told what the cover says', async () => {
        const response = await cover({ request: asOwner(), context: silent, store: printable() });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.title, 'Elder Example');
        assert.equal(response.jsonBody.mission, '');
        assert.ok(response.jsonBody.cloth);
        // The hexes come down the wire so the page and the PDF cannot end up
        // with two different ideas of what navy is.
        assert.ok(response.jsonBody.cloths.every((entry) => entry.name && entry.paper));
    });

    test('a color is saved without disturbing the name', async () => {
        const store = printable();

        const saved = await chooseTheCover({
            request: asOwner({ body: { cloth: 'navy', picture: '' } }),
            context: silent,
            store
        });

        assert.equal(saved.status, 200);

        const read = await cover({ request: asOwner(), context: silent, store });
        assert.equal(read.jsonBody.cloth, 'navy');
        assert.equal(read.jsonBody.title, 'Elder Example');
    });

    test('a color nobody offered is refused', async () => {
        const response = await chooseTheCover({
            request: asOwner({ body: { cloth: 'rebeccapurple', picture: '' } }),
            context: silent,
            store: printable()
        });

        assert.equal(response.status, 400);
    });

    test('a reader cannot choose how the family\u2019s book is bound', async () => {
        const response = await chooseTheCover({
            request: request({
                principal: { userDetails: READER },
                params: { slug: SLUG },
                body: { cloth: 'navy', picture: '' }
            }),
            context: silent,
            store: printable()
        });

        assert.equal(response.status, 403);
    });

    test('a cover upload that is not a picture is refused before it is decoded', async () => {
        const response = await putCoverPicture({
            request: asOwner({ type: 'application/pdf', bytes: Buffer.from('%PDF-') }),
            context: silent,
            store: printable()
        });

        assert.equal(response.status, 415);
    });
});
