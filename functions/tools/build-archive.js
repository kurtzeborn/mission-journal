// Build a real archive from the live account and write it to disk.
//
// Not a test -- a way to open the thing a family would actually download and
// look at it. The offline reader's whole design rests on claims about what
// browsers refuse to do over file://, and those are worth checking against a
// browser rather than against my memory of the spec.
//
//   node tools/build-archive.js isaac.backman owner "$env:TEMP\letters.zip"

import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createBlobStore } from '../src/lib/store.js';
import { presentPosts } from '../src/lib/present.js';
import { buildArchive } from '../src/lib/archive.js';

const [slug, role = 'owner', out = 'letters.zip'] = process.argv.slice(2);
if (!slug) throw new Error('usage: build-archive.js <slug> [role] [outfile]');

const account = process.env.STORAGE_ACCOUNT_NAME;
if (!account) throw new Error('set STORAGE_ACCOUNT_NAME');

const store = createBlobStore({ accountName: account });

const blob = await store.readBlob('rendered', `${slug}/posts.json`);
if (!blob) throw new Error(`no rendered posts for ${slug}`);

const posts = presentPosts(JSON.parse(Buffer.from(blob.bytes).toString('utf8')), role);
console.log(`${posts.length} posts as ${role}`);

const { stream, done } = buildArchive({
    store,
    slug,
    posts,
    exportedAt: new Date().toISOString(),
    log: console
});

await Promise.all([pipeline(stream, createWriteStream(out)), done]);
console.log(`wrote ${out}`);
