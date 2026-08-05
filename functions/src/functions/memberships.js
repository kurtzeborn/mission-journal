import { app } from '@azure/functions';
import { createTableStore } from '../lib/tables.js';
import { hardened } from '../lib/api.js';
import { readPrincipal } from '../lib/principal.js';
import { membershipsFor } from '../lib/memberships.js';

// Which archives does the person signed in right now belong to?
//
// This is the one question `acl.json` cannot answer without reading every ACL
// in the account, and it is the question the root page has to answer for
// someone who has just signed in and wants to get to their letters.
//
// It returns an index, not an authorization. Nothing here grants access to
// anything: every slug listed is still checked against its own ACL when the
// content endpoint is called, and a stale row costs a redirect into a refusal
// rather than a stranger's letters.

let cachedTables = null;
const tableStore = () =>
    (cachedTables ??= createTableStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

async function handler(request, context) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) {
        return { status: 401, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' };
    }

    const memberships = await membershipsFor({
        tables: tableStore(),
        email: principal.userDetails
    });

    return {
        status: 200,
        headers: hardened({
            'Content-Type': 'application/json; charset=utf-8',
            // Never cached. Membership changes when a site is claimed, an
            // invitation is accepted, or an owner removes someone, and a stale
            // list sends a removed reader back to a site that will refuse them.
            'Cache-Control': 'private, no-store'
        }),
        jsonBody: { memberships }
    };
}

app.http('memberships', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'memberships',
    handler
});
