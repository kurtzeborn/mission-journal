// The last mile: what leaves here, and what is believed on the way back.
//
// Two things in this file are worth more than the rest of it. The first is
// that a webhook is authorised by arithmetic and nothing else -- there is no
// session, no header, no allowlist -- so the test that a forged signature is
// refused is the only thing standing between a stranger and our order
// records. The second is that the URL handed to the printer is the one piece
// of this service that a company outside it will fetch, unattended, years
// from now.
//
// None of it touches the network. `createPublication` takes its fetch, and
// the handlers take their store and their signing key, so a fake goes in and
// the assertions are about what was sent and what was written down.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import {
    checkoutExpiry,
    createPublication,
    orderReference,
    publicationBody,
    readReference,
    signatureMatches
} from '../src/lib/peecho.js';
import { order, placed, statusChanged, fetchForPrint } from '../src/functions/peecho.js';
import { issueClaimToken, PURPOSE } from '../src/lib/claimtoken.js';
import { createHash } from 'node:crypto';

const SLUG = 'elder.example';
const BOOK = '20260819T055521Z-dd3c9494';
const OWNER = 'mum@example.com';
const READER = 'gran@example.com';
const KEY = 'a-signing-key-from-key-vault';
const SECRET = 'a-secret-key-from-the-dashboard';

const silent = { info() {}, warn() {}, error() {}, log() {} };

// Peecho's own scheme, written out here rather than imported, so that a
// change to the implementation has to be made twice before these pass.
const theirSignature = (orderId) =>
    createHash('sha256').update(`${SECRET}${orderId}`, 'utf8').digest('hex');

function principalHeader(email) {
    return Buffer.from(
        JSON.stringify({
            identityProvider: 'aad',
            userId: 'abc123',
            userDetails: email,
            userRoles: []
        }),
        'utf8'
    ).toString('base64');
}

function request({ email = null, body = {}, params = {}, query = {} } = {}) {
    const headers = email ? { 'x-ms-client-principal': principalHeader(email) } : {};

    return {
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        params,
        query: { get: (name) => query[name] ?? null },
        json: async () => body
    };
}

// A site with owners, a name, and one finished book in it.
function withABook({ state = 'ready' } = {}) {
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
    store.blobs.set(`books/${SLUG}/${BOOK}/status.json`, {
        bytes: Buffer.from(
            JSON.stringify({ id: BOOK, slug: SLUG, state, pages: 48, letters: 12 }),
            'utf8'
        ),
        metadata: {},
        etag: 'etag-status'
    });
    store.blobs.set(`books/${SLUG}/${BOOK}/book.pdf`, {
        bytes: Buffer.from('%PDF-1.3 pretend'),
        metadata: {},
        etag: 'etag-pdf'
    });
    return store;
}

// Their 200 with secure checkout on, which is the only shape we ask for.
const answering = (payload, { ok = true, status = 200 } = {}) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return { ok, status, json: async () => payload };
    };
    return { calls, fetchImpl };
};

// The keys live in app settings, so switching printing on for a test means
// setting them and putting the environment back afterwards -- a leaked key
// here would switch it on for every test that ran after.
async function withPrinting(run) {
    const before = { ...process.env };
    process.env.PEECHO_API_KEY = 'merchant-key';
    process.env.PEECHO_BASE = 'https://test.www.peecho.com';
    process.env.PEECHO_OFFERING_ID = '4321';
    process.env.PEECHO_OFFERING_PRICE = '49.00';
    try {
        await run();
    } finally {
        for (const name of ['PEECHO_API_KEY', 'PEECHO_BASE', 'PEECHO_OFFERING_ID', 'PEECHO_OFFERING_PRICE']) {
            if (name in before) process.env[name] = before[name];
            else delete process.env[name];
        }
    }
}

const orderOf = (store) => store.json('books', `${SLUG}/${BOOK}/order.json`);

