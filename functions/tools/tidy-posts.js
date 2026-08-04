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
//   node tools/tidy-posts.js <slug>            # report only
//   node tools/tidy-posts.js <slug> --apply    # write
//
// Requires STORAGE_ACCOUNT_NAME and a signed-in Azure identity.

import sanitizeHtmlLib from 'sanitize-html';
import { createBlobStore } from '../src/lib/store.js';
import { commitPosts } from '../src/lib/edit.js';
import { sanitizeBody, PHOTO_PREFIX } from '../src/lib/sanitize.js';

const [, , slug, ...flags] = process.argv;
const apply = flags.includes('--apply');

if (!slug) {
    console.error('usage: node tools/tidy-posts.js <slug> [--apply]');
    process.exit(2);
}

// The visible words of a letter, with every tag and all spacing removed. This
// is the safety net: this tool is only ever allowed to remove empty markup, so
// if a post's words change it has done something it was not asked to do.
const words = (html) =>
    sanitizeHtmlLib(String(html ?? ''), { allowedTags: [], allowedAttributes: {} })
        .replace(/\s+/g, '')
        .trim();

const pictures = (html) => (String(html ?? '').match(/<img\b/gi) ?? []).length;

const store = createBlobStore({ accountName: process.env.STORAGE_ACCOUNT_NAME });

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

            if (after === before) return post;

            // Refuse the whole run rather than the one letter. A body that
            // loses words or pictures means the sanitizer is doing something
            // this tool did not predict, and the rest of the batch is no
            // longer trustworthy either.
            if (words(after) !== words(before) || pictures(after) !== pictures(before)) {
                refused.push(post.id);
                return post;
            }

            rows.push({
                id: post.id,
                bytes: before.length - after.length,
                blocks:
                    (before.match(/<(p|div|span)\b/gi) ?? []).length -
                    (after.match(/<(p|div|span)\b/gi) ?? []).length
            });

            // bodyText is left alone deliberately: no words changed, so the
            // plain-text copy is still an accurate rendering of this letter.
            // editedBy/editedAt are left alone too -- nobody edited anything,
            // and claiming otherwise would put a person's name on a
            // maintenance pass.
            return { ...post, bodyHtml: after };
        });

        if (refused.length) return { error: `refusing to write: ${refused.join(', ')}` };
        if (!apply) return { error: 'dry run' };
        return { posts: next };
    }
});

for (const row of rows) {
    console.log(`${row.id}  -${String(row.bytes).padStart(5)} bytes  -${row.blocks} blocks`);
}

const total = rows.reduce((sum, row) => sum + row.bytes, 0);
console.log(`\n${rows.length} letters would change, ${total} bytes of empty markup`);

if (outcome?.error && outcome.error !== 'dry run') {
    console.error(`\n${outcome.error}`);
    process.exit(1);
}
console.log(apply ? 'written' : 'dry run -- pass --apply to write');
