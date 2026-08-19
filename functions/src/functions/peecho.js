import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { siteGate, hardened } from '../lib/api.js';
import { issueClaimToken, PURPOSE, verifyClaimToken } from '../lib/claimtoken.js';
import { noteOrder, readOrder } from '../lib/orders.js';
import {
    createPublication,
    publicationBody,
    readReference,
    signatureMatches,
    CHECKOUT_DAYS,
    TEST_BASE
} from '../lib/peecho.js';
import { BOOKS, bookName, coverImageName, readBook, STATE } from '../lib/publish.js';
import { readProfile } from '../lib/profile.js';
import { setting } from '../lib/settings.js';

// Getting a finished book printed, and hearing back about it.
//
// Four endpoints, and they are unlike each other on purpose:
//
//   - `print/{slug}/{id}` is an owner asking for a checkout page. Signed in,
//     owners only, exactly like every other button on the book page.
//   - `print/{slug}/{id}/letters.pdf` is the printer fetching the file. It is
//     anonymous because Peecho is not a user of this service and never will
//     be, and the signature on the token is the whole of the authorisation.
//   - the two webhooks are Peecho telling us something happened. Also
//     anonymous, also authorised by a signature, and neither of them is
//     allowed to be a way of asking us to do something.
//
// The thread running through the last three: no session, no header, no
// allowlist of their egress addresses -- which would break the first time
// they moved a region -- just arithmetic on a shared secret.

let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: setting('STORAGE_ACCOUNT_NAME') }));

const json = (status, body) => ({
    status,
    headers: hardened({
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8'
    }),
    jsonBody: body
});

// Long enough for a print facility on the other side of the world to pull a
// hundred megabytes over whatever connection it has. Nothing is watching this
// download, so a link that dies mid-transfer fails silently in somebody
// else's system and comes back to us as a book that never arrived.
const FETCH_MINUTES = 60;

// The link handed to the printer does not expire in any useful sense. Their
// terms say they keep files in order to make reprints, and a reprint ordered
// in three years has to be able to fetch the same PDF -- so an expiry is a
// bomb with a long fuse. Ten years is the honest way to write "not this
// decade", and the lever that actually revokes these is rotating the key.
const PRINT_YEARS = 10;

function signingKey(context) {
    const key = setting('CLAIM_TOKEN_KEY');
    if (!key) {
        context.error?.('peecho: CLAIM_TOKEN_KEY is not configured; refusing to sign');
        return null;
    }
    return key;
}

// Where the API lives from outside. The printer fetches this, so it cannot be
// a relative path and it cannot be the Function App's own hostname either --
// that one is not what the certificate on the site is for.
const baseUrl = () => setting('PUBLIC_BASE_URL', 'https://pdayletters.com');

/**
 * Is printing switched on at all?
 *
 * One setting decides it, and its absence is a configuration state rather
 * than a fault: a fresh environment has no printer, the book page is told so
 * and does not offer to sell anything, and the endpoint says the same in a
 * sentence rather than throwing a 500 that reads like a bug.
 */
function printer(context) {
    const apiKey = setting('PEECHO_API_KEY');
    if (!apiKey) {
        context.log?.('peecho.off', { reason: 'no api key' });
        return null;
    }

    return {
        apiKey,
        // Test unless production is asked for by name. Their terms are
        // explicit that orders not meant to be printed must not be sent to
        // the live environment, and the cost of getting that default the
        // wrong way round is a real book, really printed, really shipped.
        base: setting('PEECHO_BASE', TEST_BASE),
        currency: setting('PEECHO_CURRENCY', 'USD'),
        offeringId: setting('PEECHO_OFFERING_ID'),
        offeringPrice: setting('PEECHO_OFFERING_PRICE'),
        category: setting('PEECHO_CATEGORY')
    };
}

const later = (years) => {
    const at = new Date();
    at.setUTCFullYear(at.getUTCFullYear() + years);
    return at;
};

const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

/**
 * The URL the printer will fetch the book from.
 *
 * Not a storage SAS. A SAS long enough to survive reprints is a bearer token
 * for a blob, held in somebody else's database, that cannot be withdrawn
 * without rotating a storage key everything else depends on. This is our own
 * URL, signed with the same key the invitation links use, and it redirects to
 * a short-lived SAS minted at the moment of the fetch -- so what leaves here
 * is revocable, loggable, and points at a domain we own.
 */
