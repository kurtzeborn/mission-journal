import { app } from '@azure/functions';
import { blobStore } from '../lib/clients.js';
import { gate, hardened } from '../lib/api.js';
import { photoIsVisible } from '../lib/present.js';

// Both are built by render.js, so the set is closed. Checked against a literal
// list rather than a pattern because these two strings become a blob path.
const SIZES = new Set(['large', 'thumb']);

// photoId is content-addressed by paths.js as `p_` plus 12 hex characters.
// Re-derived here rather than trusted, for the same reason the slug is.
const PHOTO_ID = /^p_[0-9a-f]{12}$/;

export async function servePhoto({ request, context, store }) {
    const result = await gate({ store, request, log: context });
    if (result.denied) return result.denied;

    const { slug, role, posts } = result;
    const photoId = String(request.params.photoId ?? '');
    const size = String(request.params.size ?? '');

    // A photo of a held letter is not fetchable by URL. Without this the
    // hidden filter in posts.json would only hide the text.
    if (!PHOTO_ID.test(photoId) || !SIZES.has(size) || !photoIsVisible(posts, photoId, role)) {
        return { status: 404, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' };
    }

    // `photoId` is a digest of the picture and `size` says which rendering of
    // it this is, so the pair names these bytes and no others -- an ETag can be
    // built without reading anything. Answering the revalidation above the
    // read is the whole point: a browser coming back for a picture it already
    // has costs no storage and sends no image.
    //
    // The visibility check still runs on every request, which is why the cache
    // stays short instead of being set to a year. Hiding a photo has to take
    // effect for someone who already looked at it.
    const etag = `"${photoId}-${size}"`;
    if (request.headers.get('if-none-match') === etag) {
        return { status: 304, headers: hardened({ ETag: etag }) };
    }

    const blob = await store.readBlob('rendered', `${slug}/photos/${photoId}/${size}.webp`);
    if (!blob) {
        return { status: 404, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' };
    }

    return {
        status: 200,
        headers: hardened({
            // Pinned to what our own transcoder produced, never echoed from the
            // attachment. The sender chose that filename and that MIME type.
            'Content-Type': 'image/webp',
            ETag: etag
        }),
        body: blob.bytes
    };
}

app.http('photo', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'photo/{slug}/{photoId}/{size}.webp',
    handler: (request, context) => servePhoto({ request, context, store: blobStore() })
});
