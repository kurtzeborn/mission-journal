// Render pipeline tests.
//
// Driven end-to-end from a real fixture through ingest and then render, using
// the queue message ingest actually emitted. Testing render against a
// hand-built raw/ layout would only prove render agrees with the test author;
// handing it ingest's own output is what proves the two halves agree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { runIngest } from '../src/lib/ingest.js';
import { verifyEmbeddedDkim } from '../src/lib/dkim.js';
import { runRender } from '../src/lib/render.js';
import { sanitizeBody, photoUrl } from '../src/lib/sanitize.js';
import { linkedPhotoServices } from '../src/lib/photolinks.js';
import { transcode, storePhoto, MIN_PHOTO_EDGE, LARGE_EDGE, THUMB_EDGE } from '../src/lib/photos.js';
import { memoryStore } from './memory-store.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const config = { authservId: 'mx.cloudflare.net', missionaryDomains: ['missionary.org'] };
const OWNER = [{ email: 'scott@kurtzeborn.org', role: 'owner' }];
const SLUG = 'elder.example';
const silent = { info() {}, warn() {}, error() {} };

// Scrubbed fixtures cannot produce a DKIM pass, and the verifier stops before
// any key lookup, so nothing here needs the network. Made explicit rather
// than relied on -- see ingest.test.js.
const noNetwork = async (name) => {
    throw new Error(`unit tests must not resolve DNS (asked for ${name})`);
};

// Ingest a fixture, then render whatever ingest queued for it.
async function pipeline(name, ulid = '01TEST0000000000000000000') {
    const store = memoryStore();
    store.acl(SLUG, OWNER);
    store.seed(ulid, await raw(name));

    const ingested = await runIngest({
        ulid,
        store,
        config,
        log: silent,
        now: () => new Date('2026-08-03T12:00:00Z'),
        verifyDkim: (extracted) => verifyEmbeddedDkim(extracted, { resolver: noNetwork })
    });
    assert.equal(ingested.status, 'stored', `${name} did not ingest`);

    const queued = store.queues.get('render') ?? [];
    assert.equal(queued.length, 1, `${name} queued ${queued.length} render jobs`);
    const message = JSON.parse(queued[0]);

    const result = await runRender({ message, store, log: silent });
    return { store, message, result, post: store.json('rendered', `${SLUG}/posts.json`)[0] };
}

// --- sanitizer -------------------------------------------------------------

