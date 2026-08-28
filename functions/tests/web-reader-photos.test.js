// What the reader does to the pictures in a letter.
//
// This is the part of `reader.js` with the least margin for error. It rewrites
// markup that came out of somebody else's mail client, on a page where a
// mistake is not a wrong color but a missing photograph -- and the same file
// runs inside the downloaded zip, which a family cannot fetch again if it goes
// wrong. Until now all of it was verified by opening a browser and looking.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { page, img, para, letter, stored } from './reader-dom.js';
import { settled } from './web-dom.js';

/** An archive of one letter, drawn and opened. */
function only(bodyHtml, extra) {
    const view = page();
    view.mount({ posts: [letter('2026-03-25-9CRE', bodyHtml, extra)] });
    return { view, body: view.$('.post__body') };
}

const frames = (body) => [...body.querySelectorAll('.photo')];
const rows = (body) => [...body.querySelectorAll('.photo-row')];

describe('finding the photos in a letter', () => {
    test('every stored photo is repointed and remembers what was stored', () => {
        const { body } = only(`${img('p1')}${para(400)}`);

        const photo = body.querySelector('img');
        // The src the page shows and the src the archive holds are the same
        // string on the website and different ones in the downloaded zip, so
        // both are kept. Losing the stored one is how an owner's edit deletes
        // a picture: the server's sanitizer drops an <img> whose src it does
        // not recognize.
        assert.equal(photo.getAttribute('data-photo'), stored('p1'));
        assert.equal(photo.getAttribute('src'), stored('p1'));
        assert.equal(photo.getAttribute('loading'), 'lazy');
        assert.equal(photo.getAttribute('decoding'), 'async');
    });

    test('a photo is wrapped in something you can click and tab to', () => {
        const { body } = only(`${img('p1')}${para(400)}`);

        const frame = body.querySelector('.photo');
        assert.equal(frame.tagName, 'BUTTON');
        assert.equal(frame.getAttribute('type'), 'button');
        // A button whose only content is an image with empty alt text has no
        // accessible name. The visible caption was removed; this is what is
        // left, and dropping it too would leave a screen reader saying
        // "button" and nothing else.
        assert.equal(frame.getAttribute('aria-label'), 'View larger');
        assert.equal(frame.dataset.large, stored('p1', 'large'));
    });

    test('an image the sanitizer did not write is left alone', () => {
        // Nothing should be able to produce one -- remote images are stripped
        // server-side -- but the parse returns null for it, and the branch
        // that handles that has to not throw.
        const { body } = only(`<img src="https://example.com/tracker.gif" alt="">${para(400)}`);

        assert.equal(frames(body).length, 0);
        assert.equal(body.querySelector('img').getAttribute('src'), 'https://example.com/tracker.gif');
    });
});

describe('a photo has to earn its float', () => {
    test('a picture with a paragraph after it floats', () => {
        const { body } = only(`${img('p1')}${para(400)}`);

        assert.equal(frames(body)[0].classList.contains('photo--block'), false);
    });

    test('a picture with only a caption after it stands on its own', () => {
        // Two floats side by side squeeze the column to about sixteen
        // characters, which is a ladder of single words rather than a
        // paragraph. This is the measurement that stops it.
        const { body } = only(`${img('p1')}<p>Baptism day!</p>${img('p2')}${para(400)}`);

        assert.deepEqual(
            frames(body).map((f) => f.classList.contains('photo--block')),
            [true, false]
        );
    });

    test('room is counted up to the next picture, not to the end of the letter', () => {
        // The letter as a whole has plenty of prose. The first photo still
        // has none of it, because the second photo arrives first.
        const { body } = only(`${img('p1')}<p>Hi</p>${img('p2')}${para(600)}`);

        assert.equal(frames(body)[0].classList.contains('photo--block'), true);
    });
});

