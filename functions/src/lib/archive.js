// Building the downloadable archive.
//
// The zip is a portable copy of the site: the same reader, the same letters,
// the same photos, opened from a folder with no network at all. Three rules
// shape it, and all three are load-bearing.
//
// It is built from the payload presentPosts() already produced, so hidden
// letters are absent for a reader and present for an owner without this file
// knowing either rule exists. A second filter here would be a second thing to
// get right, and the one that got it wrong would fail silently in the
// direction of disclosure.
//
// raw/ is never bundled, at any role. The export is a copy of rendered/; raw
// email does not leave the service.
//
// Photos are stored rather than deflated. They are already WebP, so deflate
// spends CPU proportional to the whole archive to save approximately nothing.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const yazl = require('yazl');

const asset = (name) => readFileSync(new URL(`../assets/reader/${name}`, import.meta.url));

// Read once per process rather than per download. Together they are about
// 100 KB, and every archive contains the same bytes.
const ASSETS = {
    'index.html': asset('index.html'),
    'reader.js': asset('reader.js'),
    'offline.js': asset('offline.js'),
    'styles.css': asset('styles.css'),
    'logo.png': asset('logo.png'),
    'minisearch.js': asset('minisearch.js'),
    'wordcloud2.js': asset('wordcloud2.js')
};

// A fixed timestamp on every entry. Zip entries carry an mtime, and using the
// current clock would make two exports of an unchanged archive differ byte for
// byte -- which makes them impossible to compare and impossible to test.
const FIXED_MTIME = new Date('2026-01-01T00:00:00Z');

const SIZES = ['large', 'thumb'];

// How much finished zip we let pile up in memory before reading another photo.
// Without a limit the loop below reads every photo as fast as storage serves
// them, and a full mission is 400-500 MB against an instance that has 2 GB for
// everything. With it, memory is one photo plus this.
const BACKPRESSURE_BYTES = 8 * 1024 * 1024;

const stall = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Every photo blob the presented posts refer to, both renditions.
 *
 * Derived from the posts rather than by listing the container: listing would
 * return photos belonging to letters this caller is not entitled to, and the
 * only thing standing between those and the zip would be a filter written
 * here. Deriving it means an unentitled photo is never even named.
 */
export function photoEntries(posts) {
    const entries = [];
    const seen = new Set();

    for (const post of posts) {
        for (const photo of post.photos ?? []) {
            for (const size of SIZES) {
                const name = `${photo.id}/${size}.webp`;
                if (seen.has(name)) continue;
                seen.add(name);
                entries.push({ photoId: photo.id, size, name });
            }
        }
    }
    return entries;
}

/**
 * The text half of the archive, as name -> Buffer.
 *
 * Split out from the streaming half because it is pure: given a payload it
 * always produces the same bytes, which is what makes it testable without a
 * storage account.
 */
export function textEntries({ slug, posts, exportedAt }) {
    const payload = { slug, posts, exportedAt };

    // archive.js is loaded with <script src>, not inlined, so a letter
    // containing the characters "</script>" cannot break out of it. Escaped
    // anyway: the cost is nothing, and the day someone inlines this to save a
    // request is the day that stops being true.
    const json = JSON.stringify(payload, null, 2).replace(/</g, '\\u003c');

    return {
        ...ASSETS,
        'archive.js': Buffer.from(`window.__ARCHIVE__ = ${json};\n`, 'utf8'),
        // The same payload again, as data. It is what the plan promises in the
        // zip and what anyone doing something else with their letters will
        // reach for -- the reader cannot use it, because fetch() is blocked on
        // file:// URLs. Two serializations of one object, so they cannot drift.
        'posts.json': Buffer.from(JSON.stringify(posts, null, 2), 'utf8')
    };
}

/**
 * Assemble the archive and start streaming it.
 *
 * Returns immediately with the zip's output stream; photos are read and
 * appended in the background as the consumer drains it.
 *
 * @returns {{stream: import('node:stream').Readable, done: Promise<void>}}
 */
export function buildArchive({ store, slug, posts, exportedAt, log }) {
    const zip = new yazl.ZipFile();

    for (const [name, bytes] of Object.entries(textEntries({ slug, posts, exportedAt }))) {
        zip.addBuffer(bytes, name, { mtime: FIXED_MTIME, mode: 0o100644 });
    }

    const photos = photoEntries(posts);

    const done = (async () => {
        for (const entry of photos) {
            // One at a time, and only once the consumer has taken what we
            // already produced. Adding all of them up front would hold the
            // entire archive in memory, because addBuffer keeps the buffer
            // until the entry is written.
            while (zip.outputStream.readableLength > BACKPRESSURE_BYTES) {
                await stall();
            }

            let blob;
            try {
                blob = await store.readBlob('rendered', `${slug}/photos/${entry.name}`);
            } catch (error) {
                blob = null;
                log?.warn?.('archive.photoReadFailed', { slug, name: entry.name, error: error.message });
            }

            // A missing rendition is not worth failing the download over. The
            // alternatives are no archive at all or an archive one photo
            // short, and the second is plainly better for the person waiting
            // on it. It is also the rarer half of the problem: the photo is
            // still in `raw/`, so a re-render fixes it later.
            if (!blob) continue;

            zip.addBuffer(Buffer.from(blob.bytes), `photos/${entry.name}`, {
                mtime: FIXED_MTIME,
                mode: 0o100644,
                // Stored, not deflated. See the header.
                compress: false
            });
        }

        zip.end();
    })();

    return { stream: zip.outputStream, done };
}
