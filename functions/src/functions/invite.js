import { app } from '@azure/functions';
import { blobStore, signingKey, tableStore } from '../lib/clients.js';
import { jsonResponse as json, readBody as body } from '../lib/api.js';
import { readPrincipal } from '../lib/principal.js';
import { acceptInvite, describeInvite } from '../lib/invite.js';

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

    const { token } = await body(request);
    if (!token) return json(400, { status: 'invalid' });

    const result = await acceptInvite({
        store,
        tables,
        token,
        key,
        principal: principal.email,
        log: context
    });

    return json(result.status === 'ok' ? 200 : 409, result);
}

app.http('invite-describe', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'invite/describe',
    handler: (request, context) => describe({ request, tables: tableStore(), key: signingKey('invite', context) })
});

app.http('invite-accept', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'invite/accept',
    handler: (request, context) =>
        accept({ request, context, store: blobStore(), tables: tableStore(), key: signingKey('invite', context) })
});
