import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { sitesBySlug } from '../lib/sites.js';
import { gate, hardened, contentEtag, notModified } from '../lib/api.js';
import { presentPosts } from '../lib/present.js';

let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

let cachedTables = null;
const tableStore = () =>
    (cachedTables ??= createTableStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

// The whole site in one response. A family archive is a few hundred letters at
// most, so paging would add a moving part for no gain, and having the entire
// corpus client-side is what lets the reader's search run without a server.
async function handler(request, context) {
    const result = await gate({ store: blobStore(), request, log: context });
    if (result.denied) return result.denied;

    const etag = contentEtag(result.etag, result.role, result.viaOperator);

    // `no-cache` rather than a lifetime. This file is the one thing here that
    // changes -- a letter arrives, an owner hides or edits one -- and a stale
    // copy is worse than merely out of date: it is what the owner's edit form
    // is filled from, so holding it made a second edit silently reinstate what
    // the first had removed. Revalidating costs a round trip and usually a 304.
    const fresh = { ETag: etag, 'Cache-Control': 'private, no-cache' };

    const unchanged = notModified(request.headers.get('if-none-match'), etag);
    if (unchanged) return unchanged;

    // After the 304, because a revalidation that is going to send no body has
    // no use for a name. One point read in the slug's own partition, which is
    // what the site row exists to make cheap.
    const sites = await sitesBySlug({ tables: tableStore(), slugs: [result.slug] });

    return {
        status: 200,
        headers: hardened({ 'Content-Type': 'application/json; charset=utf-8', ...fresh }),
        jsonBody: {
            slug: result.slug,
            // What the family calls the missionary, which is what the page is
            // titled with. Empty until somebody claims the site and types one,
            // so the client falls back to the slug rather than to nothing.
            name: sites.get(result.slug)?.missionaryDisplayName ?? '',
            role: result.role,
            // Only ever true for the one or two addresses in OPERATOR_EMAILS,
            // and it drives a banner rather than a permission -- the operator
            // is already an owner by the time this is read. It is part of the
            // ETag salt above, because it is part of the body: a response with
            // the warning and one without must not share a validator.
            viaOperator: Boolean(result.viaOperator),
            posts: presentPosts(result.posts, result.role)
        }
    };
}

app.http('content', {
    // Authorization is the ACL check inside the handler. `anonymous` here means
    // no Functions access key, which is required: Static Web Apps forwards to a
    // linked backend without one, and the app is reachable only through it.
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'content/{slug}/posts.json',
    handler
});
