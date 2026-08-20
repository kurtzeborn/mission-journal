import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { hardened } from '../lib/api.js';
import { readPrincipal } from '../lib/principal.js';
import { acceptInvite, describeInvite } from '../lib/invite.js';
import { recordDigestChoice } from '../lib/users.js';

// Accepting an invitation.
//
// A near-copy of claim.js on purpose, and the duplication is the cheaper of
// the two mistakes available: the alternative is one endpoint that branches on
// the kind of token it was handed, which is precisely the confusion the
// token's signed `purpose` field exists to make impossible. Two endpoints that
// each verify one purpose cannot be talked into doing the other's job.
//
// Everything claim.js says about why the token is in a fragment and why both
// endpoints are POST applies here unchanged.

let cachedBlobs = null;
let cachedTables = null;
const account = () => process.env.STORAGE_ACCOUNT_NAME;
const blobStore = () => (cachedBlobs ??= createBlobStore({ accountName: account() }));
const tableStore = () => (cachedTables ??= createTableStore({ accountName: account() }));

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status, body) => ({ status, headers: hardened(NO_STORE), jsonBody: body });

function signingKey(context) {
    const key = process.env.CLAIM_TOKEN_KEY;
    if (!key) {
        context.error?.('invite: CLAIM_TOKEN_KEY is not configured; refusing to verify');
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

export async function describe({ request, tables, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const { token } = await body(request);
    if (!token) return json(400, { status: 'invalid' });

    // Always 200, for the reason claim.js gives: an HTTP code that varied with
    // the outcome would let a scanner tell a live invitation from a spent one
    // without reading the response.
    return json(200, await describeInvite({ tables, token, key }));
}

export async function accept({ request, context, store, tables, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) return json(401, { status: 'unauthenticated' });

    const { token, digestFrequency } = await body(request);
    if (!token) return json(400, { status: 'invalid' });

    const result = await acceptInvite({
        store,
        tables,
        token,
        key,
        principal: principal.email,
        log: context
    });

    // After the grant and never instead of it. This is the moment the plan
    // calls first sign-in -- the one time somebody is attentively completing
    // a flow -- so it is where the question is worth asking. It is also the
    // moment they are least able to recover from it going wrong, which is why
    // the answer is recorded last and cannot fail the acceptance.
    if (result.status === 'ok') {
        await recordDigestChoice({
            tables,
            email: principal.email,
            frequency: digestFrequency,
            log: context
        });
    }

    return json(result.status === 'ok' ? 200 : 409, result);
}

app.http('invite-describe', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'invite/describe',
    handler: (request, context) => describe({ request, tables: tableStore(), key: signingKey(context) })
});

app.http('invite-accept', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'invite/accept',
    handler: (request, context) =>
        accept({ request, context, store: blobStore(), tables: tableStore(), key: signingKey(context) })
});
