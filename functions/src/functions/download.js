import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { gate, hardened } from '../lib/api.js';
import { presentPosts } from '../lib/present.js';
import { buildArchive } from '../lib/archive.js';

let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

// Where finished archives are staged. Its own container so a lifecycle rule
// can be pointed at derived data later without going anywhere near `raw/` or
// `rendered/`, and so nothing about serving a download touches the originals.
const EXPORTS = 'exports';

// Long enough to survive a slow phone starting a download, short enough that a
// URL later found in a browser history or a chat log is already dead.
const LINK_MINUTES = 15;

/**
 * The whole archive as a zip that works with no network.
 *
 * It goes through the same gate as the reader and is built from the same
 * presented payload, so a reader's download cannot contain a held letter and
 * an owner's can, without either rule being restated here.
 *
 * The zip is assembled into blob storage and the caller is redirected to it
 * with a short-lived, read-only, single-blob link rather than being served
 * down this connection. Building was never the slow part -- these are bytes we
 * already hold. The slow part was holding an HTTP response open for the length
 * of somebody's download, which on a bad connection outlasts the platform's
 * response window and cannot be resumed when it fails. Handing back a link
 * moves the transfer to storage, which does support resuming.
 *
 * The staged copy is named for the role it was built for. Two roles see two
 * different archives of the same site, and one name for both would eventually
 * hand a reader an owner's copy.
 */
async function handler(request, context) {
    const result = await gate({ store: blobStore(), request, log: context });
    if (result.denied) return result.denied;

    const posts = presentPosts(result.posts, result.role);
    const name = `${result.slug}/${result.role}.zip`;

    const { stream, done } = buildArchive({
        store: blobStore(),
        slug: result.slug,
        posts,
        exportedAt: new Date().toISOString(),
        log: context
    });

    // buildArchive closes its stream only on success, so a build that throws
    // would leave the upload waiting for bytes that are never coming. Destroy
    // it deliberately, which turns that wait into a rejection.
    //
    // Destroyed with no argument on purpose. Handing destroy an error makes
    // the stream emit one, and a stream emitting an error nobody is listening
    // for is a hard crash -- which is exactly the situation here if the upload
    // has already failed and stopped reading. The real reason is rethrown
    // instead, where it is caught rather than thrown at the process.
    const built = done.catch((error) => {
        stream.destroy();
        throw error;
    });

    const upload = blobStore().uploadStream(EXPORTS, name, stream, {
        contentType: 'application/zip',
        // Names the archive after the missionary, so a folder of these is
        // still legible a decade from now. Set on the blob rather than on the
        // link, so it cannot be changed by editing the URL.
        contentDisposition: `attachment; filename="${result.slug}-letters.zip"`
    });

    // allSettled, not all: when one of these fails the other is about to fail
    // too, and `all` would hand back the first rejection while the second was
    // still in flight -- an unhandled rejection arriving after the request had
    // already been answered, which on this runtime takes the whole worker down
    // rather than the one download.
    const outcomes = await Promise.allSettled([upload, built]);
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');

    if (failure) {
        // Nothing has been sent yet, so unlike the streaming version this can
        // still be an honest status code rather than a truncated file that
        // looks like a successful download until someone tries to open it.
        context.error('archive.failed', { slug: result.slug, error: failure.reason?.message });
        return {
            status: 500,
            headers: hardened({ 'Cache-Control': 'no-store' }),
            body: 'Could not build the archive. Please try again.'
        };
    }

    const url = await blobStore().readUrl(EXPORTS, name, { minutes: LINK_MINUTES });

    context.log('archive.staged', { slug: result.slug, role: result.role });

    return {
        status: 302,
        headers: hardened({
            Location: url,
            // The link expires, so nothing may keep this response. Without it a
            // browser could reuse a dead redirect and the download would fail
            // with an XML error from storage that means nothing to anyone.
            'Cache-Control': 'no-store'
        })
    };
}

app.http('download', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'download/{slug}/letters.zip',
    handler
});
