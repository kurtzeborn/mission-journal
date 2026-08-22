// Re-render letters whose pictures did not all survive the first pass.
//
// `raw/` is the archive and every rendition is derived from it, so a decoder
// fix reaches history only by running the messages through again. A photo the
// pipeline could not read was logged and skipped, and the letter published
// without it -- silently, from the owner's side.
//
// This compares what each message carries against what its letter shows, and
// tries the missing ones through the transcoder as it stands today. A picture
// that fails again is furniture, or genuinely broken, and the letter is left
// alone; one that now succeeds means the letter is short and gets re-rendered.
// The work is done by the render queue rather than here, so what fixes the
// archive is the deployed pipeline and not this laptop.
//
//   node tools/rerender-posts.js <slug>            # report only
//   node tools/rerender-posts.js <slug> --apply    # enqueue
//
// Requires STORAGE_ACCOUNT_NAME and a signed-in Azure identity.

import { createBlobStore } from '../src/lib/store.js';
import { extractOriginal } from '../src/lib/extract.js';
import { isPhotoType, transcode } from '../src/lib/photos.js';
import { photoId } from '../src/lib/paths.js';

const [, , slug, ...flags] = process.argv;
const apply = flags.includes('--apply');

if (!slug) {
    console.error('usage: node tools/rerender-posts.js <slug> [--apply]');
    process.exit(2);
}

const store = createBlobStore({ accountName: process.env.STORAGE_ACCOUNT_NAME });

const current = await store.readBlob('rendered', `${slug}/posts.json`);
if (!current) {
    console.error(`no posts.json for ${slug}`);
    process.exit(1);
}

const posts = JSON.parse(Buffer.from(current.bytes).toString('utf8'));
const short = [];

for (const post of posts) {
    // Written by ingest as `raw/<slug>/<msgId>/message.eml`. A letter without
    // one was never an email and has no original to re-read.
    const msgId = String(post.sourceRawPath ?? '').split('/')[2];
    if (!msgId) continue;

    const raw = await store.readBlob('raw', `${slug}/${msgId}/message.eml`);
    if (!raw) {
        console.log(`${post.id}  raw message is gone`);
        continue;
    }

    const extracted = await extractOriginal(Buffer.from(raw.bytes));
    const parts = [...(extracted.attachments ?? []), ...(extracted.inlineImages ?? [])]
        .filter((part) => isPhotoType(part.mimeType));

    const shown = new Set((post.photos ?? []).map((photo) => photo.id));
    const recovered = [];

    for (const part of parts) {
        const bytes = Buffer.from(part.content);
        if (shown.has(photoId(bytes))) continue;

        // The same decision the pipeline makes, so a signature icon that was
        // rightly refused for being too small is refused again here and does
        // not count as a loss.
        if (await transcode(bytes)) {
            recovered.push(`${part.mimeType} ${bytes.length}B`);
        }
    }

    if (!recovered.length) continue;

    short.push({ slug, msgId, postId: post.id });
    console.log(`${post.id}  ${post.subject ?? ''}`);
    for (const line of recovered) console.log(`    + ${line}`);
}

if (!short.length) {
    console.log(`${posts.length} letters, none short`);
    process.exit(0);
}

const noun = short.length === 1 ? 'letter' : 'letters';
if (!apply) {
    console.log(`\n${short.length} ${noun} to re-render. Pass --apply to enqueue.`);
    process.exit(0);
}

for (const message of short) {
    await store.enqueue('render', JSON.stringify(message));
    console.log(`queued ${message.postId}`);
}