const printUrl = ({ slug, id, token }) =>
    `${baseUrl()}/api/print/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/letters.pdf?t=${encodeURIComponent(token)}`;

// The picture of the cover, on the same signed link and for the same reasons.
const thumbUrl = ({ slug, id, token }) =>
    `${baseUrl()}/api/print/${encodeURIComponent(slug)}/${encodeURIComponent(id)}/cover.jpg?t=${encodeURIComponent(token)}`;

/**
 * Ask for a checkout page for a finished book.
 *
 * What comes back is a URL at Peecho, and that is the entire point of the
 * shape: the buyer pays them, they print, they ship, and no address, card or
 * name ever passes through here. We are told an order happened and nothing
 * else about the person who made it.
 */
export async function order({ request, context, store, key, fetchImpl = fetch }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    const shop = printer(context);
    if (!shop || !key) return json(503, { error: 'printing is not switched on yet' });

    const { slug } = gated;
    const id = request.params.id;
    const found = await readBook({ store, slug, id });
    if (found?.state !== STATE.ready) {
        return json(404, { error: 'there is no finished book to print' });
    }

    // Already listed, and the listing has not run out. Handing back the same
    // checkout rather than making a second one, because two listings for one
    // book is two prices, two pages and two ways to buy the same object.
    const existing = await readOrder({ store, slug, id });
    if (existing?.order?.checkoutUrl && Date.parse(existing.order.listedUntil ?? '') > Date.now()) {
        return json(200, { checkoutUrl: existing.order.checkoutUrl, reused: true });
    }

    const { profile } = await readProfile({ store, slug });
    const title = profile.displayName || slug;

    const { token } = issueClaimToken({
        slug,
        key,
        expiresAt: later(PRINT_YEARS).toISOString(),
        purpose: PURPOSE.print,
        subject: id
    });

    // Checked here rather than assumed, because a book built before covers
    // were rendered has none, and a listing carrying a URL that answers 404
    // is worse than a listing with no picture: their checkout would show a
    // broken frame instead of an empty one.
    const hasPicture = Boolean(await store.readBlob(BOOKS, coverImageName(slug, id)));

    const listed = await createPublication({
        base: shop.base,
        log: context,
        fetchImpl,
        body: publicationBody({
            apiKey: shop.apiKey,
            slug,
            id,
            title,
            fileUrl: printUrl({ slug, id, token }),
            thumbnailUrl: hasPicture ? thumbUrl({ slug, id, token }) : '',
            pages: found.pages,
            currency: shop.currency,
            offeringId: shop.offeringId,
            offeringPrice: shop.offeringPrice,
            category: shop.category,
            baseUrl: baseUrl(),
            expiresAt: inDays(CHECKOUT_DAYS)
        })
    });

    if (listed.error) return json(502, { error: listed.error });

    await noteOrder({
        store,
        slug,
        id,
        log: context,
        patch: {
            title,
            publicationId: listed.publicationId,
            checkoutUrl: listed.checkoutUrl,
            listedAt: new Date().toISOString(),
            listedUntil: inDays(CHECKOUT_DAYS).toISOString()
        }
    });

    context.log('peecho.listed', { slug, id, publication: listed.publicationId });

    return json(200, { checkoutUrl: listed.checkoutUrl, reused: false });
}

/**
 * The printer fetching the book.
 *
 * The token names the site and the book, both inside the signature, so the
 * holder of one book's link cannot walk it to another. There is no session
 * here and there is not meant to be.
 */
export async function fetchForPrint({ request, context, store, key }) {
    return handOverSigned({ request, context, store, key, what: 'book' });
}

/**
 * The checkout page showing the buyer what they are buying.
 *
 * The same signed link as the PDF, and unlike the PDF this one is loaded by a
 * browser -- a stranger's browser, on Peecho's checkout, possibly months from
 * now. That is the reason it is a redirect to a short-lived SAS rather than a
 * long-lived one handed out in the listing: what sits in their database is a
 * URL on a domain we own, and it stops working the day the signing key is
 * rotated.
 */
export async function fetchCoverForPrint({ request, context, store, key }) {
    return handOverSigned({ request, context, store, key, what: 'cover' });
}

