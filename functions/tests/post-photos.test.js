// The two endpoints an owner uses to put a picture on a letter and take it
// back off.
//
// The transcoder and the storage layout are tested in render.test.js. What is
// checked here is everything around them: who is allowed, what happens to
// bytes that are not a photograph, and the one rule the whole feature rests on
// -- that a picture which arrived with the letter cannot be removed this way.
// That rule is the difference between an owner tidying up their own additions
// and an owner silently editing what a missionary sent.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { addPhoto, removePhoto } from '../src/functions/post.js';
import { memoryStore } from './memory-store.js';
import { ROLE } from '../src/lib/acl.js';
import { MAX_UPLOAD_BYTES } from '../src/lib/photos.js';

const SLUG = 'elder.example';
const POST = '2026-03-25-9CRE';
const MUM = 'mum@example.com';
const GRAN = 'gran@example.com';

const MEMBERS = [
    { email: MUM, role: ROLE.owner },
    { email: GRAN, role: ROLE.reader }
];

const silent = { log() {}, info() {}, warn() {}, error() {} };

const header = (email) =>
    Buffer.from(JSON.stringify({ userDetails: email, identityProvider: 'aad' })).toString('base64');

/** A picture of a given size, as a browser would send one. */
const picture = (width = 900, height = 600, background = '#336699') =>
    sharp({ create: { width, height, channels: 3, background } }).jpeg().toBuffer();

const request = ({ as, type = 'image/jpeg', bytes = Buffer.alloc(0), postId = POST, photoId }) => ({
    headers: {
        get: (name) => {
            if (name === 'x-ms-client-principal') return as ? header(as) : null;
            if (name === 'content-type') return type;
            return null;
        }
    },
    params: { slug: SLUG, postId, photoId },
    url: `https://pdayletters.com/api/posts/${SLUG}/${postId}/photos`,
    // A Buffer's own bytes, not its backing pool: `Buffer.alloc` hands out
    // slices of a shared ArrayBuffer, and sending the whole thing would upload
    // several kilobytes of somebody else's test data.
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
});

/** An archive with one letter, carrying whatever photos a test needs. */
async function seeded(photos = []) {
    const store = memoryStore();
    store.acl(SLUG, MEMBERS);
    await store.writeBlob(
        'rendered',
        `${SLUG}/posts.json`,
        Buffer.from(JSON.stringify([{ id: POST, subject: 'Antigua at last', bodyHtml: '<p>Hola</p>', photos }]), 'utf8')
    );
    return store;
}

const posted = (store, options) => addPhoto({ request: request(options), context: silent, store });
const dropped = (store, options) => removePhoto({ request: request(options), context: silent, store });

const photosOf = (store) => store.json('rendered', `${SLUG}/posts.json`)[0].photos;

