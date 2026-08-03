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
import { runRender } from '../src/lib/render.js';
import { sanitizeBody, photoUrl } from '../src/lib/sanitize.js';
import { transcode, MIN_PHOTO_EDGE, LARGE_EDGE, THUMB_EDGE } from '../src/lib/photos.js';
import { memoryStore } from './memory-store.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const config = { authservId: 'mx.cloudflare.net', missionaryDomains: ['missionary.org'] };
const OWNER = [{ email: 'scott@kurtzeborn.org', role: 'owner' }];
const SLUG = 'elder.example';
const silent = { info() {}, warn() {}, error() {} };

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
        now: () => new Date('2026-08-03T12:00:00Z')
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
