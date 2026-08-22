// The downloadable archive.
//
// The interesting assertions here are not that a zip appears -- it is that the
// zip is genuinely readable by a zip reader that is not the one that wrote it,
// that a held letter's photos are absent from a reader's copy, and that the
// offline reader in it is the site's reader rather than a copy that has
// drifted away from it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { memoryStore } from './memory-store.js';
import { buildArchive, photoEntries, textEntries } from '../src/lib/archive.js';
import { presentPosts } from '../src/lib/present.js';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const assets = join(here, '..', 'src', 'assets', 'reader');

const SLUG = 'isaac.backman';

const POSTS = [
    {
        id: '2025-12-01-FRSN',
        originalDate: '2025-12-01T10:07:00',
        subject: 'Thanksgiving',
        bodyHtml: '<p>We ate with a family here.</p><img src="/api/photo/isaac.backman/p_aaaaaaaaaaaa/large.webp">',
        photos: [{ id: 'p_aaaaaaaaaaaa', width: 100, height: 80 }]
    },
    {
        id: '2025-11-10-ZHCM',
        originalDate: '2025-11-10T05:57:00',
        subject: 'Week one',
        bodyHtml: '<p>Arrived safely.</p>',
        hidden: true,
        heldReason: 'unverified-original',
        photos: [{ id: 'p_bbbbbbbbbbbb', width: 100, height: 80 }]
    }
];

function seed() {
    const store = memoryStore();
    for (const id of ['p_aaaaaaaaaaaa', 'p_bbbbbbbbbbbb']) {
        for (const size of ['large', 'thumb']) {
            store.blobs.set(`rendered/${SLUG}/photos/${id}/${size}.webp`, {
                bytes: Buffer.from(`fake-webp-${id}-${size}`),
                metadata: {},
                etag: 'e1'
            });
        }
    }
    return store;
}

async function collect(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

// Opened with yauzl rather than by inspecting bytes: the point of the test is
// that an independent reader can parse what we wrote.
function unzip(buffer) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
            if (err) return reject(err);
            const files = new Map();
            zip.on('entry', (entry) => {
                zip.openReadStream(entry, (streamErr, stream) => {
                    if (streamErr) return reject(streamErr);
                    const chunks = [];
                    stream.on('data', (c) => chunks.push(c));
                    stream.on('end', () => {
                        files.set(entry.fileName, {
                            bytes: Buffer.concat(chunks),
                            compression: entry.compressionMethod
                        });
                        zip.readEntry();
                    });
                });
            });
            zip.on('end', () => resolve(files));
            zip.on('error', reject);
            zip.readEntry();
        });
    });
}

async function archiveFor(role) {
    const store = seed();
    const posts = presentPosts(POSTS, role);
    const { stream, done } = buildArchive({
        store,
        slug: SLUG,
        posts,
        exportedAt: '2026-08-03T00:00:00.000Z'
    });
    const [buffer] = await Promise.all([collect(stream), done]);
    return { files: await unzip(buffer), posts };
}

