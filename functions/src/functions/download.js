import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { gate, hardened } from '../lib/api.js';
import { presentPosts } from '../lib/present.js';
import { buildArchive } from '../lib/archive.js';

let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

// The whole archive as a zip that works with no network.
//
// It goes through the same gate as the reader and is built from the same
// presented payload, so a reader's download cannot contain a held letter and
// an owner's can, without either rule being restated here.
async function handler(request, context) {
    const result = await gate({ store: blobStore(), request });
    if (result.denied) return result.denied;

    const posts = presentPosts(result.posts, result.role);

    const { stream, done } = buildArchive({
        store: blobStore(),
        slug: result.slug,
        posts,
        exportedAt: new Date().toISOString(),
        log: context
    });

    // A failure after the first byte cannot become a status code, so it is
    // logged rather than thrown. Left unhandled it would be an unhandled
    // rejection that takes the worker down mid-download.
    done.catch((error) => {
        context.error('archive.failed', { slug: result.slug, error: error.message });
        stream.destroy(error);
    });

    return {
        status: 200,
        headers: hardened({
            'Content-Type': 'application/zip',
            // Names the archive after the missionary, so a folder of these is
            // still legible a decade from now.
            'Content-Disposition': `attachment; filename="${result.slug}-letters.zip"`,
            // No length is known until the last photo is read, and computing
            // one would mean building the whole archive before sending any of
            // it. The cost is a progress bar the browser cannot fill.
            'Cache-Control': 'no-store'
        }),
        body: stream
    };
}

app.http('download', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'download/{slug}/letters.zip',
    handler
});