test('script, style and event handlers do not survive sanitization', () => {
    const html = [
        '<p onclick="steal()">Hello</p>',
        '<script>fetch("/api/acl", {method:"POST"})</script>',
        '<style>body { display: none }</style>',
        '<iframe src="https://evil.example"></iframe>',
        '<form action="https://evil.example"><input name="x"></form>'
    ].join('');

    const out = sanitizeBody(html);
    assert.match(out, /Hello/);
    assert.doesNotMatch(out, /onclick/i);
    assert.doesNotMatch(out, /<script|fetch\(/i);
    // nonTextTags: the CSS must be gone, not flattened into visible prose.
    assert.doesNotMatch(out, /display: none/);
    assert.doesNotMatch(out, /<iframe|<form|<input/i);
});

test('javascript: and data: URLs are removed from links', () => {
    const out = sanitizeBody('<a href="javascript:alert(1)">a</a><a href="data:text/html,x">b</a>');
    assert.doesNotMatch(out, /javascript:|data:/i);

    const safe = sanitizeBody('<a href="https://churchofjesuschrist.org">ok</a>');
    assert.match(safe, /href="https:\/\/churchofjesuschrist\.org"/);
    // No window.opener handle back to an authenticated letters page.
    assert.match(safe, /rel="noopener noreferrer nofollow"/);
});

test('style attributes are stripped even from allowed tags', () => {
    const out = sanitizeBody('<p style="position:fixed;top:0;width:100%;height:100%">x</p>');
    assert.equal(out, '<p>x</p>');
});

test('cid references become photo URLs and everything else loses its image', () => {
    const cidMap = new Map([['abc123@outlook', photoUrl(SLUG, 'p_deadbeef0001', 'large')]]);

    const out = sanitizeBody(
        [
            '<img src="cid:abc123@outlook" alt="street">',
            '<img src="cid:unknown@nowhere" alt="missing">',
            '<img src="https://tracker.example/pixel.gif" width="1" height="1">'
        ].join(''),
        { cidMap }
    );

    assert.match(out, /src="\/api\/photo\/elder\.example\/p_deadbeef0001\/large\.webp"/);
    assert.match(out, /alt="street"/);
    // An unresolved cid and a remote tracking pixel both leave nothing behind.
    assert.doesNotMatch(out, /unknown@nowhere/);
    assert.doesNotMatch(out, /tracker\.example/);
    assert.equal(out.match(/<img/g)?.length, 1);
});

test('angle-bracketed and percent-encoded cids still resolve', () => {
    const cidMap = new Map([['a b@x', photoUrl(SLUG, 'p_1', 'large')]]);
    const out = sanitizeBody('<img src="cid:a%20b@x">', { cidMap });
    assert.match(out, /p_1\/large\.webp/);
});

// --- the quoted header block -----------------------------------------------
//
// An inline forward flattens the original's headers into the body, so the
// missionary's whole distribution list rides along. Measured at 100 and 101
// distinct third-party addresses on two real letters.

const LETTER = 'A week has come and gone like that. It has been a crazy week.';

test('the forwarded header block is removed and the letter is not', () => {
    // The Outlook shape: one div holds the header paragraph *and* the letter.
    // Dropping that div would take the letter with it.
    const html = [
        '<div><div>',
        '<p><b>From:</b> Elder Example &lt;elder.example@missionary.org&gt;<br>',
        '<b>Sent:</b> Monday, November 10, 2025 5:57 AM<br>',
        '<b>To:</b> Aunt One &lt;one@example.com&gt;; two@example.net; three@example.org<br>',
        '<b>Subject:</b> No water</p>',
        `<p>${LETTER}</p>`,
        '</div></div>'
    ].join('');

    const out = sanitizeBody(html, { letterText: LETTER });

    assert.doesNotMatch(out, /one@example\.com/);
    assert.doesNotMatch(out, /two@example\.net/);
    assert.doesNotMatch(out, /three@example\.org/);
    assert.doesNotMatch(out, /Sent:|Subject:/);
    assert.ok(out.includes(LETTER));
});

test('the Gmail attribution block goes too, separator and all', () => {
    const html = [
        '<div>---------- Forwarded message ---------<br>',
        'From: <b>Elder Example</b> &lt;elder.example@missionary.org&gt;<br>',
        'Date: Mon, Nov 10, 2025 at 5:57 AM<br>',
        'Subject: No water<br>',
        'To: &lt;one@example.com&gt;, &lt;two@example.net&gt;<br></div>',
        `<div>${LETTER}</div>`
    ].join('');

    const out = sanitizeBody(html, { letterText: LETTER });

    assert.doesNotMatch(out, /one@example\.com/);
    assert.doesNotMatch(out, /Forwarded message/);
    assert.ok(out.includes(LETTER));
});

test('an address the missionary wrote into the letter survives', () => {
    // Only the client-generated header block is a disclosure. An address in
    // the prose was put there to be read.
    const letter = 'Write to my mum at mum@example.com if you want the recipe.';
    const html = [
        '<p><b>From:</b> Elder Example &lt;elder.example@missionary.org&gt;<br>',
        '<b>Sent:</b> Monday, November 10, 2025 5:57 AM<br>',
        '<b>To:</b> list@example.net<br>',
        '<b>Subject:</b> Hello</p>',
        `<p>${letter}</p>`
    ].join('');

    const out = sanitizeBody(html, { letterText: letter });

    assert.doesNotMatch(out, /list@example\.net/);
    assert.ok(out.includes('mum@example.com'));
});

test('a header block sharing one element with the letter is left alone', () => {
    // Ambiguous, so it keeps the headers rather than risking the letter.
    const html = `<p><b>From:</b> a@x.com<br><b>Sent:</b> Monday<br><b>To:</b> b@y.com<br><b>Subject:</b> Hi<br>${LETTER}</p>`;
    const out = sanitizeBody(html, { letterText: LETTER });
    assert.ok(out.includes(LETTER), 'the letter must never be dropped with the headers');
});

test('nothing is stripped without enough letter text to recognize', () => {
    const html = '<p><b>From:</b> a@x.com<br><b>Sent:</b> Mon<br><b>To:</b> b@y.com<br><b>Subject:</b> Hi</p>';
    assert.match(sanitizeBody(html, { letterText: 'Love, Elder' }), /b@y\.com/);
    assert.match(sanitizeBody(html), /b@y\.com/);
});

// --- linked photo services -------------------------------------------------

test('a shared album link is recorded, and the two services stay apart', () => {
    // The shape both real letters used.
    assert.deepEqual(
        linkedPhotoServices('<p>Photos: <a href="https://photos.app.goo.gl/eGtkcGt6kXqodvf26">here</a></p>'),
        ['googlePhotos']
    );
    assert.deepEqual(
        linkedPhotoServices('<a href="https://photos.google.com/share/AF1Qxyz">album</a>'),
        ['googlePhotos']
    );
    assert.deepEqual(
        linkedPhotoServices('<a href="https://drive.google.com/file/d/1AbC/view">file</a>'),
        ['googleDrive']
    );
});

test('both services in one letter are both reported, sorted and deduplicated', () => {
    const html = [
        '<a href="https://drive.google.com/file/d/1AbC/view">a</a>',
        '<a href="https://photos.app.goo.gl/xyz">b</a>',
        '<a href="https://photos.google.com/share/AF1">c</a>'
    ].join('');
    assert.deepEqual(linkedPhotoServices(html), ['googleDrive', 'googlePhotos']);
});

test('a letter with no album link records nothing', () => {
    assert.deepEqual(linkedPhotoServices('<p>Hello <a href="https://example.com/x">x</a></p>'), []);
    assert.deepEqual(linkedPhotoServices(null), []);
    assert.deepEqual(linkedPhotoServices(''), []);
});

test('the host is parsed, not substring-matched', () => {
    // A host that appears in the path or in userinfo is not that host, and
    // counting it would corrupt the very numbers this exists to collect.
    assert.deepEqual(linkedPhotoServices('<a href="https://evil.example/photos.google.com">x</a>'), []);
    assert.deepEqual(linkedPhotoServices('<a href="https://photos.google.com@evil.example/">x</a>'), []);
});

test('a plain-text letter is scanned too', () => {
    // No HTML part means bodyText carries the letter, and the link with it.
    assert.deepEqual(
        linkedPhotoServices('Pictures are at https://photos.app.goo.gl/abc123 — enjoy!'),
        ['googlePhotos']
    );
});

// --- transcoder ------------------------------------------------------------

test('renditions are WebP, bounded, and carry no EXIF', async () => {
    const source = await sharp({
        create: { width: 3000, height: 2000, channels: 3, background: '#336699' }
    })
        .jpeg()
        .withMetadata({ exif: { IFD0: { Copyright: 'Elder Example', Software: 'probe' } } })
        .toBuffer();

    const out = await transcode(source);
    assert.ok(out, 'a plain JPEG should transcode');
    assert.equal(out.width, 3000);
    assert.equal(out.height, 2000);

    const large = await sharp(out.large).metadata();
    const thumb = await sharp(out.thumb).metadata();
    assert.equal(large.format, 'webp');
    assert.equal(thumb.format, 'webp');
    assert.equal(Math.max(large.width, large.height), LARGE_EDGE);
    assert.equal(Math.max(thumb.width, thumb.height), THUMB_EDGE);

    // GPS lives in the same block. A missionary's location must not ship.
    assert.equal(large.exif, undefined);
    assert.equal(thumb.exif, undefined);
});

test('a small image is never enlarged and furniture is refused outright', async () => {
    const small = await sharp({
        create: { width: 300, height: 200, channels: 3, background: '#fff' }
    })
        .png()
        .toBuffer();
    const out = await transcode(small);
    const large = await sharp(out.large).metadata();
    assert.equal(large.width, 300, 'a 300px photo must not be upscaled to 2400');

    const logo = await sharp({
        create: { width: MIN_PHOTO_EDGE - 1, height: 40, channels: 3, background: '#fff' }
    })
        .png()
        .toBuffer();
    assert.equal(await transcode(logo), null, 'a signature logo is not a photo');
});

test('undecodable bytes yield null rather than throwing', async () => {
    assert.equal(await transcode(Buffer.from('not an image at all')), null);
    assert.equal(await transcode(Buffer.alloc(0)), null);

    // An ISO base media header carrying a HEIC brand and nothing behind it:
    // the shape that sends `transcode` past sharp and on to the wasm decoder.
    // That second attempt has to fail the same quiet way the first one does,
    // or one malformed attachment takes the whole letter down with it.
    const heicish = Buffer.concat([
        Buffer.from([0, 0, 0, 24]),
        Buffer.from('ftypheic'),
        Buffer.alloc(12)
    ]);
    assert.equal(await transcode(heicish), null);
});

test('a photograph shot upright is recorded upright', async () => {
    // Every phone writes the sensor's landscape rectangle and an EXIF note
    // saying which way up it was held, and sharp's `metadata()` reports the
    // file rather than the pipeline -- so the `rotate()` that turns the
    // rendition has no bearing on the numbers recorded beside it. Recorded
    // from the sensor, a portrait photograph claims to be landscape, and
    // everything downstream lays out a rectangle half again too wide and
    // stretches a face to fill it. Nothing reads the picture back to check,
    // so these two numbers are the only shape the book and the reader ever
    // have.
    const source = await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#336699' }
    })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer();

    const out = await transcode(source);
    const large = await sharp(out.large).metadata();

    assert.equal(out.width, 300);
    assert.equal(out.height, 400);
    assert.equal(out.width / out.height, large.width / large.height);
});

