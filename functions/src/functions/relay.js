import { app } from '@azure/functions';
import { createTableStore } from '../lib/tables.js';
import { createMailer } from '../lib/mail.js';
import { hardened } from '../lib/api.js';
import { readRelay, requestRelay } from '../lib/relay.js';

// Asking the missionary to send the first letter.
//
// Anonymous, like the opt-out, and for the same reason: the person holding
// this link has never signed in and is not going to. The signature on the
// token is the whole of the authorisation, and it names both parties, so
// there is nothing here for a caller to substitute.
//
// POST for both, including the read. A GET that sends mail would be sent by
// the first link scanner to open the message, which would interrupt a
// missionary on nobody's behalf -- the exact outcome this flow is built to
// keep rare.

let cachedTables = null;
let cachedMailer = null;
const account = () => process.env.STORAGE_ACCOUNT_NAME;
const tableStore = () => (cachedTables ??= createTableStore({ accountName: account() }));
const mailer = () =>
    (cachedMailer ??= createMailer({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        token: process.env.CLOUDFLARE_API_TOKEN,
        allowlist: process.env.MAIL_ALLOWLIST
    }));

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status, body) => ({ status, headers: hardened(NO_STORE), jsonBody: body });

function signingKey(context) {
    const key = process.env.CLAIM_TOKEN_KEY;
    if (!key) {
        context.error?.('relay: CLAIM_TOKEN_KEY is not configured; refusing to verify');
        return null;
    }
    return key;
}

const baseUrl = () => process.env.PUBLIC_BASE_URL ?? 'https://pdayletters.com';

async function tokenFrom(request) {
    try {
        return (await request.json())?.token ?? '';
    } catch {
        return '';
    }
}

export async function describe({ request, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const token = await tokenFrom(request);
    const read = token ? readRelay({ token, key }) : null;

    // Both addresses come back so the page can say who will be written to and
    // on whose behalf. Somebody who was forwarded this by mistake needs to be
    // able to see that before pressing anything.
    return json(
        200,
        read
            ? { status: 'ready', author: read.author, requester: read.requester }
            : { status: 'invalid' }
    );
}

export async function ask({ request, context, tables, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const token = await tokenFrom(request);
    if (!token) return json(400, { status: 'invalid' });

    const result = await requestRelay({
        tables,
        mailer: mailer(),
        token,
        key,
        baseUrl: baseUrl(),
        log: context
    });

    return json(result.status === 'ok' ? 200 : 400, { status: result.status });
}

app.http('relay-describe', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'relay/describe',
    handler: (request, context) => describe({ request, key: signingKey(context) })
});

app.http('relay', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'relay',
    handler: (request, context) => ask({ request, context, tables: tableStore(), key: signingKey(context) })
});