describe('a burst of photos becomes one row', () => {
    test('each in its own paragraph, which is how most clients paste them', () => {
        const { body } = only(
            `${para(400)}<p>${img('p1')}</p><p>${img('p2')}</p><p>${img('p3')}</p>`
        );

        assert.equal(rows(body).length, 1);
        assert.equal(rows(body)[0].querySelectorAll('.photo').length, 3);
        // The paragraphs the photos were lifted out of still print as blank
        // lines if they are left standing.
        assert.equal(body.querySelectorAll('p:empty').length, 0);
    });

    test('all in one paragraph with line breaks between, which is the next most common', () => {
        const { body } = only(
            `${para(400)}<p>${img('p1')}<br>${img('p2')}<br>${img('p3')}</p>`
        );

        assert.equal(rows(body).length, 1);
        assert.equal(rows(body)[0].querySelectorAll('.photo').length, 3);
        // The first attempt at this lifted the photos out and left the <br>
        // elements where they were, so the row was followed by two blank
        // lines. Counting empty paragraphs did not notice.
        assert.equal(body.querySelectorAll('br').length, 0);
    });

    test('a few words between two photos keeps them apart', () => {
        // Strictly no text, not "almost none": a caption is the one thing
        // that must not be swallowed, and a character count cannot tell a
        // caption from a stray non-breaking space.
        const { body } = only(`${para(400)}<p>${img('p1')}</p><p>Elena</p><p>${img('p2')}</p>`);

        assert.equal(rows(body).length, 0);
        assert.equal(body.textContent.includes('Elena'), true);
    });

    test('a photo that had text after it stays in the flow, the burst after it does not', () => {
        const { body } = only(
            `${img('p1')}${para(400)}<p>${img('p2')}</p><p>${img('p3')}</p>`
        );

        assert.equal(rows(body).length, 1);
        assert.equal(rows(body)[0].querySelectorAll('.photo').length, 2);
        assert.equal(frames(body)[0].closest('.photo-row'), null);
    });

    test('the last photo of a burst joins it even when the letter goes on', () => {
        const { body } = only(`<p>${img('p1')}</p><p>${img('p2')}</p>${para(400)}`);

        assert.equal(rows(body)[0].querySelectorAll('.photo').length, 2);
    });

    test('a tile drops to the thumbnail and remembers the bigger one', () => {
        // The inline rendition is sized for the column, which is several
        // times more image than a tile can show.
        const { body } = only(`${para(400)}<p>${img('p1')}</p><p>${img('p2')}</p>`);

        const photo = rows(body)[0].querySelector('img');
        assert.equal(photo.getAttribute('src'), stored('p1', 'thumb'));
        assert.equal(photo.dataset.column, stored('p1', 'small'));
        // `data-photo` is what the archive stores, which in the downloaded
        // copy is not a URL this page can display -- so it is no good for
        // putting the column-sized picture back.
        assert.equal(photo.getAttribute('data-photo'), stored('p1'));
    });

    test('a photo in a row is no longer standing on its own', () => {
        const { body } = only(`${para(400)}<p>${img('p1')}</p><p>${img('p2')}</p>`);

        for (const frame of frames(body)) {
            assert.equal(frame.classList.contains('photo--block'), false);
        }
    });

    test('a rule beside the row survives the tidying up', () => {
        // The leftovers are pruned by a list of things known to be packaging
        // rather than by a test for emptiness. An <hr> has no text and no
        // picture either, and the sanitizer goes to some trouble to keep the
        // ones a letter actually contains.
        const { body } = only(`${para(400)}<hr><p>${img('p1')}</p><p>${img('p2')}</p><hr>`);

        assert.equal(body.querySelectorAll('hr').length, 2);
    });
});

describe('opening a photo full size', () => {
    test('clicking a picture in the letter opens the large rendition', () => {
        const { view, body } = only(`${img('p1')}${para(400)}`);

        view.click(body.querySelector('.photo img'));
        assert.equal(view.enlarged(), stored('p1', 'large'));
    });

    test('clicking a tile opens the large one, not the thumbnail it is showing', () => {
        const { view, body } = only(`${para(400)}<p>${img('p1')}</p><p>${img('p2')}</p>`);

        view.click(rows(body)[0].querySelectorAll('img')[1]);
        assert.equal(view.enlarged(), stored('p2', 'large'));
    });

    test('clicking an album thumbnail opens it here rather than navigating away', () => {
        const view = page();
        view.mount({
            posts: [letter('2026-03-25-9CRE', para(400), { photos: [{ id: 'a1' }] })]
        });

        const link = view.$('.album a');
        const event = new view.window.MouseEvent('click', { bubbles: true, cancelable: true });
        link.dispatchEvent(event);

        // The href stays real for "open image in new tab" and for a browser
        // with no JavaScript. The ordinary click is taken over.
        assert.equal(link.getAttribute('href'), stored('a1', 'large'));
        assert.equal(event.defaultPrevented, true);
        // Resolved, because the album hands the lightbox the anchor's href
        // property rather than its attribute. Harmless -- in the downloaded
        // archive it resolves against the folder and still points at the file.
        assert.equal(view.enlarged(), `https://pdayletters.com${stored('a1', 'large')}`);
    });

    test('escape closes it and the photo is dropped', () => {
        const { view, body } = only(`${img('p1')}${para(400)}`);

        view.click(body.querySelector('.photo img'));
        view.key(view.lightbox(), 'Escape');

        assert.equal(view.enlarged(), null);
        // Left in place, the previous picture flashes up for a frame the next
        // time the dialog opens, and a full-size photo sits in memory in the
        // meantime.
        assert.equal(view.lightbox().querySelector('img').hasAttribute('src'), false);
    });
});

