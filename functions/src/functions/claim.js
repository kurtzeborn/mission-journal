import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { createMailer } from '../lib/mail.js';
import { hardened } from '../lib/api.js';
import { readPrincipal } from '../lib/principal.js';
import { describeClaim, redeemClaim } from '../lib/claim.js';
import { resendClaim } from '../lib/offer.js';

// The claim token never appears in a URL.
//
// Two things read URLs that must not be allowed to read this one. App Insights
// records the path of every request, so a token in the route would be copied
// into telemetry that is retained for months and readable by anyone with
// access to the workspace. And `missionary.org` sits behind a link scanner
// that fetches links out of mail to inspect them -- a `GET` that spends a
// token would be spent by the scanner before the recipient ever clicked. The
// first real message to a missionary mailbox confirmed this is not
// hypothetical: it was relayed through `checkpointcloudsec.com` on its way in,
// and the token was still unspent when the recipient followed it.
//
// So the link in the email carries the token in a *fragment*
// (`/claim#<token>`), which browsers never transmit, and the page POSTs it in
// a request body. That removes it from the access log, from telemetry, from
// the Referer header, and from anything a link scanner can reach.
//
// Both endpoints are POST for the same reason, including the read-only one:
// making `describe` a GET with the token in the query string would undo all
// of the above for the sake of a verb.

let cachedBlobs = null;
let cachedTables = null;
let cachedMailer = null;
const account = () => process.env.STORAGE_ACCOUNT_NAME;
const blobStore = () => (cachedBlobs ??= createBlobStore({ accountName: account() }));
const tableStore = () => (cachedTables ??= createTableStore({ accountName: account() }));
const mailer = () =>
    (cachedMailer ??= createMailer({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        token: process.env.CLOUDFLARE_API_TOKEN,
        allowlist: process.env.MAIL_ALLOWLIST
    }));
const baseUrl = () => process.env.PUBLIC_BASE_URL || 'https://pdayletters.com';

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status, body) => ({ status, headers: hardened(NO_STORE), jsonBody: body });

/**
 * The signing key, or nothing.
 *
 * There is deliberately no fallback. A generated or hard-coded default would
 * make every token in the system forgeable by anyone who read the source, and
 * it would do so silently -- the flow would keep working, which is exactly
 * why nobody would notice.
 */
function signingKey(context) {
    const key = process.env.CLAIM_TOKEN_KEY;
    if (!key) {
        context.error?.('claim: CLAIM_TOKEN_KEY is not configured; refusing to sign or verify');
        return null;
    }
    return key;
}

async function body(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

// What the landing page shows before anyone signs in. Changes nothing.
//
// The store and the signing key are arguments rather than module state so that
// this is reachable from a test. The wrapper below is the only thing that knows
// where a real store comes from, and it is kept free of decisions for the same
// reason: whatever it does cannot be checked by anything.
export async function describe({ request, context, store, tables, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const { token } = await body(request);
    if (!token) return json(400, { status: 'invalid' });

    const described = await describeClaim({ store, tables, token, key });

    // Always 200. The status in the body says what happened, and an HTTP code
    // that varied with it would let a scanner distinguish a live token from a
    // spent one without reading the response.
    return json(200, described);
}

export async function redeem({ request, context, store, tables, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) return json(401, { status: 'unauthenticated' });

    const { token, displayName } = await body(request);
    if (!token) return json(400, { status: 'invalid' });

    const result = await redeemClaim({
        store,
        tables,
        token,
        key,
        // `email`, not `userDetails`. `userDetails` is the field name on the raw
        // Static Web Apps header; `readPrincipal` returns the lowercased address
        // as `email`. Asking for the header's name here yielded `undefined`, which
        // `redeemClaim` correctly reported as `unauthenticated` -- a status the
        // claim page has no copy for, so it fell back to telling the claimant
        // their link was broken.
        principal: principal.email,
        // Trimmed and bounded here rather than trusted: it is the one piece of
        // attacker-supplied text that ends up on the site's own pages.
        displayName: String(displayName ?? '').trim().slice(0, 80),
        log: context
    });

    return json(result.status === 'ok' ? 200 : 409, result);
}

// "Email me a new link", offered on the pages that say a link is dead.
//
// Anonymous, because its whole audience is somebody who cannot sign in yet.
// The dead token in the body is the credential: we signed it, so holding one
// proves the holder was sent a claim email. The reply never names an address,
// so this asks that somebody be written to and cannot be used to learn who.
export async function resend({ request, context, store, mailer: send, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const { token } = await body(request);
    if (!token) return json(400, { status: 'invalid' });

    const result = await resendClaim({
        store,
        mailer: send,
        token,
        key,
        baseUrl: baseUrl(),
        log: context
    });

    // Always 200, for the reason `describe` is. The body says what happened.
    return json(200, result);
}

const describeHandler = (request, context) =>
    describe({ request, context, store: blobStore(), tables: tableStore(), key: signingKey(context) });

const redeemHandler = (request, context) =>
    redeem({
        request,
        context,
        store: blobStore(),
        tables: tableStore(),
        key: signingKey(context)
    });

app.http('claim-describe', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'claim/describe',
    handler: describeHandler
});

app.http('claim-redeem', {
    // `anonymous` is the Functions access key, not the identity check: Static
    // Web Apps forwards to a linked backend without one. The identity check is
    // the principal header read above, and it is not optional here.
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'claim/redeem',
    handler: redeemHandler
});

app.http('claim-resend', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'claim/resend',
    handler: (request, context) =>
        resend({ request, context, store: blobStore(), mailer: mailer(), key: signingKey(context) })
});
