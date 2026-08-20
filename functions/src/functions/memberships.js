import { app } from '@azure/functions';
import { tableStore } from '../lib/clients.js';
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

// The store is an argument rather than module state so that this is reachable
// from a test; the wrapper below is the only part that knows where a real one
// comes from.
export async function memberships({ request, tables }) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) {
        return { status: 401, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' };
    }

    const memberships = await membershipsFor({
        tables,
        // `email`, not `userDetails` -- see the note in claim.js. Here the same
        // mistake is silent rather than loud: an undefined email matches no
        // membership row, so the caller is told they belong to nothing.
        email: principal.email
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

const handler = (request) => memberships({ request, tables: tableStore() });

app.http('memberships', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'memberships',
    handler
});