describe('the album under the letter', () => {
    test('only holds photos the letter did not already show', () => {
        const view = page();
        view.mount({
            posts: [
                letter('2026-03-25-9CRE', `${img('p1')}${para(400)}`, {
                    photos: [{ id: 'p1' }, { id: 'a1' }, { id: 'a2' }]
                })
            ]
        });

        assert.deepEqual(
            view.$$('.album img').map((el) => el.getAttribute('src')),
            [stored('a1', 'thumb'), stored('a2', 'thumb')]
        );
    });

    test('is absent when every photo is already in the letter', () => {
        const view = page();
        view.mount({
            posts: [letter('2026-03-25-9CRE', `${img('p1')}${para(400)}`, { photos: [{ id: 'p1' }] })]
        });

        assert.equal(view.$('.album'), null);
    });
});

describe('pictures an owner adds', () => {
    const ADDED = { id: 'a2', addedAt: '2026-08-05T10:00:00.000Z' };

    /** The archive as an owner sees it, with the calls recorded. */
    function owner({
        photos = [{ id: 'a1' }, ADDED],
        patch = async () => undefined,
        google = null
    } = {}) {
        const calls = [];
        const view = page();

        view.mount({
            posts: [letter('2026-03-25-9CRE', para(400), { photos })],
            admin: {
                patch: (id, changes, dropPhotos) => {
                    // Copied out of the page's realm, so an assertion out here
                    // compares values rather than prototypes.
                    calls.push({ verb: 'patch', id, dropPhotos: [...dropPhotos] });
                    return patch(id, changes, dropPhotos);
                },
                remove: async () => undefined,
                restore: async () => undefined,
                confirmDelete: () => true,
                confirmRestore: () => true,
                addPhotos: (id, files) => {
                    calls.push({ verb: 'add', id, names: [...files].map((file) => file.name) });
                    return undefined;
                },
                // Left out altogether unless a test asks for it: its absence is
                // what the reader reads to decide whether there is a second
                // source worth drawing a menu for.
                ...(google && {
                    addFromGoogle: (id, say) => {
                        calls.push({ verb: 'google', id });
                        return google(id, say);
                    }
                })
            }
        });

        return { view, calls };
    }

    /** What the file picker hands back, which cannot be assigned to directly. */
    const choose = (view, names) => {
        const picker = view.$('.admin input[type="file"]');
        const files = names.map(
            (name) => new view.window.File([Buffer.from('bytes')], name, { type: 'image/jpeg' })
        );
        Object.defineProperty(picker, 'files', { value: files, configurable: true });
        picker.dispatchEvent(new view.window.Event('change', { bubbles: true }));
        return picker;
    };

    test('a reader is offered nothing at all', () => {
        const view = page();
        view.mount({ posts: [letter('2026-03-25-9CRE', para(400), { photos: [ADDED] })] });

        assert.equal(view.$('.album__remove'), null);
        assert.equal(view.$('.admin'), null);
    });

    test('only the ones an owner added can be taken back off', () => {
        // `a1` arrived with the letter. Removing that is what `Restore
        // original` is for, and the server refuses it here regardless.
        const { view } = owner();

        const tiles = view.$$('.album li');
        assert.equal(tiles[0].querySelector('.album__remove'), null);
        assert.equal(tiles[1].querySelector('.album__remove').getAttribute('aria-label'), 'Remove this picture');
    });

    test('the cross keeps out of the way until the letter is being edited', () => {
        const { view } = owner();
        const drop = view.$('.album__remove');

        assert.equal(drop.hidden, true);

        view.click(view.button('Edit'));
        assert.equal(drop.hidden, false);

        view.click(view.button('Cancel'));
        assert.equal(drop.hidden, true);
    });

    test('crossing one off takes the tile away without asking the server', () => {
        const { view, calls } = owner();
        view.click(view.button('Edit'));

        view.click(view.$('.album__remove'));

        assert.equal(view.$$('.album li')[1].hidden, true);
        assert.deepEqual(calls, []);
    });

    test('Cancel puts the picture back', () => {
        const { view, calls } = owner();
        view.click(view.button('Edit'));
        view.click(view.$('.album__remove'));

        view.click(view.button('Cancel'));

        assert.equal(view.$$('.album li')[1].hidden, false);
        assert.deepEqual(calls, []);
    });

    test('Save sends the letter and the pictures crossed off it together', () => {
        const { view, calls } = owner();
        view.click(view.button('Edit'));
        view.click(view.$('.album__remove'));

        view.click(view.button('Save'));

        assert.deepEqual(calls, [
            { verb: 'patch', id: '2026-03-25-9CRE', dropPhotos: ['a2'] }
        ]);
    });

    test('an edit that crossed nothing off says so', () => {
        const { view, calls } = owner();
        view.click(view.button('Edit'));

        view.click(view.button('Save'));

        assert.deepEqual(calls, [{ verb: 'patch', id: '2026-03-25-9CRE', dropPhotos: [] }]);
    });

    test('a picture crossed off twice is only asked for once', () => {
        const { view, calls } = owner();
        view.click(view.button('Edit'));

        const drop = view.$('.album__remove');
        view.click(drop);
        view.click(drop);
        view.click(view.button('Save'));

        assert.deepEqual(calls, [
            { verb: 'patch', id: '2026-03-25-9CRE', dropPhotos: ['a2'] }
        ]);
    });

    test('a refusal leaves the tile hidden and the edit open', async () => {
        const { view } = owner({
            patch: async () => 'The letter was saved, but a picture could not be taken off it.'
        });
        view.click(view.button('Edit'));
        view.click(view.$('.album__remove'));

        view.click(view.button('Save'));
        await settled();

        assert.equal(
            view.$('.admin__status').textContent,
            'The letter was saved, but a picture could not be taken off it.'
        );
        assert.equal(view.button('Save').hidden, false);
    });

    test('choosing files hands them over and says how many', async () => {
        const { view, calls } = owner();

        view.click(view.button('Add photos'));
        const picker = choose(view, ['antigua.jpg', 'lake.jpg']);
        await settled();

        assert.deepEqual(calls, [
            { verb: 'add', id: '2026-03-25-9CRE', names: ['antigua.jpg', 'lake.jpg'] }
        ]);
        // Cleared so the same file can be chosen again after a failure.
        assert.equal(picker.value, '');
    });

    test('cancelling the picker asks for nothing', async () => {
        const { view, calls } = owner();

        choose(view, []);
        await settled();

        assert.deepEqual(calls, []);
    });

    test('adding is not offered while the letter is being edited', () => {
        // Every other control in that bar is one save of one document. An
        // upload is several commits, and Cancel cannot take those back.
        const { view } = owner();

        view.click(view.button('Edit'));

        assert.equal(view.buttons('Add photos')[0].hidden, true);
    });

    test('one source stays a plain button', () => {
        const { view } = owner();

        assert.equal(view.$('.admin__menu'), null);
        assert.equal(view.button('Add photos').className, 'admin__button');
    });

    test('two sources go behind one menu rather than two buttons', () => {
        const { view } = owner({ google: async () => undefined });

        // The trigger is the menu's summary, so no button answers to the name.
        assert.equal(view.button('Add photos'), undefined);
        assert.equal(view.$('.admin__trigger').textContent, 'Add photos');
        assert.deepEqual(
            view.$$('.admin__item').map((el) => el.textContent),
            ['Google Photos', 'This device']
        );
    });

    test('the device entry shuts the menu and opens the file picker', async () => {
        const { view, calls } = owner({ google: async () => undefined });

        view.$('.admin__menu').open = true;
        view.click(view.button('This device'));
        choose(view, ['antigua.jpg']);
        await settled();

        assert.equal(view.$('.admin__menu').open, false);
        assert.deepEqual(calls, [
            { verb: 'add', id: '2026-03-25-9CRE', names: ['antigua.jpg'] }
        ]);
    });

    test('the Google entry hands over and reports what came back', async () => {
        const { view, calls } = owner({
            google: async () => 'Nothing was picked, so nothing was added.'
        });

        view.$('.admin__menu').open = true;
        view.click(view.button('Google Photos'));
        await settled();

        assert.equal(view.$('.admin__menu').open, false);
        assert.deepEqual(calls, [{ verb: 'google', id: '2026-03-25-9CRE' }]);
        assert.equal(
            view.$('.admin__status').textContent,
            'Nothing was picked, so nothing was added.'
        );
    });
});
