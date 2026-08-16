// The owner's controls, and the one function whose output is written to
// storage.
//
// `markup()` is the sharpest edge in the reader. Everything the page adds to a
// letter for display -- the button around each photo, the row a burst of them
// is collected into, the marks a search left behind -- is invented here and
// exists nowhere in the archive. If any of it reaches the server the sanitizer
// strips it on the way in, and for a photo frame that means the picture inside
// goes with it. One bad save deletes every photograph in a letter.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { page, img, para, letter, stored } from './reader-dom.js';
import { settled } from './web-dom.js';

const BODY = `${img('p1')}${para(400)}<p>${img('p2')}</p><p>${img('p3')}</p>`;

/** An archive of one letter with owner controls, opened for editing. */
function owner({ body = BODY, patch = async () => undefined, remove = async () => undefined, confirm = true } = {}) {
    const calls = [];
    const view = page();

    view.mount({
        posts: [letter('2026-03-25-9CRE', body, { subject: 'Antigua at last' })],
        admin: {
            patch: (id, changes) => {
                // Copied out of the page's realm, so an assertion out here
                // compares values rather than prototypes.
                calls.push({ verb: 'patch', id, changes: JSON.parse(JSON.stringify(changes)) });
                return patch(id, changes);
            },
            remove: (id) => {
                calls.push({ verb: 'remove', id });
                return remove(id);
            },
            confirmDelete: () => {
                calls.push({ verb: 'confirm' });
                return confirm;
            }
        }
    });

    return { view, calls, letterBody: view.$('.post__body'), field: view.$('.admin__subject') };
}

const saved = (calls) => calls.find((call) => call.verb === 'patch')?.changes ?? null;

describe('going in and coming out of an edit', () => {
    test('editing swaps the controls and puts the subject in a field of its own', () => {
        const { view, field } = owner();

        view.click(view.button('Edit'));

        assert.equal(view.button('Save').hidden, false);
        assert.equal(view.buttons('Edit')[0].hidden, true);
        assert.equal(view.buttons('Hide')[0].hidden, true);
        // A single line that has to survive as one. An editable heading
        // invites a paragraph break the data model has nowhere to put.
        assert.equal(field.hidden, false);
        assert.equal(field.value, 'Antigua at last');
        assert.equal(view.$('.post .post__subject').hidden, true);
    });

    test('the letter is handed over without any of the page\'s own decoration', () => {
        const { view, letterBody } = owner();

        view.click(view.button('Edit'));

        // The frames are buttons, which behave badly inside an editable
        // region, and the search marks are not the owner's words. Left in
        // place, the owner would be editing something the archive does not
        // contain.
        assert.equal(letterBody.querySelectorAll('.photo').length, 0);
        assert.equal(letterBody.querySelectorAll('.photo-row').length, 0);
        assert.equal(letterBody.querySelectorAll('img').length, 3);
        assert.equal(letterBody.getAttribute('contenteditable'), 'true');
        assert.equal(letterBody.getAttribute('role'), 'textbox');
    });

    test('a tiled photo goes back to its column-sized picture, not the thumbnail', () => {
        // The row swaps in a small rendition to draw the tile. An owner left
        // looking at thumbnails would think the archive had lost the photos.
        const { view, letterBody } = owner();

        view.click(view.button('Edit'));

        assert.deepEqual(
            [...letterBody.querySelectorAll('img')].map((el) => el.getAttribute('src')),
            [stored('p1'), stored('p2'), stored('p3')]
        );
    });

    test('cancel redraws the letter from the copy the page loaded', () => {
        const { view, letterBody } = owner();
        const before = letterBody.innerHTML;

        view.click(view.button('Edit'));
        letterBody.innerHTML = '<p>Everything is different now.</p>';
        view.click(view.button('Cancel'));

        assert.equal(letterBody.innerHTML, before);
        assert.equal(letterBody.hasAttribute('contenteditable'), false);
        assert.equal(view.buttons('Edit')[0].hidden, false);
    });

    test('escape backs out of an edit begun by accident', () => {
        const { view, letterBody, calls } = owner();

        view.click(view.button('Edit'));
        view.key(letterBody, 'Escape');

        assert.equal(letterBody.hasAttribute('contenteditable'), false);
        assert.deepEqual(calls, []);
    });
});