async function handOverSigned({ request, context, store, key, what }) {
    if (!key) return json(503, { error: 'unavailable' });

    const slug = request.params.slug;
    const id = request.params.id;
    const checked = verifyClaimToken({
        token: request.query?.get?.('t') ?? '',
        key,
        purpose: PURPOSE.print
    });

    // One answer for every way of being wrong. A printer with a bad link
    // needs to retry rather than diagnose, and anybody else guessing at these
    // learns nothing from the difference between "no such book" and "not your
    // book".
    if (!checked.valid || checked.slug !== slug || checked.subject !== id) {
        context.warn?.('peecho.badPrintToken', { slug, id, what, reason: checked.reason ?? 'mismatch' });
        return json(404, { error: 'not found' });
    }

    const found = await readBook({ store, slug, id });
    if (found?.state !== STATE.ready) return json(404, { error: 'not found' });

    const name = what === 'cover' ? coverImageName(slug, id) : bookName(slug, id);
    const url = await store.readUrl(BOOKS, name, { minutes: FETCH_MINUTES });

    context.log('peecho.printFetched', { slug, id, what });

    return { status: 302, headers: hardened({ Location: url, 'Cache-Control': 'no-store' }) };
}

/**
 * Both webhooks, which differ only in what they are called and what they say.
 *
 * Peecho signs `sha256(secretKey + order_id)` and posts JSON. That signature
 * covers the order id and nothing else, so this treats the body as a claim
 * about an order it has proved it knows the id of -- which is enough for a
 * status note and would not be enough to authorise anything.
 *
 * Everything that is not a forgery answers 200, including a payload naming a
 * book that no longer exists. A webhook that fails is retried, and retried,
 * and there is no state on our side that a hundredth delivery would fix.
 */
async function heard({ request, context, store, secret, kind }) {
    if (!secret) {
        context.error?.('peecho: PEECHO_SECRET_KEY is not configured; refusing to verify');
        return json(503, { error: 'unavailable' });
    }

    let body = {};
    try {
        body = await request.json();
    } catch {
        return json(400, { error: 'that was not valid JSON' });
    }

    const orderId = String(body.order_id ?? '');
    if (!signatureMatches({ secret, orderId, signature: body.signature })) {
        context.warn?.('peecho.badSignature', { kind, order: orderId });
        return json(403, { error: 'forbidden' });
    }

    const reference = readReference(body.order_reference);
    if (!reference) {
        context.warn?.('peecho.strayOrder', { kind, order: orderId, reference: body.order_reference });
        return json(200, { ok: true });
    }

    // `new_status` on a status update, `status` on the placed pingback, and a
    // sensible constant when neither is sent -- their placed callback is
    // configured in a dashboard rather than described in the reference, so
    // this refuses to depend on a field name it has not seen.
    const status = String(body.new_status ?? body.status ?? (kind === 'placed' ? 'PAID' : ''));

    const patch = { orderId, reference: body.order_reference, provider: 'peecho' };
    if (status) patch.status = status;
    if (kind === 'placed') patch.placedAt = new Date().toISOString();
    if (body.tracking_code || body.tracking_url) {
        patch.tracking = { code: body.tracking_code ?? '', url: body.tracking_url ?? '' };
    }

    const noted = await noteOrder({ store, ...reference, patch, log: context });
    if (noted.error) {
        // Worth a retry, and this is the one case where their retry helps.
        context.error?.('peecho.notRecorded', { kind, order: orderId });
        return json(503, { error: noted.error });
    }

    context.log('peecho.heard', { kind, ...reference, order: orderId, status });

    return json(200, { ok: true });
}

export const placed = (args) => heard({ ...args, kind: 'placed' });
export const statusChanged = (args) => heard({ ...args, kind: 'status' });

const secretKey = () => setting('PEECHO_SECRET_KEY');

app.http('print-order', {
    // The Functions access key, not the identity check. The identity check is
    // the principal header the gate reads, and this route is owners only.
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'print/{slug}/{id}',
    handler: (request, context) =>
        order({ request, context, store: blobStore(), key: signingKey(context) })
});

app.http('print-file', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'print/{slug}/{id}/letters.pdf',
    handler: (request, context) =>
        fetchForPrint({ request, context, store: blobStore(), key: signingKey(context) })
});

app.http('print-cover', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'print/{slug}/{id}/cover.jpg',
    handler: (request, context) =>
        fetchCoverForPrint({ request, context, store: blobStore(), key: signingKey(context) })
});

app.http('peecho-placed', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'peecho/placed',
    handler: (request, context) =>
        placed({ request, context, store: blobStore(), secret: secretKey() })
});

app.http('peecho-status', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'peecho/status',
    handler: (request, context) =>
        statusChanged({ request, context, store: blobStore(), secret: secretKey() })
});
