import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { gate, hardened, contentEtag, notModified } from '../lib/api.js';
import { presentPosts } from '../lib/present.js';

let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

// The whole site in one response. A family archive is a few hundred letters at
// most, so paging would add a moving part for no gain, and having the entire
// corpus client-side is what lets the reader's search run without a server.
async function handler(request) {
    const result = await gate({ store: blobStore(), request });
    if (result.denied) return result.denied;

    const etag = contentEtag(result.etag, result.role);

    // `no-cache` rather than a lifetime. This file is the one thing here that
    // changes -- a letter arrives, an owner hides or edits one -- and a stale
    // copy is worse than merely out of date: it is what the owner's edit form
    // is filled from, so holding it made a second edit silently reinstate what
    // the first had removed. Revalidating costs a round trip and usually a 304.
    const fresh = { ETag: etag, 'Cache-Control': 'private, no-cache' };

    const unchanged = notModified(request.headers.get('if-none-match'), etag);
    if (unchanged) return unchanged;

    return {
        status: 200,
        headers: hardened({ 'Content-Type': 'application/json; charset=utf-8', ...fresh }),
        jsonBody: {
            slug: result.slug,
            role: result.role,
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
