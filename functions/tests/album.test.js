// Album link tests.
//
// Every input here is real. The markup shapes were pulled out of the four
// production archives, and so were the labels -- twenty-five distinct forms
// across eighty-four letters, seven of which are not labels at all but the
// tail of a sentence that happens to end in one. Those seven are why this file
// is long: the removal is permanent, it runs over letters people wrote, and
// the only thing standing between it and somebody's paragraph is the rule
// exercised below.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { albumUrls, stripAlbumLinks } from '../src/lib/album.js';
import { recordAlbumUrls, sitesBySlug, touchSiteActivity } from '../src/lib/sites.js';
import { memoryStore } from './memory-store.js';

const ALBUM = 'https://photos.app.goo.gl/k3EgCuLhqBygsxHU8';

// --- finding the URL -------------------------------------------------------

test('both album hosts are recognised, in markup and in prose', () => {
    assert.deepEqual(albumUrls(`<p>Fotos: <a href="${ALBUM}">${ALBUM}</a></p>`), [ALBUM]);
    assert.deepEqual(albumUrls('Pictures are at https://photos.app.goo.gl/abc123 - enjoy!'), [
        'https://photos.app.goo.gl/abc123'
    ]);
    assert.deepEqual(albumUrls('<a href="https://photos.google.com/share/AF1Qxyz">album</a>'), [
        'https://photos.google.com/share/AF1Qxyz'
    ]);
});

test('the same album written twice is recorded once', () => {
    // The anchor form always says it twice: once in the href, once as the
    // visible text. A missionary who pastes it into two paragraphs says it
    // twice again.
    assert.deepEqual(albumUrls(`<a href="${ALBUM}">${ALBUM}</a><p>and again ${ALBUM}</p>`), [ALBUM]);
});

test('several albums come back sorted', () => {
    assert.deepEqual(
        albumUrls(`${ALBUM} and https://photos.app.goo.gl/aULW4fKHDXz7QhdB9`),
        ['https://photos.app.goo.gl/aULW4fKHDXz7QhdB9', ALBUM].sort()
    );
});

test('punctuation that ended the sentence is not part of the URL', () => {
    assert.deepEqual(albumUrls('Here it is: https://photos.app.goo.gl/abc123.'), [
        'https://photos.app.goo.gl/abc123'
    ]);
    assert.deepEqual(albumUrls('(see https://photos.app.goo.gl/abc123)'), [
        'https://photos.app.goo.gl/abc123'
    ]);
});

test('the host is parsed, not substring-matched', () => {
    // Recording one of these would put an attacker's URL on the site row as
    // the family's album.
    assert.deepEqual(albumUrls('<a href="https://evil.example/photos.google.com">x</a>'), []);
    assert.deepEqual(albumUrls('<a href="https://photos.google.com@evil.example/">x</a>'), []);
});

test('a letter with no album link yields nothing', () => {
    assert.deepEqual(albumUrls('<p>Hello <a href="https://example.com/x">x</a></p>'), []);
    assert.deepEqual(albumUrls(null), []);
    assert.deepEqual(albumUrls(''), []);
});

// --- taking it back out ----------------------------------------------------

test('a label in one block and the link in the next both go', () => {
    // Declan's shape, verbatim from `rendered/`.
    const html = [
        '<p>Link for the (currently very empty) google photo album</p>',
        `<p><a href="${ALBUM}" target="_blank" rel="noopener noreferrer nofollow">${ALBUM}</a></p>`
    ].join('\n');

    assert.equal(stripAlbumLinks(html), '<p></p><p></p>');
});

test('a label and link in adjacent divs both go', () => {
    // Mallory's shape.
    const html = `<div>Google Photos:</div><div><a href="${ALBUM}">${ALBUM}</a></div>`;

    assert.equal(stripAlbumLinks(html), '<div></div><div></div>');
});

test('a label and link in the same block both go', () => {
    // Isaac's shape. The anchor's visible text starts on a new line, which is
    // why the whole element has to be taken rather than just the href.
    const html = `<p>Google photo album: <a href="${ALBUM}" rel="nofollow">\n${ALBUM}</a></p>`;

    assert.equal(stripAlbumLinks(html), '<p></p>');
});

test('a bare link in plain text goes, with its label', () => {
    // The blank line is what stops the label run from reaching back to the
    // greeting. Without it nothing in a plain-text letter would ever be short
    // enough to look like a label.
    const text = 'Hey everyone!\n\nFotos:\nhttps://photos.app.goo.gl/abc123';

    assert.equal(stripAlbumLinks(text), 'Hey everyone!\n');
});

test('the sentence that introduced the link is kept, and its colon closed', () => {
    // One of the seven. Deleting this would delete a paragraph.
    const html = [
        '<p>into a ball like there was a grenade. It was soooo funny!',
        ' There is a video of it on my Google photo album: ',
        `<a href="${ALBUM}">${ALBUM}</a></p>`
    ].join('');

    const after = stripAlbumLinks(html);
    assert.match(after, /It was soooo funny!/);
    assert.match(after, /Google photo album\.\s*<\/p>/);
    assert.doesNotMatch(after, /photos\.app\.goo\.gl/);
});

test('a long sentence with no mid-sentence punctuation is still a sentence', () => {
    // Eighty-three characters and not a full stop in it. Length is the only
    // condition that catches this one, which is why length is a condition.
    const html = `<p>If you want to see the video of the truck and motorcycles then join the photo album: <a href="${ALBUM}">x</a></p>`;

    assert.match(stripAlbumLinks(html), /then join the photo album\./);
});