// --- render ----------------------------------------------------------------

test('an inline forward renders its photos and rewrites the body', async () => {
    const { store, post, result } = await pipeline('outlook-web-inline');

    assert.equal(result.status, 'rendered');
    // Two attached plus one inline, all distinct images.
    assert.equal(post.photos.length, 3);

    for (const photo of post.photos) {
        assert.match(photo.id, /^p_[0-9a-f]{12}$/);
        assert.ok(photo.width > 0 && photo.height > 0);
        assert.ok(store.blobs.has(`rendered/${SLUG}/photos/${photo.id}/large.webp`));
        assert.ok(store.blobs.has(`rendered/${SLUG}/photos/${photo.id}/thumb.webp`));
    }

    assert.equal(
        store.blobs.get(`rendered/${SLUG}/photos/${post.photos[0].id}/large.webp`).contentType,
        'image/webp'
    );
});

test('the rendered body carries no cid: references and no raw email markup', async () => {
    const { post } = await pipeline('outlook-web-inline');
    assert.doesNotMatch(post.bodyHtml, /cid:/i);
    assert.doesNotMatch(post.bodyHtml, /<script|<style|on[a-z]+=/i);
    assert.doesNotMatch(post.bodyHtml, /\bstyle="/i);
    // End to end, through a real client's markup: no recipient list survives.
    assert.doesNotMatch(post.bodyHtml, /\bSent:|\bSubject:/);
});

test('re-rendering the same message changes nothing', async () => {
    const { store, message, post } = await pipeline('outlook-web-inline');
    const before = JSON.stringify(store.json('rendered', `${SLUG}/posts.json`));
    const blobsBefore = [...store.blobs.keys()].sort();

    const again = await runRender({ message, store, log: silent });
    assert.equal(again.status, 'rendered');
    assert.equal(JSON.stringify(store.json('rendered', `${SLUG}/posts.json`)), before);
    assert.deepEqual([...store.blobs.keys()].sort(), blobsBefore);
    assert.equal(post.photos.length, 3);
});

// --- restoring the original ------------------------------------------------

// Edit a rendered post the way the API does, without going through the API.
const editInPlace = async (store, changes) => {
    const posts = store.json('rendered', `${SLUG}/posts.json`);
    posts[0] = { ...posts[0], ...changes, editedBy: 'sarah@example.com', editedAt: '2026-08-04T09:00:00.000Z' };
    await store.writeBlob('rendered', `${SLUG}/posts.json`, Buffer.from(JSON.stringify(posts, null, 2), 'utf8'));
};

test('a restore puts back the subject, the body and the photos, and clears the stamps', async () => {
    const { store, message, post } = await pipeline('outlook-web-inline');
    const original = { subject: post.subject, bodyHtml: post.bodyHtml, photos: post.photos };

    await editInPlace(store, {
        subject: 'A subject nobody sent',
        bodyHtml: '<p>Rewritten entirely.</p>',
        // Stands in for the owner-added pictures that are coming: anything in
        // `photos` that the original message did not carry.
        photos: [...post.photos, { id: 'added-by-an-owner', width: 800, height: 600 }]
    });

    const result = await runRender({ message, store, restore: true, log: silent });
    assert.equal(result.status, 'rendered');

    const restored = store.json('rendered', `${SLUG}/posts.json`)[0];
    assert.equal(restored.subject, original.subject);
    assert.equal(restored.bodyHtml, original.bodyHtml);
    assert.deepEqual(restored.photos, original.photos);
    assert.equal(restored.editedBy, null);
    assert.equal(restored.editedAt, null);
});

test('a restore leaves a held letter held', async () => {
    // Hiding is a decision about the post rather than a property of its text,
    // and an undo that quietly republished one would be a disclosure.
    const { store, message } = await pipeline('outlook-web-inline');
    await editInPlace(store, { hidden: true, heldReason: 'over the daily cap', bodyHtml: '<p>Rewritten.</p>' });

    await runRender({ message, store, restore: true, log: silent });

    const restored = store.json('rendered', `${SLUG}/posts.json`)[0];
    assert.equal(restored.hidden, true);
    assert.equal(restored.heldReason, 'over the daily cap');
});

test('an ordinary re-render does not touch the subject or the edit stamps', async () => {
    // The distinction the flag exists for. Re-rendering after a sanitizer fix
    // must not put an owner's name on a change they did not make, or undo the
    // subject they deliberately rewrote.
    const { store, message } = await pipeline('outlook-web-inline');
    await editInPlace(store, { subject: 'Trimmed for the family' });

    await runRender({ message, store, log: silent });

    const after = store.json('rendered', `${SLUG}/posts.json`)[0];
    assert.equal(after.subject, 'Trimmed for the family');
    assert.equal(after.editedBy, 'sarah@example.com');
});

// --- pictures an owner added -----------------------------------------------

/** The one field that says a picture was not in the message. */
const ADDED = { id: 'p_addedbyowner', width: 800, height: 600, addedAt: '2026-08-05T10:00:00.000Z' };

test('a re-render keeps the pictures an owner added and puts them last', async () => {
    // Re-rendering re-reads the message, and the message never had these. The
    // pipeline is re-run for sanitizer fixes and layout fixes on letters that
    // are years old by then; if that quietly deleted an owner's photographs it
    // would do so without anybody asking for it and without saying so.
    const { store, message, post } = await pipeline('outlook-web-inline');
    await editInPlace(store, { photos: [...post.photos, ADDED] });

    await runRender({ message, store, log: silent });

    const after = store.json('rendered', `${SLUG}/posts.json`)[0];
    assert.equal(after.photos.length, post.photos.length + 1);
    assert.deepEqual(after.photos.at(-1), ADDED);
    // And the message's own pictures still come first, which is what puts the
    // added ones at the end of the album the reader draws.
    assert.deepEqual(after.photos.slice(0, -1).map((photo) => photo.id), post.photos.map((photo) => photo.id));
});

test('a restore drops the pictures an owner added', async () => {
    // Deliberately the other way, and the only place the two differ. Putting a
    // letter back the way it arrived means back to the pictures that arrived
    // with it; the button says so before it is pressed.
    const { store, message, post } = await pipeline('outlook-web-inline');
    await editInPlace(store, { photos: [...post.photos, ADDED] });

    await runRender({ message, store, restore: true, log: silent });

    const after = store.json('rendered', `${SLUG}/posts.json`)[0];
    assert.deepEqual(after.photos.map((photo) => photo.id), post.photos.map((photo) => photo.id));
});

test('storePhoto writes both renditions and refuses what is not a photo', async () => {
    const store = memoryStore();
    const bytes = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#336699' } })
        .jpeg()
        .toBuffer();

    const out = await storePhoto({ store, slug: SLUG, bytes });
    assert.equal(out.width, 900);
    assert.equal(out.height, 600);
    assert.match(out.id, /^p_[0-9a-f]{12}$/);
    assert.equal(store.blobs.get(`rendered/${SLUG}/photos/${out.id}/large.webp`).contentType, 'image/webp');
    assert.ok(store.blobs.has(`rendered/${SLUG}/photos/${out.id}/thumb.webp`));

    // The same refusal `transcode` makes, passed through rather than thrown --
    // the upload handler turns it into a 415 and nothing is written.
    assert.equal(await storePhoto({ store, slug: SLUG, bytes: Buffer.from('not an image') }), null);
    assert.equal(store.blobs.size, 2);
});

test('every rendered post carries a linkedPhotoServices array', async () => {
    // The fixture attaches its photos rather than linking them, so the
    // expected answer is an empty array -- present and empty, not absent.
    // A missing field and a zero count are the same thing to a naive counter,
    // and they mean opposite things.
    const { post } = await pipeline('outlook-web-inline');
    assert.deepEqual(post.linkedPhotoServices, []);
});

test('a plain-text letter becomes escaped HTML paragraphs', async () => {
    const { store, message } = await pipeline('outlook-web-inline');

    const textOnly = Buffer.from(
        [
            'From: Elder Example <elder.example@missionary.org>',
            'Subject: Week 12',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'First paragraph',
            'still the first',
            '',
            'Cost was <b>R$5</b> & worth it',
            ''
        ].join('\r\n'),
        'utf8'
    );
    store.blobs.set(`raw/${SLUG}/${message.msgId}/message.eml`, {
        bytes: textOnly,
        metadata: {},
        etag: 'etag-text'
    });

    assert.equal((await runRender({ message, store, log: silent })).status, 'rendered');
    const post = store.json('rendered', `${SLUG}/posts.json`)[0];

    assert.match(post.bodyHtml, /<p>First paragraph<br \/>still the first<\/p>/);
    // Text that merely looks like markup stays text.
    assert.match(post.bodyHtml, /&lt;b&gt;R\$5&lt;\/b&gt;/);
    assert.doesNotMatch(post.bodyHtml, /<b>/);
    assert.match(post.bodyHtml, /&amp; worth it/);

    // bodyText only bridged the gap between ingest and render.
    assert.equal('bodyText' in post, false);
});

test('a letter whose photos cannot be decoded still publishes', async () => {
    const { store, message } = await pipeline('outlook-web-inline');

    // Corrupt the archived original so every attachment fails to decode, then
    // render it again. Losing an image must never cost the letter.
    const key = `raw/${SLUG}/${message.msgId}/message.eml`;
    const broken = Buffer.from(
        [
            'From: Elder Example <elder.example@missionary.org>',
            'Subject: Week 12',
            'Content-Type: multipart/mixed; boundary=b',
            '',
            '--b',
            'Content-Type: text/html',
            '',
            '<p>Still a letter</p>',
            '--b',
            'Content-Type: image/jpeg',
            'Content-Disposition: attachment; filename="broken.jpg"',
            'Content-Transfer-Encoding: base64',
            '',
            Buffer.from('this is not a jpeg').toString('base64'),
            '--b--',
            ''
        ].join('\r\n'),
        'utf8'
    );
    store.blobs.set(key, { bytes: broken, metadata: {}, etag: 'etag-broken' });

    const result = await runRender({ message, store, log: silent });
    assert.equal(result.status, 'rendered');

    const post = store.json('rendered', `${SLUG}/posts.json`)[0];
    assert.equal(post.photos.length, 0);
    assert.match(post.bodyHtml, /Still a letter/);
});

test('a message missing from raw is not retried forever', async () => {
    const { store, message } = await pipeline('outlook-web-inline');
    store.blobs.delete(`raw/${SLUG}/${message.msgId}/message.eml`);

    assert.equal((await runRender({ message, store, log: silent })).status, 'missing');
});

test('an incomplete or unknown job is rejected rather than throwing', async () => {
    const store = memoryStore();
    assert.equal(
        (await runRender({ message: { slug: SLUG }, store, log: silent })).status,
        'rejected'
    );

    const { store: real, message } = await pipeline('outlook-web-inline');
    const stray = { ...message, postId: '2099-01-01-zzzz' };
    assert.equal((await runRender({ message: stray, store: real, log: silent })).status, 'missing-post');
});

test('render retries posts.json when another writer wins the race', async () => {
    const { store, message } = await pipeline('outlook-web-inline');
    store.conflictOnce = `rendered/${SLUG}/posts.json`;

    const result = await runRender({ message, store, log: silent });
    assert.equal(result.status, 'rendered');
    assert.equal(store.json('rendered', `${SLUG}/posts.json`)[0].photos.length, 3);
});