describe('what actually gets saved', () => {
    test('the photos go back as the archive stores them', () => {
        const { view, calls } = owner();

        view.click(view.button('Edit'));
        view.click(view.button('Save'));

        const html = saved(calls).bodyHtml;
        for (const id of ['p1', 'p2', 'p3']) {
            assert.equal(html.includes(`src="${stored(id)}"`), true);
        }
        // Display-only attributes, added after parsing. The stored markup for
        // letters already in the archive does not carry them and should not
        // acquire them by being edited.
        assert.equal(html.includes('data-photo'), false);
        assert.equal(html.includes('loading='), false);
        assert.equal(html.includes('decoding='), false);
    });

    test('nothing the page invented is in it', () => {
        const { view, calls } = owner();

        view.click(view.button('Edit'));
        view.click(view.button('Save'));

        const html = saved(calls).bodyHtml;
        assert.equal(html.includes('photo-row'), false);
        assert.equal(html.includes('class="photo"'), false);
        assert.equal(html.includes('<button'), false);
    });

    test('a search left marking the letter does not get saved into it', () => {
        // `open()` clears the marks from the live body already. This is the
        // belt to that pair of braces, and it is the one function whose
        // output is written to storage.
        const { view, calls, letterBody } = owner({ body: para(400, 'Antigua') });

        view.search('Antigua');
        view.click(view.button('Edit'));
        // Put one back by hand, as a stray edit or a re-render could.
        letterBody.innerHTML = `<p>Back in <mark class="hit">Antigua</mark> again.</p>`;
        view.click(view.button('Save'));

        const html = saved(calls).bodyHtml;
        assert.equal(html.includes('<mark'), false);
        assert.equal(html.includes('Back in Antigua again.'), true);
    });

    test('the subject travels with the letter', () => {
        const { view, calls, field } = owner();

        view.click(view.button('Edit'));
        field.value = 'Antigua, finally';
        view.click(view.button('Save'));

        assert.equal(saved(calls).subject, 'Antigua, finally');
    });

    test('enter in the subject line commits rather than adding a line to it', () => {
        const { view, calls, field } = owner();

        view.click(view.button('Edit'));
        field.value = 'Antigua, finally';
        view.key(field, 'Enter');

        assert.equal(saved(calls).subject, 'Antigua, finally');
    });

    test('a save the server refuses leaves the letter alone and says why', async () => {
        // Everything that succeeds reloads the page, so anything on screen
        // here is a failure the owner has to read.
        const { view, letterBody } = owner({ patch: async () => 'That archive is read-only.' });

        view.click(view.button('Edit'));
        letterBody.innerHTML = '<p>An hour of careful work.</p>';
        view.click(view.button('Save'));
        await settled();

        assert.equal(view.$('.admin__status').textContent, 'That archive is read-only.');
        // Still editing, with the typing intact. Closing the editor on a
        // failed save would throw away the work and say so afterwards.
        assert.equal(letterBody.getAttribute('contenteditable'), 'true');
        assert.equal(letterBody.innerHTML, '<p>An hour of careful work.</p>');
    });
});

describe('hiding and deleting', () => {
    test('hide and unhide are the same button asking for the opposite', () => {
        const { view, calls } = owner();

        view.click(view.button('Hide'));
        assert.deepEqual(saved(calls), { hidden: true });
    });

    test('deleting asks first, and a refusal sends nothing', () => {
        const { view, calls } = owner({ confirm: false });

        view.click(view.button('Delete'));

        assert.deepEqual(calls.map((call) => call.verb), ['confirm']);
    });

    test('deleting after agreeing to it goes through', () => {
        const { view, calls } = owner();

        view.click(view.button('Delete'));

        assert.deepEqual(calls.map((call) => call.verb), ['confirm', 'remove']);
    });
});

describe('editing the letter where it sits', () => {
    test('the browser is asked for tags rather than styled spans', () => {
        // The sanitizer allows <b> and strips every style attribute, so a
        // browser left to its own devices would drop the owner's formatting
        // on save without saying anything.
        const { view } = owner();

        view.click(view.button('Edit'));
        assert.deepEqual(view.record.commands, [{ command: 'styleWithCSS', value: false }]);
    });

    test('the shortcuts people already know do what they look like', () => {
        const { view, letterBody } = owner();

        view.click(view.button('Edit'));
        view.key(letterBody, 'b', { ctrlKey: true });
        view.key(letterBody, 'i', { metaKey: true });

        assert.deepEqual(
            view.record.commands.map((call) => call.command),
            ['styleWithCSS', 'bold', 'italic']
        );
    });

    test('a chord that means something else is left to the browser', () => {
        const { view, letterBody } = owner();

        view.click(view.button('Edit'));
        view.key(letterBody, 'b', { ctrlKey: true, altKey: true });
        view.key(letterBody, 'z', { ctrlKey: true });

        assert.deepEqual(view.record.commands.map((call) => call.command), ['styleWithCSS']);
    });

    test('clicking a picture while editing selects it instead of enlarging it', () => {
        // Clicking one only puts the caret beside it, so Delete does nothing
        // and the owner is left prodding at a photo that will not go away.
        const { view, letterBody } = owner();

        view.click(view.button('Edit'));
        const photo = letterBody.querySelector('img');
        view.click(photo);

        assert.equal(view.enlarged(), null);
        const selection = view.window.getSelection();
        assert.equal(selection.rangeCount, 1);
        assert.equal(selection.getRangeAt(0).startContainer, photo.parentElement);
    });
});
