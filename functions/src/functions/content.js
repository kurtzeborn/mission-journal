import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { gate, hardened } from '../lib/api.js';
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

    return {
        status: 200,
        headers: hardened({ 'Content-Type': 'application/json; charset=utf-8' }),
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
