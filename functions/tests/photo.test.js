// Serving one picture.
//
// The transcoder that produces these blobs is tested in render.test.js and the
// visibility rules in present.test.js. What is checked here is the endpoint
// itself: that a held letter's photos are unreachable by URL, and that a
// browser coming back for a picture it already holds is answered without the
// picture being read out of storage.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { servePhoto } from '../src/functions/photo.js';
import { memoryStore } from './memory-store.js';
import { ROLE } from '../src/lib/acl.js';

const SLUG = 'elder.example';
const POST = '2026-03-25-9CRE';
const PHOTO = 'p_0123456789ab';
const MUM = 'mum@example.com';
const GRAN = 'gran@example.com';

const MEMBERS = [
    { email: MUM, role: ROLE.owner },
    { email: GRAN, role: ROLE.reader }
];

const silent = { log() {}, info() {}, warn() {}, error() {} };

const header = (email) =>
    Buffer.from(JSON.stringify({ userDetails: email, identityProvider: 'aad' })).toString('base64');

const request = ({ as, photoId = PHOTO, size = 'large', ifNoneMatch = null }) => ({
    headers: {
        get: (name) => {
            if (name === 'x-ms-client-principal') return as ? header(as) : null;
            if (name === 'if-none-match') return ifNoneMatch;
            return null;
        }
    },
    params: { slug: SLUG, photoId, size },
    url: `https://pdayletters.com/api/photo/${SLUG}/${photoId}/${size}.webp`
});

/** An archive with one letter carrying one picture, and the blobs behind it. */
async function seeded({ hidden = false } = {}) {
    const store = memoryStore();
    store.acl(SLUG, MEMBERS);
    const post = { id: POST, subject: 'Antigua at last', bodyHtml: '<p>Hola</p>', photos: [{ id: PHOTO }] };
    if (hidden) post.hidden = true;
    await store.writeBlob('rendered', `${SLUG}/posts.json`, Buffer.from(JSON.stringify([post]), 'utf8'));
    for (const size of ['large', 'thumb']) {
        await store.writeBlob('rendered', `${SLUG}/photos/${PHOTO}/${size}.webp`, Buffer.from(`${size}-bytes`, 'utf8'));
    }
    return store;
}

const fetched = (store, options) => servePhoto({ request: request(options), context: silent, store });

describe('serving a picture', () => {
    test('a reader gets the bytes, tagged with what they are', async () => {
        const store = await seeded();

        const response = await fetched(store, { as: GRAN });

        assert.equal(response.status, 200);
        assert.equal(response.headers['Content-Type'], 'image/webp');
        assert.equal(response.headers.ETag, `"${PHOTO}-large"`);
        assert.equal(Buffer.from(response.body).toString('utf8'), 'large-bytes');
    });

    test('the tag names the size, so two renderings never share one', async () => {
        const store = await seeded();

        const large = await fetched(store, { as: GRAN, size: 'large' });
        const thumb = await fetched(store, { as: GRAN, size: 'thumb' });

        assert.notEqual(large.headers.ETag, thumb.headers.ETag);
    });

    test('a stranger is refused', async () => {
        const store = await seeded();

        const response = await fetched(store, { as: 'nobody@example.com' });

        assert.equal(response.status, 404);
    });

    test('a picture on a held letter is not fetchable by URL', async () => {
        const store = await seeded({ hidden: true });

        const response = await fetched(store, { as: GRAN });

        assert.equal(response.status, 404);
    });
});

describe('coming back for a picture already held', () => {
    test('the tag it was given earns a 304 with no picture', async () => {
        const store = await seeded();

        const response = await fetched(store, { as: GRAN, ifNoneMatch: `"${PHOTO}-large"` });

        assert.equal(response.status, 304);
        assert.equal(response.headers.ETag, `"${PHOTO}-large"`);
        assert.equal(response.body, undefined);
    });

    test('the picture is never read out of storage to answer one', async () => {
        // The saving is the whole reason the tag is derived from the id rather
        // than from the blob: revalidating costs no read of the image at all.
        const store = await seeded();
        const reads = [];
        const watched = { ...store, readBlob: (container, name) => (reads.push(name), store.readBlob(container, name)) };

        await servePhoto({
            request: request({ as: GRAN, ifNoneMatch: `"${PHOTO}-large"` }),
            context: silent,
            store: watched
        });

        assert.ok(!reads.some((name) => name.includes('/photos/')));
    });

    test('a tag from another size is not a match', async () => {
        const store = await seeded();

        const response = await fetched(store, { as: GRAN, ifNoneMatch: `"${PHOTO}-thumb"` });

        assert.equal(response.status, 200);
        assert.equal(Buffer.from(response.body).toString('utf8'), 'large-bytes');
    });

    test('a held letter is refused even when the tag matches', async () => {
        const store = await seeded({ hidden: true });

        const response = await fetched(store, { as: GRAN, ifNoneMatch: `"${PHOTO}-large"` });

        assert.equal(response.status, 404);
    });
});