const listing = (extra = {}) =>
    publicationBody({
        apiKey: 'merchant-key',
        slug: SLUG,
        id: BOOK,
        title: 'Elder Example',
        fileUrl: 'https://pdayletters.com/api/print/elder.example/book/letters.pdf?t=abc',
        pages: 48,
        expiresAt: new Date('2026-10-18T12:00:00Z'),
        ...extra
    });

describe('what the printer is told about a book', () => {
    test('the reference names the site and the book so an order can be traced back', () => {
        const reference = orderReference(SLUG, BOOK);

        assert.deepEqual(readReference(reference), { slug: SLUG, id: BOOK });
    });

    test('a reference that is not ours is not guessed at', () => {
        assert.equal(readReference('LL1123'), null);
        assert.equal(readReference(undefined), null);
    });

    test('the checkout is private, and says when it stops being a checkout', () => {
        const body = listing();

        assert.equal(body.enableSecureCheckout, true);
        // Their format, their timezone. An hour of drift on this is a family
        // told the link is dead an hour before it is.
        assert.match(body.secureCheckoutExpirationDate, /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/);
        assert.equal(checkoutExpiry(new Date('2026-01-05T09:07:03Z')), '05-01-2026 10:07:03');
    });

    test('the exact product is pinned when the account has one to pin', () => {
        const body = listing({ offeringId: '4321', offeringPrice: '49.00' });

        assert.equal(body.fixedOfferingId, '4321');
        assert.equal(body.fixedOfferingPrice, '49.00');
        assert.equal('filterCategory' in body, false);
    });

    test('a category is offered when no product has been pinned yet', () => {
        const body = listing({ category: 'hardcover' });

        assert.equal(body.filterCategory, 'hardcover');
        assert.equal('fixedOfferingId' in body, false);
    });

    test('the file is described in the trim they print, and by page count', () => {
        const file = listing().order.product.source.file;

        assert.equal(file.pages, 48);
        assert.deepEqual(file.dimensions, { width: 216, height: 280 });
        assert.match(file.src, /^https:\/\/pdayletters\.com\/api\/print\//);
    });

    test('the buyer is sent back to the book page however checkout ends', () => {
        const body = listing({ baseUrl: 'https://pdayletters.com' });

        assert.match(body.redirect.thankyou.href, /\/book\/elder\.example\?ordered=1$/);
        assert.match(body.redirect.cancellation.href, /\/book\/elder\.example$/);
        assert.match(body.redirect.error.href, /\/book\/elder\.example$/);
    });
});

describe('creating the listing', () => {
    test('a secure listing becomes a checkout link carrying its token', async () => {
        const { fetchImpl, calls } = answering({
            secure_publication_id: 'dec27b95-d22d-4048-96ba-24c1385fd2a8',
            token: '4b3345f7-bf70-4816-8e60-8cedd9c9ae6e'
        });

        const made = await createPublication({ base: 'https://test.www.peecho.com', body: listing(), fetchImpl });

        assert.equal(calls[0].url, 'https://test.www.peecho.com/rest/v3/publication/create');
        assert.equal(made.publicationId, 'dec27b95-d22d-4048-96ba-24c1385fd2a8');
        assert.equal(
            made.checkoutUrl,
            'https://test.www.peecho.com/checkout/print/en/dec27b95-d22d-4048-96ba-24c1385fd2a8?token=4b3345f7-bf70-4816-8e60-8cedd9c9ae6e'
        );
    });

    test('a bare publication id still becomes a checkout link', async () => {
        const { fetchImpl } = answering(123456);

        const made = await createPublication({ base: 'https://test.www.peecho.com', body: listing(), fetchImpl });

        assert.equal(made.checkoutUrl, 'https://test.www.peecho.com/print/123456');
    });

    test('their own error code is written to the log and not to the owner', async () => {
        const said = [];
        const { fetchImpl } = answering(
            { custom_code: 'APP_NO_COMP_DETAILS', details: 'Company details are required' },
            { ok: false, status: 400 }
        );

        const made = await createPublication({
            base: 'https://test.www.peecho.com',
            body: listing(),
            fetchImpl,
            log: { ...silent, error: (name, data) => said.push({ name, data }) }
        });

        assert.equal(made.checkoutUrl, undefined);
        // The blocked account is the expected failure, so the code has to be
        // in the log -- and it means nothing to the person who pressed print.
        assert.equal(said[0].data.code, 'APP_NO_COMP_DETAILS');
        assert.doesNotMatch(made.error, /APP_NO_COMP_DETAILS/);
    });

    test('a printer that cannot be reached is an answer rather than a stack trace', async () => {
        const made = await createPublication({
            base: 'https://test.www.peecho.com',
            body: listing(),
            fetchImpl: async () => {
                throw new Error('getaddrinfo ENOTFOUND');
            },
            log: silent
        });

        assert.match(made.error, /could not be reached/);
    });
});

describe('proving a webhook came from the printer', () => {
    test('their signature is the hash of the secret key and the order id', () => {
        assert.equal(
            signatureMatches({ secret: SECRET, orderId: '1234', signature: theirSignature('1234') }),
            true
        );
    });

    test('a signature for another order does not open this one', () => {
        assert.equal(
            signatureMatches({ secret: SECRET, orderId: '1234', signature: theirSignature('9999') }),
            false
        );
    });

    test('a missing signature is refused rather than skipped', () => {
        assert.equal(signatureMatches({ secret: SECRET, orderId: '1234', signature: '' }), false);
        assert.equal(signatureMatches({ secret: '', orderId: '1234', signature: 'anything' }), false);
    });
});

describe('ordering a printed copy', () => {
    const asOwner = (extra = {}) =>
        request({ email: OWNER, params: { slug: SLUG, id: BOOK }, ...extra });

    test('printing that is switched off says so instead of failing', async () => {
        const response = await order({
            request: asOwner(),
            context: silent,
            store: withABook(),
            key: KEY
        });

        assert.equal(response.status, 503);
    });

    test('an owner is handed a checkout link and the order is written down', async () => {
        await withPrinting(async () => {
            const store = withABook();
            const { fetchImpl, calls } = answering({ secure_publication_id: 'pub-1', token: 'tok-1' });

            const response = await order({
                request: asOwner(),
                context: silent,
                store,
                key: KEY,
                fetchImpl
            });

            assert.equal(response.status, 200);
            assert.match(response.jsonBody.checkoutUrl, /checkout\/print\/en\/pub-1\?token=tok-1$/);

            // The link the printer will fetch is ours and signed, not a
            // storage URL -- that is the whole reason this endpoint exists.
            const src = calls[0].body.order.product.source.file.src;
            assert.match(src, /^https:\/\/pdayletters\.com\/api\/print\/elder\.example\/20260819T055521Z-dd3c9494\/letters\.pdf\?t=/);
            assert.doesNotMatch(src, /blob\.core\.windows\.net/);

            assert.equal(orderOf(store).publicationId, 'pub-1');
        });
    });

    test('pressing print twice reuses the listing rather than making a second one', async () => {
        await withPrinting(async () => {
            const store = withABook();
            const { fetchImpl, calls } = answering({ secure_publication_id: 'pub-1', token: 'tok-1' });

            await order({ request: asOwner(), context: silent, store, key: KEY, fetchImpl });
            const again = await order({ request: asOwner(), context: silent, store, key: KEY, fetchImpl });

            assert.equal(calls.length, 1, 'two listings would mean two prices for one book');
            assert.equal(again.jsonBody.reused, true);
        });
    });

    test('a reader cannot put the family into a shop', async () => {
        await withPrinting(async () => {
            const response = await order({
                request: request({ email: READER, params: { slug: SLUG, id: BOOK } }),
                context: silent,
                store: withABook(),
                key: KEY
            });

            assert.equal(response.status, 403);
        });
    });

    test('a book that is still building cannot be ordered', async () => {
        await withPrinting(async () => {
            const response = await order({
                request: asOwner(),
                context: silent,
                store: withABook({ state: 'building' }),
                key: KEY
            });

            assert.equal(response.status, 404);
        });
    });
});

describe('hearing back from the printer', () => {
    const posting = (body) => request({ body, params: {} });

    test('an order placed is recorded against the book it names', async () => {
        const store = withABook();

        const response = await placed({
            request: posting({
                signature: theirSignature('55'),
                order_id: '55',
                order_reference: orderReference(SLUG, BOOK)
            }),
            context: silent,
            store,
            secret: SECRET
        });

        assert.equal(response.status, 200);
        assert.equal(orderOf(store).orderId, '55');
        assert.ok(orderOf(store).placedAt);
    });

    test('a status update keeps the tracking details and what came before', async () => {
        const store = withABook();
        const reference = orderReference(SLUG, BOOK);

        await placed({
            request: posting({ signature: theirSignature('55'), order_id: '55', order_reference: reference }),
            context: silent,
            store,
            secret: SECRET
        });
        await statusChanged({
            request: posting({
                signature: theirSignature('55'),
                order_id: '55',
                order_reference: reference,
                old_status: 'IN_PRODUCTION',
                new_status: 'SHIPPED',
                tracking_code: 'XXXXXXX1234',
                tracking_url: 'https://nolp.dhl.de/piececode=XXXXXXX1234'
            }),
            context: silent,
            store,
            secret: SECRET
        });

        const record = orderOf(store);
        assert.equal(record.status, 'SHIPPED');
        assert.equal(record.tracking.code, 'XXXXXXX1234');
        // Both statuses, in the order we were told, because a provider
        // sending them out of order is worth being able to see afterwards.
        assert.deepEqual(record.history.map((entry) => entry.status), ['PAID', 'SHIPPED']);
    });

    test('a forged signature is refused and nothing is written down', async () => {
        const store = withABook();

        const response = await statusChanged({
            request: posting({
                signature: theirSignature('55'),
                order_id: '56',
                order_reference: orderReference(SLUG, BOOK),
                new_status: 'REFUNDED'
            }),
            context: silent,
            store,
            secret: SECRET
        });

        assert.equal(response.status, 403);
        assert.equal(orderOf(store), null);
    });

    test('an order naming a book we never made is not retried forever', async () => {
        const store = withABook();

        const response = await statusChanged({
            request: posting({
                signature: theirSignature('77'),
                order_id: '77',
                order_reference: 'somebody-elses-order',
                new_status: 'PAID'
            }),
            context: silent,
            store,
            secret: SECRET
        });

        // 200, because a retry cannot make this book exist and their delivery
        // will go on until it gets one.
        assert.equal(response.status, 200);
        assert.equal(orderOf(store), null);
    });
});

describe('the printer fetching the file', () => {
    const printToken = ({ slug = SLUG, subject = BOOK, purpose = PURPOSE.print } = {}) =>
        issueClaimToken({
            slug,
            key: KEY,
            expiresAt: '2036-01-01T00:00:00.000Z',
            purpose,
            subject
        }).token;

    const fetching = (token, params = { slug: SLUG, id: BOOK }) =>
        request({ params, query: { t: token } });

    test('a signed link redirects to the file itself', async () => {
        const response = await fetchForPrint({
            request: fetching(printToken()),
            context: silent,
            store: withABook(),
            key: KEY
        });

        assert.equal(response.status, 302);
        assert.match(response.headers.Location, /books\/elder\.example/);
        assert.equal(response.headers['Cache-Control'], 'no-store');
    });

    test('a link for one book cannot be walked to another', async () => {
        const response = await fetchForPrint({
            request: fetching(printToken({ subject: '20260101T000000Z-aaaaaaaa' })),
            context: silent,
            store: withABook(),
            key: KEY
        });

        assert.equal(response.status, 404);
    });

    test('a claim link is not a print link, whatever it is signed with', async () => {
        const response = await fetchForPrint({
            request: fetching(printToken({ purpose: PURPOSE.claim })),
            context: silent,
            store: withABook(),
            key: KEY
        });

        assert.equal(response.status, 404);
    });
});