describe('adding a picture', () => {
    test('an owner gets a stored photo, stamped with when it was added', async () => {
        const store = await seeded();

        const response = await posted(store, { as: MUM, bytes: await picture() });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.added, true);

        const photos = photosOf(store);
        assert.equal(photos.length, 1);
        assert.equal(photos[0].id, response.jsonBody.photo);
        assert.equal(photos[0].width, 900);
        // The stamp is the whole of what distinguishes these from the
        // attachments, on the server and in the reader alike.
        assert.match(photos[0].addedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.ok(store.blobs.has(`rendered/${SLUG}/photos/${photos[0].id}/large.webp`));
        assert.ok(store.blobs.has(`rendered/${SLUG}/photos/${photos[0].id}/thumb.webp`));
    });

    test('the new picture goes on the end, behind the ones that arrived', async () => {
        // Which is what puts it at the bottom of the album: the reader draws
        // the list in order and invents no grouping of its own.
        const store = await seeded([{ id: 'p_fromthemessage', width: 100, height: 100 }]);

        await posted(store, { as: MUM, bytes: await picture() });

        const photos = photosOf(store);
        assert.equal(photos[0].id, 'p_fromthemessage');
        assert.equal(photos[1].addedAt !== undefined, true);
    });

    test('a reader is refused and nothing is written', async () => {
        const store = await seeded();
        const before = store.blobs.size;

        const response = await posted(store, { as: GRAN, bytes: await picture() });

        assert.equal(response.status, 403);
        assert.equal(photosOf(store).length, 0);
        assert.equal(store.blobs.size, before, 'no rendition should have been written');
    });

    test('a signed-out visitor is refused', async () => {
        const store = await seeded();
        assert.equal((await posted(store, { bytes: await picture() })).status, 401);
    });

    test('a document is turned away on its content type, before any decoding', async () => {
        const store = await seeded();

        const response = await posted(store, {
            as: MUM,
            type: 'application/pdf',
            bytes: Buffer.from('%PDF-1.4')
        });

        assert.equal(response.status, 415);
        assert.equal(photosOf(store).length, 0);
    });

    test('bytes that claim to be a photo but are not get a 415 too', async () => {
        // The type header is a courtesy; this is the check that matters, and
        // it is the transcoder making it rather than anything here.
        const store = await seeded();

        const response = await posted(store, { as: MUM, bytes: Buffer.from('not an image at all') });

        assert.equal(response.status, 415);
        assert.equal(photosOf(store).length, 0);
    });

    test('an empty body is a 400, not a 415', async () => {
        const store = await seeded();
        assert.equal((await posted(store, { as: MUM })).status, 400);
    });

    test('an oversized picture is refused without being decoded', async () => {
        const store = await seeded();

        const response = await posted(store, { as: MUM, bytes: Buffer.alloc(MAX_UPLOAD_BYTES + 1) });

        assert.equal(response.status, 413);
        assert.equal(photosOf(store).length, 0);
    });

    test('a post that does not exist is a 404', async () => {
        const store = await seeded();
        const before = store.blobs.size;

        const response = await posted(store, { as: MUM, postId: 'no-such-post', bytes: await picture() });

        assert.equal(response.status, 404);
        assert.equal(store.blobs.size, before, 'refuse before spending a transcode');
    });

    test('sending the same picture twice adds it once', async () => {
        // The id is the hash of the bytes, so the second request finds itself
        // already there. Reported as a 200 with `added: false` rather than a
        // conflict: nothing went wrong, and the picture the owner wanted on
        // the letter is on the letter.
        const store = await seeded();
        const bytes = await picture();

        const first = await posted(store, { as: MUM, bytes });
        const second = await posted(store, { as: MUM, bytes });

        assert.equal(first.jsonBody.added, true);
        assert.equal(second.status, 200);
        assert.equal(second.jsonBody.added, false);
        assert.equal(photosOf(store).length, 1);
    });

    test('a letter that is already full refuses the next one', async () => {
        const full = Array.from({ length: 24 }, (unused, index) => ({
            id: `p_added${index}`,
            width: 10,
            height: 10,
            addedAt: '2026-08-05T10:00:00.000Z'
        }));
        const store = await seeded(full);

        const response = await posted(store, { as: MUM, bytes: await picture() });

        assert.equal(response.status, 409);
        assert.equal(photosOf(store).length, 24);
    });

    test('the cap counts only what an owner added', async () => {
        // A forward with thirty attachments is a letter, not an abuse of the
        // upload endpoint, and it must not lock its own owner out.
        const many = Array.from({ length: 30 }, (unused, index) => ({
            id: `p_attached${index}`,
            width: 10,
            height: 10
        }));
        const store = await seeded(many);

        assert.equal((await posted(store, { as: MUM, bytes: await picture() })).status, 200);
    });
});

describe('taking a picture back off', () => {
    const ADDED = { id: 'p_addedbyowner', width: 800, height: 600, addedAt: '2026-08-05T10:00:00.000Z' };
    const ARRIVED = { id: 'p_fromthemessage', width: 800, height: 600 };

    test('an owner can remove one they added', async () => {
        const store = await seeded([ARRIVED, ADDED]);

        const response = await dropped(store, { as: MUM, photoId: ADDED.id });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.removed, true);
        assert.deepEqual(photosOf(store), [ARRIVED]);
    });

    test('a picture that came with the letter is refused', async () => {
        // The rule the endpoint exists to hold. Removing one of these is what
        // `Restore original` is for, and that asks first.
        const store = await seeded([ARRIVED, ADDED]);

        const response = await dropped(store, { as: MUM, photoId: ARRIVED.id });

        assert.equal(response.status, 403);
        assert.equal(photosOf(store).length, 2);
    });

    test('removing one twice is not an error the second time', async () => {
        const store = await seeded([ADDED]);

        await dropped(store, { as: MUM, photoId: ADDED.id });
        const again = await dropped(store, { as: MUM, photoId: ADDED.id });

        assert.equal(again.status, 200);
        assert.equal(again.jsonBody.removed, false);
        assert.equal(photosOf(store).length, 0);
    });

    test('a reader is refused', async () => {
        const store = await seeded([ADDED]);

        assert.equal((await dropped(store, { as: GRAN, photoId: ADDED.id })).status, 403);
        assert.equal(photosOf(store).length, 1);
    });

    test('an unknown post is a 404', async () => {
        const store = await seeded([ADDED]);

        const response = await dropped(store, { as: MUM, postId: 'no-such-post', photoId: ADDED.id });

        assert.equal(response.status, 404);
    });
});