test('a run that is only punctuation goes, and what is left still reads', () => {
    // Isaac, twice, and not the shape it looks like in a text dump: the emoji
    // is inside a span, so the run before the link is just " : ". That is
    // removed, the span stays, and the sentence ends on the emoji. Reaching
    // back through inline tags to take it too would cost more than two
    // letters are worth.
    const html = `<p>you will have to join the photo album\r\n<span> \u{1F60F}</span> : <a href="${ALBUM}">x</a></p>`;

    assert.equal(
        stripAlbumLinks(html),
        `<p>you will have to join the photo album\r\n<span> \u{1F60F}</span></p>`
    );
});

test('a short run that names nothing is kept', () => {
    // Conservative on purpose. "Here you go" is short and unpunctuated, but it
    // is a sentence somebody wrote and nothing marks it as a caption.
    assert.match(stripAlbumLinks(`<p>Here you go: <a href="${ALBUM}">x</a></p>`), /Here you go\./);
});

test('a link that is not an album is left entirely alone', () => {
    const html = '<p>See <a href="https://example.com/photos">the photos</a></p>';

    assert.equal(stripAlbumLinks(html), html);
});

test('running it twice changes nothing the second time', () => {
    // The backfill is a tool somebody may run again by accident, and the
    // sanitizer runs on every edit.
    const once = stripAlbumLinks(`<p>Fotos: <a href="${ALBUM}">${ALBUM}</a></p><p>Love, Elder</p>`);

    assert.equal(stripAlbumLinks(once), once);
});

test('null and empty pass straight through', () => {
    assert.equal(stripAlbumLinks(null), null);
    assert.equal(stripAlbumLinks(undefined), undefined);
    assert.equal(stripAlbumLinks(''), '');
});

test('every removal is reported, with the label that went with it', () => {
    // What the backfill prints for review before it writes anything.
    const removed = [];
    stripAlbumLinks(
        `<p>Fotos: <a href="${ALBUM}">x</a></p><p>Here you go: <a href="${ALBUM}">y</a></p>`,
        { onRemove: (entry) => removed.push(entry.label) }
    );

    assert.deepEqual(removed, ['Fotos:', '']);
});

// --- keeping it somewhere --------------------------------------------------

describe('the album on the site row', () => {
    const SLUG = 'elder.example';
    const OTHER = 'https://photos.app.goo.gl/aULW4fKHDXz7QhdB9';
    const urlsOn = async (store) =>
        (await sitesBySlug({ tables: store, slugs: [SLUG] })).get(SLUG).photoAlbumUrls;

    test('a site that never linked one reads as an empty list', async () => {
        // Not undefined, and not a throw. Every archive is asked this.
        assert.deepEqual(await urlsOn(memoryStore()), []);
    });

    test('the first album is written and comes back parsed', async () => {
        const store = memoryStore();
        await recordAlbumUrls({ tables: store, slug: SLUG, urls: [ALBUM] });

        assert.deepEqual(await urlsOn(store), [ALBUM]);
    });

    test('the same album next week does not write again', async () => {
        // Forty more letters carry this link. Each one arriving must not turn
        // into a table write.
        const store = memoryStore();
        await recordAlbumUrls({ tables: store, slug: SLUG, urls: [ALBUM] });

        let writes = 0;
        const upsert = store.upsertEntity.bind(store);
        store.upsertEntity = (...args) => {
            writes++;
            return upsert(...args);
        };
        await recordAlbumUrls({ tables: store, slug: SLUG, urls: [ALBUM] });

        assert.equal(writes, 0);
        assert.deepEqual(await urlsOn(store), [ALBUM]);
    });

    test('a second album is added, and the first is kept', async () => {
        // Nothing guarantees one album for two years, and the first one still
        // holds the first year's pictures.
        const store = memoryStore();
        await recordAlbumUrls({ tables: store, slug: SLUG, urls: [ALBUM] });
        await recordAlbumUrls({ tables: store, slug: SLUG, urls: [OTHER] });

        assert.deepEqual(await urlsOn(store), [OTHER, ALBUM].sort());
    });

    test('recording nothing leaves the row alone', async () => {
        const store = memoryStore();
        await touchSiteActivity({ tables: store, slug: SLUG, lastPostAt: '2026-08-01' });
        await recordAlbumUrls({ tables: store, slug: SLUG, urls: [] });

        assert.deepEqual(await urlsOn(store), []);
        assert.equal((await sitesBySlug({ tables: store, slugs: [SLUG] })).get(SLUG).lastPostAt, '2026-08-01');
    });

    test('the columns already on the row survive the write', async () => {
        // The upsert merges rather than replaces. If it did not, recording an
        // album would blank the date the landing page sorts on.
        const store = memoryStore();
        await touchSiteActivity({ tables: store, slug: SLUG, lastPostAt: '2026-08-01' });
        await recordAlbumUrls({ tables: store, slug: SLUG, urls: [ALBUM] });

        const row = (await sitesBySlug({ tables: store, slugs: [SLUG] })).get(SLUG);
        assert.equal(row.lastPostAt, '2026-08-01');
        assert.deepEqual(row.photoAlbumUrls, [ALBUM]);
    });
});
