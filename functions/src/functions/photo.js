import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { gate, hardened } from '../lib/api.js';
import { photoIsVisible } from '../lib/present.js';

let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

// Both are built by render.js, so the set is closed. Checked against a literal
// list rather than a pattern because these two strings become a blob path.
const SIZES = new Set(['large', 'thumb']);

// photoId is content-addressed by paths.js as `p_` plus 12 hex characters.
// Re-derived here rather than trusted, for the same reason the slug is.
const PHOTO_ID = /^p_[0-9a-f]{12}$/;

async function handler(request) {
    const result = await gate({ store: blobStore(), request });
    if (result.denied) return result.denied;

    const { slug, role, posts } = result;
    const photoId = String(request.params.photoId ?? '');
    const size = String(request.params.size ?? '');

    // A photo of a held letter is not fetchable by URL. Without this the
    // hidden filter in posts.json would only hide the text.
    if (!PHOTO_ID.test(photoId) || !SIZES.has(size) || !photoIsVisible(posts, photoId, role)) {
        return { status: 404, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' };
    }

    const blob = await blobStore().readBlob('rendered', `${slug}/photos/${photoId}/${size}.webp`);
    if (!blob) {
        return { status: 404, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' };
    }

    return {
        status: 200,
        headers: hardened({
            // Pinned to what our own transcoder produced, never echoed from the
            // attachment. The sender chose that filename and that MIME type.
            'Content-Type': 'image/webp'
        }),
        body: blob.bytes
    };
}

app.http('photo', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'photo/{slug}/{photoId}/{size}.webp',
    handler
});
