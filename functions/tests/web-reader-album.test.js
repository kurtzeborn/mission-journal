// The photo album, from the reader's side of the seam.
//
// The album itself is a Swiper in a dialog and the website's alone -- there is
// no test for it here, because what it does is measure elements and animate
// them, and jsdom has neither. What can be tested is everything on this side of
// the handover: whether the button appears, which of the two viewers a photo
// click goes to, and what the archive looks like once the album hands a letter
// back.
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
        assert.deepEqual(labels(archive()), ['Photos', 'Word cloud', 'Expand all']);
    });

    test('the downloaded archive is given no album and offers no button', () => {
        assert.deepEqual(labels(archive({ withAlbum: false })), ['Word cloud', 'Expand all']);
    });

    test('an archive with no photographs in it does not offer one either', () => {
        const view = archive({ posts: [POSTS[1], letter('2026-03-09-R32V', para(400))] });

        assert.deepEqual(labels(view), ['Word cloud', 'Expand all']);
    });

    test('opening it from the toolbar starts at the beginning', () => {
        const view = archive();
        view.click(view.button('Photos'));

        assert.equal(view.album.opened.length, 1);
        assert.equal(view.album.opened[0].at, undefined);
        assert.equal(view.album.opened[0].posts.length, 2);
    });
});

describe('clicking a photograph', () => {
    test('a picture inside a letter opens the album on that picture', () => {
        const view = archive();
        view.click(view.$('.photo'));

        assert.equal(view.album.opened.at(-1)?.at, PICTURE);
    });

    test('a thumbnail under a letter does too', () => {
        const view = archive();
        view.click(view.$('.album a'));

        assert.equal(view.album.opened.at(-1)?.at, LOOSE);
    });

    test('and the old lightbox is left for the archive that has no album', () => {
        // The zip ships one picture at a time and no Swiper. This is the only
        // thing keeping that path alive now that the site has left it.
        const view = archive({ withAlbum: false });
        view.click(view.$('.photo'));

        assert.equal(view.enlarged(), photoSrc(PICTURE, 'large'));
    });
});

describe('being handed back a letter', () => {
    test('the archive folds down to that one and scrolls to it', () => {
        const view = archive();
        view.click(view.button('Photos'));

        const { posts, reveal } = view.album.opened[0];
        reveal(posts[1].id);

        const panels = view.$$('.post__panel');
        assert.deepEqual(panels.map((panel) => panel.hidden), [true, false]);
        assert.equal(view.record.scrolled.at(-1).node, view.post(posts[1].id));
    });

    test('a letter it does not recognise leaves the page alone', () => {
        const view = archive();
        view.click(view.button('Photos'));

        const before = view.$$('.post__panel').map((panel) => panel.hidden);
        view.album.opened[0].reveal('2019-01-01-XXXX');

        assert.deepEqual(view.$$('.post__panel').map((panel) => panel.hidden), before);
    });
});
