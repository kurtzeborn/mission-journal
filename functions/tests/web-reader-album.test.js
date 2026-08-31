// The photo album, from the reader's side of the seam.
//
// The album itself is a Swiper in a dialog and the website's alone -- there is
// no test for it here, because what it does is measure elements and animate
// them, and jsdom has neither. What can be tested is everything on this side of
// the handover: whether the button appears, that nothing else reaches the
// album, and what the archive looks like once the album hands a letter back.
//
// The stub stands exactly where the real one does. `mount` is given an object
// with an `open`, and that is the whole of the contract.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { img, letter, page, para, photoSrc } from './reader-dom.js';

const PICTURE = 'p-first';
const LOOSE = 'p-loose';

const POSTS = [
    letter('2026-03-25-9CRE', `${img(PICTURE)}${para(400, 'Antigua')}`, {
        photos: [{ id: PICTURE, width: 800, height: 600 }, { id: LOOSE, width: 800, height: 600 }]
    }),
    letter('2026-03-16-28MW', para(400, 'Xela'))
];

function album() {
    const opened = [];
    return { opened, open: (options) => opened.push(options) };
}

function archive({ posts = POSTS, withAlbum = true } = {}) {
    const view = page();
    const book = album();
    view.mount({ posts, album: withAlbum ? book : null });
    return { ...view, album: book };
}

const labels = (view) =>
    [...view.$('.toolbar').querySelectorAll('button')].map((el) => el.textContent);

describe('getting to the album', () => {
    test('its button sits with the word cloud, not with Expand all', () => {
        // Both of these open a window over the archive. Expand all rearranges
        // the archive itself and stays at the other end of the row.
        assert.deepEqual(labels(archive()), ['Photo Album', 'Word cloud', 'Expand all']);
    });

    test('the downloaded archive is given no album and offers no button', () => {
        assert.deepEqual(labels(archive({ withAlbum: false })), ['Word cloud', 'Expand all']);
    });

    test('an archive with no photographs in it does not offer one either', () => {
        const view = archive({ posts: [POSTS[1], letter('2026-03-09-R32V', para(400))] });

        assert.deepEqual(labels(view), ['Word cloud', 'Expand all']);
    });

    test('one photograph in the whole archive is not an album', () => {
        // It is the picture already on the page, so the button would open a
        // window over the archive to show what the archive is showing.
        const view = archive({
            posts: [
                letter('2026-03-25-9CRE', `${img(PICTURE)}${para(400, 'Antigua')}`, {
                    photos: [{ id: PICTURE, width: 800, height: 600 }]
                }),
                POSTS[1]
            ]
        });

        assert.deepEqual(labels(view), ['Word cloud', 'Expand all']);
    });

    test('a single letter carrying pictures still gets one', () => {
        // Expand all and the word cloud have nothing to act on, so what
        // appears is the album button by itself rather than no toolbar.
        assert.deepEqual(labels(archive({ posts: [POSTS[0]] })), ['Photo Album']);
    });

    test('opening it from the toolbar starts at the beginning', () => {
        const view = archive();
        view.click(view.button('Photo Album'));

        assert.equal(view.album.opened.length, 1);
        assert.equal(view.album.opened[0].at, undefined);
        assert.equal(view.album.opened[0].posts.length, 2);
    });
});

describe('clicking a photograph', () => {
    // The button is the only way in. A reader who taps a picture is asking to
    // see that picture bigger, and used to get the whole archive as a
    // slideshow instead, which took the letter they were reading away.
    test('a picture inside a letter opens the lightbox, not the album', () => {
        const view = archive();
        view.click(view.$('.photo'));

        assert.equal(view.enlarged(), photoSrc(PICTURE, 'large'));
        assert.equal(view.album.opened.length, 0);
    });

    test('a thumbnail under a letter does too', () => {
        const view = archive();
        view.click(view.$('.album a'));

        assert.equal(view.enlarged()?.endsWith(photoSrc(LOOSE, 'large')), true);
        assert.equal(view.album.opened.length, 0);
    });

    test('and the archive with no album behaves exactly the same', () => {
        // The zip ships the lightbox and no Swiper. Both sides now take the
        // same path, which is the point -- one behaviour to keep working.
        const view = archive({ withAlbum: false });
        view.click(view.$('.photo'));

        assert.equal(view.enlarged(), photoSrc(PICTURE, 'large'));
    });
});

describe('being handed back a letter', () => {
    test('the archive folds down to that one and scrolls to it', () => {
        const view = archive();
        view.click(view.button('Photo Album'));

        const { posts, reveal } = view.album.opened[0];
        reveal(posts[1].id);

        const panels = view.$$('.post__panel');
        assert.deepEqual(panels.map((panel) => panel.hidden), [true, false]);
        assert.equal(view.record.scrolled.at(-1).node, view.post(posts[1].id));
    });

    test('a letter it does not recognise leaves the page alone', () => {
        const view = archive();
        view.click(view.button('Photo Album'));

        const before = view.$$('.post__panel').map((panel) => panel.hidden);
        view.album.opened[0].reveal('2019-01-01-XXXX');

        assert.deepEqual(view.$$('.post__panel').map((panel) => panel.hidden), before);
    });
});
