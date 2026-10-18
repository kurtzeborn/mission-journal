// Leaving the photo album.
//
// The album is two dialogs that cover the window, so it reads as a place and
// Back is what people reach for to leave a place -- which, untouched, leaves
// the archive instead. What is under test here is only that: which layer Back
// closes, and that a layer closed any other way does not leave a dead entry
// behind for Back to walk through afterwards.
//
// The rest of the album is lazy image loading and layout, and jsdom does
// neither. That part is checked in a browser.

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

/** The archive with the real album on it, and a record of what it hands back. */
function archive({ posts = POSTS, admin = null } = {}) {
    const view = page({ album: true });
    const revealed = [];

    view.mount({ posts });

    // Taken before the album opens: the assertions below are about the entries
    // it adds to this, and about landing back on the one underneath them all.
    // `history.length` cannot answer the second -- going back does not shorten
    // it, it only moves -- so what marks the album's own entries is their state.
    const before = view.window.history.length;
    view.window.Album.open({
        posts,
        photoSrc,
        reveal: (id) => revealed.push(id),
        admin
    });

    return { ...view, revealed, before };
}

/** A history traversal is queued, not immediate, so let it land. */
const settled = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resume) => setTimeout(resume, 0));
};

async function back(view) {
    view.window.history.back();
    await settled();
}

const open = (dialog) => Boolean(dialog?.hasAttribute('open'));

describe('choosing photos for the printed book', () => {
    test('readers see no selection controls', () => {
        const view = archive();
        assert.equal(view.$$('.gallery__feature').length, 0);
    });

    test('owners can select loose photos but not photos inside the letter', () => {
        const view = archive({ admin: { featurePhoto() {} } });

        const controls = view.$$('.gallery__feature');
        assert.equal(controls.length, 1);
        assert.equal(controls[0].getAttribute('aria-pressed'), 'false');
        assert.match(controls[0].getAttribute('aria-label'), /Feature this photograph/);
    });

    test('a successful selection updates the control', async () => {
        const calls = [];
        const view = archive({
            admin: {
                featurePhoto: async (...args) => {
                    calls.push(args);
                    return null;
                }
            }
        });

        view.click(view.$('.gallery__feature'));
        await settled();

        assert.deepEqual(calls, [['2026-03-25-9CRE', LOOSE, true]]);
        assert.equal(view.$('.gallery__feature').getAttribute('aria-pressed'), 'true');
        assert.match(view.$('.gallery__message').textContent, /featured larger/);
    });

    test('a third selection is stopped with a useful message', async () => {
        const posts = [
            letter('2026-03-25-9CRE', para(400, 'Antigua'), {
                photos: [
                    { id: 'p-one', width: 800, height: 600 },
                    { id: 'p-two', width: 800, height: 600 },
                    { id: 'p-three', width: 800, height: 600 }
                ],
                featuredPhotoIds: ['p-one', 'p-two']
            })
        ];
        let called = false;
        const view = archive({
            posts,
            admin: {
                featurePhoto: async () => {
                    called = true;
                    return null;
                }
            }
        });

        view.click(view.$$('.gallery__feature')[2]);
        await settled();

        assert.equal(called, false);
        assert.match(view.$('.gallery__message').textContent, /already has two featured photos/);
    });
});

describe('getting out of the photo album', () => {
    test('opening it is somewhere to come back from', () => {
        const view = archive();

        assert.equal(open(view.gallery()), true);
        assert.equal(view.window.history.length, view.before + 1);
    });

    test('Back closes the album rather than leaving the archive', async () => {
        const view = archive();
        await back(view);

        assert.equal(open(view.gallery()), false);
        assert.equal(view.window.location.pathname, '/isaac.backman');
    });

    test('from one photograph, Back is the way up to the grid', async () => {
        const view = archive();
        view.click(view.gallery().querySelector('.gallery__cell'));
        assert.equal(open(view.viewer()), true);

        await back(view);

        // The point of the whole change: one press goes up a layer, not out.
        assert.equal(open(view.viewer()), false);
        assert.equal(open(view.gallery()), true);
    });

    test('and the press after that closes the album', async () => {
        const view = archive();
        view.click(view.gallery().querySelector('.gallery__cell'));

        await back(view);
        await back(view);

        assert.equal(open(view.gallery()), false);
    });

    test('the x takes its own entry back, so Back still leaves', async () => {
        const view = archive();
        view.click(view.gallery().querySelector('.gallery__close'));
        await settled();

        assert.equal(open(view.gallery()), false);

        // Nothing of ours is left underfoot. Were the entry still there, the
        // next press would be spent on a dialog that closed a moment ago and
        // the reader would think Back had stopped working.
        assert.equal(view.window.history.state, null);
    });

    test('closing the photograph leaves the grid where Back can still reach it', async () => {
        const view = archive();
        view.click(view.gallery().querySelector('.gallery__cell'));
        view.click(view.viewer().querySelector('.viewer__close'));
        await settled();

        assert.equal(open(view.viewer()), false);
        assert.equal(open(view.gallery()), true);

        await back(view);
        assert.equal(open(view.gallery()), false);
    });

    test('going to the letter unwinds both layers at once', async () => {
        const view = archive();
        view.click(view.gallery().querySelector('.gallery__cell'));
        view.click(view.viewer().querySelector('.viewer__goto'));
        await settled();

        assert.equal(open(view.viewer()), false);
        assert.equal(open(view.gallery()), false);
        assert.deepEqual(view.revealed, ['2026-03-25-9CRE']);
        assert.equal(view.window.history.state, null);
    });

    test('a press with nothing open is the reader leaving, and stays that way', async () => {
        const view = archive();
        await back(view);
        await back(view);

        assert.equal(open(view.gallery()), false);
        assert.equal(open(view.viewer()), false);
    });
});
