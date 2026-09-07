// Re-run the sanitizer over every stored letter for a site.
//
// The sanitizer only runs on the way into `rendered/`, so a change to it
// leaves already-published letters as they were. This replays it. It is the
// same function the ingest and edit paths call, so it converges: running it
// twice changes nothing the second time.
//
// Reads nothing from the network but blob storage, and writes under the
// blob's ETag through the same commit path an owner edit uses, so a letter
// arriving mid-run cannot be lost.
//
// One exception, and it is the only one: the album strip in album.js removes
// words a missionary wrote -- the link, and the label that introduced it. That
// is the single sanction to change a letter's visible text, it is spelled out
// in the guard below, and anything else that moves a word still refuses the
// whole run. If a second exception is ever wanted, argue for it here rather
// than widening the guard.
//
//   node tools/tidy-posts.js <slug>            # report only
//   node tools/tidy-posts.js <slug> --apply    # write
//
// Requires STORAGE_ACCOUNT_NAME and a signed-in Azure identity.

import sanitizeHtmlLib from 'sanitize-html';
import { createBlobStore } from '../src/lib/store.js';
import { createTableStore } from '../src/lib/tables.js';
import { commitPosts } from '../src/lib/edit.js';
import { albumUrls, stripAlbumLinks } from '../src/lib/album.js';
import { recordAlbumUrls } from '../src/lib/sites.js';
import { sanitizeBody, PHOTO_PREFIX } from '../src/lib/sanitize.js';

const [, , slug, ...flags] = process.argv;
const apply = flags.includes('--apply');

if (!slug) {
    console.error('usage: node tools/tidy-posts.js <slug> [--apply]');
    process.exit(2);
}

// The visible words of a letter, with every tag and all spacing removed. This
// is the safety net: apart from the album strip named at the top of this file,
// this tool is only ever allowed to remove empty markup, so if a post's words
// change beyond that it has done something it was not asked to do.
const words = (html) =>
    sanitizeHtmlLib(String(html ?? ''), { allowedTags: [], allowedAttributes: {} })
        .replace(/\s+/g, '')
        .trim();

const pictures = (html) => (String(html ?? '').match(/<img\b/gi) ?? []).length;

const accountName = process.env.STORAGE_ACCOUNT_NAME;
const store = createBlobStore({ accountName });
const tables = createTableStore({ accountName });

// Captured before a single letter is touched. The album link survives in
// `raw/` regardless, but the site row is the copy anyone will actually be able
// to find, and writing it after the strip would mean a run that failed halfway
// had already thrown away the easy answer.
const current = await store.readBlob('rendered', `${slug}/posts.json`);
if (!current) {
    console.error(`no posts.json for ${slug}`);
    process.exit(1);
}

const albums = [
    ...new Set(
        JSON.parse(Buffer.from(current.bytes).toString('utf8')).flatMap((post) =>
            albumUrls(post.bodyHtml ?? post.bodyText ?? '')
        )
    )
].sort();

if (albums.length) {
    console.log(`albums: ${albums.join(', ')}\n`);
    if (apply) await recordAlbumUrls({ tables, slug, urls: albums });
}

const rows = [];
const refused = [];

const outcome = await commitPosts({
    store,
    slug,
    mutate: (posts) => {
        rows.length = 0;
        refused.length = 0;

        const next = posts.map((post) => {
            const before = post.bodyHtml ?? '';
            const after = sanitizeBody(before, {
                keepPhotoPrefix: `${PHOTO_PREFIX}${slug}/`
            });

            // Only to report what is going, using the same function that
            // takes it. The sanitizer has already applied the strip above.
            const removals = [];
            stripAlbumLinks(before, { onRemove: (removed) => removals.push(removed) });

            // A letter that never rendered is served from bodyText, which no
            // sanitizer pass touches. Without this the link would survive in
            // exactly the letters nobody has looked at.
            const text = stripAlbumLinks(post.bodyText ?? null);

            // The retired detection flag. Dropped here rather than left to rot,
            // because a field nothing writes and nothing reads is a question
            // somebody has to answer again in a year.
            const { linkedPhotoServices, ...kept } = post;

            const changed =
                after !== before ||
                text !== (post.bodyText ?? null) ||
                linkedPhotoServices !== undefined;
            if (!changed) return post;

            // Refuse the whole run rather than the one letter. A body that
            // loses words or pictures means the sanitizer is doing something
            // this tool did not predict, and the rest of the batch is no
            // longer trustworthy either. Album links and their labels are
            // measured out of the comparison rather than waived: they are
            // allowed to go, and nothing else is.
            if (
                words(after) !== words(stripAlbumLinks(before)) ||
                pictures(after) !== pictures(before)
            ) {
                refused.push(post.id);
                return post;
            }

            rows.push({
                id: post.id,
                bytes: before.length - after.length,
                blocks:
                    (before.match(/<(p|div|span)\b/gi) ?? []).length -
                    (after.match(/<(p|div|span)\b/gi) ?? []).length,
                removals
            });

            // editedBy/editedAt are left alone deliberately -- nobody edited
            // anything, and claiming otherwise would put a person's name on a
            // maintenance pass. Fields absent from the record stay absent:
            // writing an empty bodyHtml onto a text-only letter would invent
            // one, and the reader treats present-and-empty as a rendered blank.
            const rebuilt = { ...kept };
            if (post.bodyHtml != null) rebuilt.bodyHtml = after;
            if (post.bodyText != null) rebuilt.bodyText = text;
            return rebuilt;
        });

        if (refused.length) return { error: `refusing to write: ${refused.join(', ')}` };
        if (!apply) return { error: 'dry run' };
        return { posts: next };
    }
});

for (const row of rows) {
    console.log(`${row.id}  -${String(row.bytes).padStart(5)} bytes  -${row.blocks} blocks`);
    for (const removed of row.removals) {
        console.log(`             label: ${removed.label || '(none -- link only)'}`);
    }
}

const total = rows.reduce((sum, row) => sum + row.bytes, 0);
console.log(`\n${rows.length} letters would change, ${total} bytes`);

if (outcome?.error && outcome.error !== 'dry run') {
    console.error(`\n${outcome.error}`);
    process.exit(1);
}
console.log(apply ? 'written' : 'dry run -- pass --apply to write');
