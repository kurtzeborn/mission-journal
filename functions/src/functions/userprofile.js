import { app } from '@azure/functions';
import { hardened, jsonResponse as json } from '../lib/api.js';
import { tableStore } from '../lib/clients.js';
import { readPrincipal } from '../lib/principal.js';
import {
    normalizeUserProfile,
    readUserProfile,
    setUserProfile
} from '../lib/userprofile.js';

const refuse = () => ({ status: 401, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' });

const publicProfile = (row) => ({
    displayName: row?.displayName ?? '',
    givenName: row?.givenName ?? '',
    familyName: row?.familyName ?? '',
    nameProvider: row?.nameProvider ?? '',
    nameUpdatedAt: row?.nameUpdatedAt ?? ''
});

export async function read({ request, tables }) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal?.email) return refuse();

    return json(200, publicProfile(await readUserProfile({ tables, email: principal.email })));
}

export async function write({ request, tables }) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal?.email) return refuse();

    const body = await request.json().catch(() => ({}));
    const wanted = normalizeUserProfile({
        displayName: body?.displayName,
        givenName: body?.givenName,
        familyName: body?.familyName,
        provider: principal.provider
    });
    if (!wanted.displayName) return json(400, { error: 'displayName is required' });

    const saved = await setUserProfile({
        tables,
        email: principal.email,
        displayName: wanted.displayName,
        givenName: wanted.givenName,
        familyName: wanted.familyName,
        provider: principal.provider
    });
    return json(200, publicProfile(saved));
}

app.http('user-profile-read', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'profile',
    handler: (request) => read({ request, tables: tableStore() })
});

app.http('user-profile-write', {
    authLevel: 'anonymous',
    methods: ['PUT'],
    route: 'profile',
    handler: (request) => write({ request, tables: tableStore() })
});