describe('what goes into the archive', () => {
    test('a reader gets a zip an independent reader can open', async () => {
        const { files } = await archiveFor('reader');

        for (const name of [
            'index.html',
            'reader.js',
            'offline.js',
            'styles.css',
            'logo.png',
            'minisearch.js',
            'wordcloud2.js',
            'archive.js',
            'posts.json'
        ]) {
            assert.ok(files.has(name), `${name} is missing from the archive`);
        }
    });

    test('raw email is never bundled, at any role', async () => {
        for (const role of ['reader', 'owner']) {
            const { files } = await archiveFor(role);
            const raw = [...files.keys()].filter((name) => name.includes('raw'));
            assert.deepEqual(raw, [], `raw content leaked into the ${role} archive`);
        }
    });

    test('a held letter and its photos are absent from a reader archive', async () => {
        const { files } = await archiveFor('reader');

        const data = files.get('archive.js').bytes.toString('utf8');
        assert.ok(!data.includes('Arrived safely'), 'the held letter is in the offline data');
        assert.ok(data.includes('We ate with a family'));

        assert.ok(!files.has('photos/p_bbbbbbbbbbbb/large.webp'), 'a held photo was bundled');
        assert.ok(files.has('photos/p_aaaaaaaaaaaa/large.webp'));
    });

    test('an owner archive carries the held letter and its photos', async () => {
        const { files } = await archiveFor('owner');

        assert.ok(files.get('archive.js').bytes.toString('utf8').includes('Arrived safely'));
        assert.ok(files.has('photos/p_bbbbbbbbbbbb/large.webp'));
        assert.ok(files.has('photos/p_bbbbbbbbbbbb/thumb.webp'));
    });

    test('photos are stored, not deflated', async () => {
        const { files } = await archiveFor('owner');
        // 0 is "stored" in the zip spec; 8 is deflate.
        assert.equal(files.get('photos/p_aaaaaaaaaaaa/large.webp').compression, 0);
    });

    test('a photo missing from storage costs one photo, not the download', async () => {
        const store = seed();
        store.blobs.delete(`rendered/${SLUG}/photos/p_aaaaaaaaaaaa/thumb.webp`);

        const { stream, done } = buildArchive({
            store,
            slug: SLUG,
            posts: presentPosts(POSTS, 'owner'),
            exportedAt: '2026-08-03T00:00:00.000Z'
        });
        const [buffer] = await Promise.all([collect(stream), done]);
        const files = await unzip(buffer);

        assert.ok(!files.has('photos/p_aaaaaaaaaaaa/thumb.webp'));
        assert.ok(files.has('photos/p_aaaaaaaaaaaa/large.webp'));
        assert.ok(files.has('index.html'));
    });
});

describe('the photo manifest', () => {
    test('is derived from the posts, so an unentitled photo is never named', () => {
        const entries = photoEntries(presentPosts(POSTS, 'reader'));
        assert.deepEqual(
            entries.map((e) => e.name).sort(),
            ['p_aaaaaaaaaaaa/large.webp', 'p_aaaaaaaaaaaa/thumb.webp']
        );
    });

    test('a photo shared by two letters is fetched once', () => {
        const shared = [
            { id: 'a', photos: [{ id: 'p_cccccccccccc' }] },
            { id: 'b', photos: [{ id: 'p_cccccccccccc' }] }
        ];
        assert.equal(photoEntries(shared).length, 2);
    });
});

describe('the offline data file', () => {
    test('escapes a letter that contains a closing script tag', () => {
        const entries = textEntries({
            slug: SLUG,
            posts: [{ id: 'x', bodyHtml: '<p>see &lt;/script&gt;</p>' }],
            exportedAt: '2026-08-03T00:00:00.000Z'
        });
        const data = entries['archive.js'].toString('utf8');
        assert.ok(!data.includes('</script'), 'an unescaped closing tag survived');
        assert.ok(data.startsWith('window.__ARCHIVE__ = '));
    });
});

// The offline reader is the site's reader. If that stops being literally true,
// the downloaded copy becomes a second implementation nobody is maintaining --
// so drift fails the build rather than waiting to be noticed in a zip.
describe('the packaged reader is the site reader', () => {
    const shared = [
        [join(repo, 'web', 'reader.js'), join(assets, 'reader.js')],
        [join(repo, 'web', 'styles.css'), join(assets, 'styles.css')],
        [join(repo, 'web', 'logo.png'), join(assets, 'logo.png')],
        [join(repo, 'web', 'vendor', 'minisearch.js'), join(assets, 'minisearch.js')]
    ];

    for (const [source, copy] of shared) {
        test(`${copy.split(/[\\/]/).pop()} matches web/`, () => {
            assert.ok(
                readFileSync(source).equals(readFileSync(copy)),
                'run: node tools/sync-reader-assets.js'
            );
        });
    }
});
