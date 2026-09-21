import { app } from '@azure/functions';
import { blobStore, signingKey, tableStore } from '../lib/clients.js';
import { jsonResponse as json, readBody, siteGate } from '../lib/api.js';
import { readPrincipal } from '../lib/principal.js';
import {
    acceptQrInvite,
    closeQrInvite,
    exchangeQrInvite,
    rotateQrInvite,
    startQrInvite
} from '../lib/qrinvite.js';
import { setting } from '../lib/settings.js';

const STATUS = {
    'no such site': 404,
    'no such session': 404,
    'owners only': 403
};

const refuse = (error) => json(STATUS[error] ?? 409, { error });
const ownerOf = ({ request, store, context }) =>
    siteGate({ store, request, ownersOnly: true, log: context });
const baseUrl = () => setting('PUBLIC_BASE_URL', 'https://pdayletters.com');

export async function start({ request, context, store, tables, key, publicUrl }) {
    if (!key) return json(503, { error: 'unavailable' });
    const gated = await ownerOf({ request, store, context });
    if (gated.denied) return gated.denied;

    const result = await startQrInvite({
        store,
        tables,
        slug: gated.slug,
        actor: gated.principal.email,
        key,
        baseUrl: publicUrl
    });
    return result.error ? refuse(result.error) : json(200, result);
}

export async function rotate({ request, context, store, tables, key, publicUrl }) {
    if (!key) return json(503, { error: 'unavailable' });
    const gated = await ownerOf({ request, store, context });
    if (gated.denied) return gated.denied;

    const result = await rotateQrInvite({
        store,
        tables,
        slug: gated.slug,
        actor: gated.principal.email,
        id: request.params.id,
        key,
        baseUrl: publicUrl
    });
    return result.error ? refuse(result.error) : json(200, result);
}

export async function close({ request, context, store, tables }) {
    const gated = await ownerOf({ request, store, context });
    if (gated.denied) return gated.denied;

    const result = await closeQrInvite({
        store,
        tables,
        slug: gated.slug,
        actor: gated.principal.email,
        id: request.params.id
    });
    return result.error ? refuse(result.error) : json(200, result);
}

export async function exchange({ request, tables, key }) {
    if (!key) return json(503, { status: 'unavailable' });
    const { token } = await readBody(request);
    if (!token) return json(200, { status: 'invalid' });
    return json(200, await exchangeQrInvite({ tables, token, key }));
}

export async function accept({ request, context, store, tables, key }) {
    if (!key) return json(503, { status: 'unavailable' });
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) return json(401, { status: 'unauthenticated' });

    const { ticket } = await readBody(request);
    if (!ticket) return json(400, { status: 'invalid' });

    const result = await acceptQrInvite({ store, tables, ticket, key, principal, log: context });
    return json(result.status === 'ok' ? 200 : 409, result);
}

app.http('qr-invite-start', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'members/{slug}/qr',
    handler: (request, context) =>
        start({
            request,
            context,
            store: blobStore(),
            tables: tableStore(),
            key: signingKey('qr-invite', context),
            publicUrl: baseUrl()
        })
});

app.http('qr-invite-rotate', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'members/{slug}/qr/{id}',
    handler: (request, context) =>
        rotate({
            request,
            context,
            store: blobStore(),
            tables: tableStore(),
            key: signingKey('qr-invite', context),
            publicUrl: baseUrl()
        })
});

app.http('qr-invite-close', {
    authLevel: 'anonymous',
    methods: ['DELETE'],
    route: 'members/{slug}/qr/{id}',
    handler: (request, context) =>
        close({ request, context, store: blobStore(), tables: tableStore() })
});

app.http('qr-invite-exchange', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'qr-invite/exchange',
    handler: (request, context) =>
        exchange({ request, context, tables: tableStore(), key: signingKey('qr-invite', context) })
});

app.http('qr-invite-accept', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'qr-invite/accept',
    handler: (request, context) =>
        accept({
            request,
            context,
            store: blobStore(),
            tables: tableStore(),
            key: signingKey('qr-invite', context)
        })
});
