// Searching an archive, and getting from a result to the word itself.
//
// Search is the only feature here that runs on somebody else's copy of the
// data -- the downloaded zip searches with no backend at all -- and it is the
// one people reach for when they already know what they want and cannot find
// it. The interesting behaviour is not "does MiniSearch work" but what happens
// around it: which letters are hidden, which words are marked, what opens, and
// whether emptying the box puts the page back the way it was.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { page, img, para, letter } from './reader-dom.js';

const POSTS = [
    letter('2026-03-25-9CRE', '<p>We hiked up to the lake above Antigua.</p>', {
        subject: 'The lake at last'
    }),
    letter(
        '2026-03-16-28MW',
        `<p>Guatemala is greener than anyone said. Rain every afternoon.</p>${para(300)}`,
        { subject: 'Rain, and more rain' }
    ),
    letter('2026-03-09-R32V', '<p>Nothing but paperwork and beans this week.</p>', {
        subject: 'A quiet week'
    })
];

function archive(posts = POSTS) {
    const view = page();
    view.mount({ posts });
    return view;
}

const shown = (view) => view.$$('.post').filter((el) => !el.hidden).map((el) => el.dataset.post);
const marks = (view) => view.$$('mark.hit').map((el) => el.textContent);

describe('narrowing the list', () => {
    test('only the letters that match stay on the page', () => {
        const view = archive();
        view.search('Antigua');

        assert.deepEqual(shown(view), ['2026-03-25-9CRE']);
        assert.equal(view.elements.searchCount.textContent, '1 of 3 letters match.');
    });

    test('a search nothing answers says so rather than emptying the page in silence', () => {
        const view = archive();
        view.search('zeppelin');

        assert.deepEqual(shown(view), []);
        assert.equal(view.elements.searchCount.textContent, 'No letters match that.');
    });

    test('emptying the box puts the archive back exactly as it loaded', () => {
        const view = archive();
        const before = view.bodies();

        view.search('Antigua');
        view.search('');

        assert.deepEqual(shown(view), POSTS.map((post) => post.id));
        // Marking splits one text node into three and clearing puts three
        // back where one was. Left unmerged, every keystroke fragments the
        // letter a little further and the next search walks the wreckage.
        assert.deepEqual(view.bodies(), before);
        assert.equal(view.$$('mark.hit').length, 0);
        // And the letters go back to newest-open, rather than leaving every
        // one the reader happened to step through hanging open.
        assert.deepEqual(
            view.$$('.post__toggle').map((el) => el.getAttribute('aria-expanded')),
            ['true', 'false', 'false']
        );
    });
});

describe('marking the words themselves', () => {
    test('the word is marked in the letter and in its subject line', () => {
        const view = archive();
        view.search('rain');

        assert.deepEqual(marks(view), ['Rain', 'rain', 'Rain']);
    });

    test('a partial word marks the whole of it', () => {
        // Prefix search is what put the letter in the results, so marking only
        // the four letters typed would leave the reader looking for the rest.
        const view = archive();
        view.search('guat');

        assert.deepEqual(marks(view), ['Guatemala']);
    });

    test('a single letter is not marked anywhere', () => {
        // One character matches somewhere in every letter ever written, and
        // marking them makes the page unreadable rather than searchable.
        const view = archive();
        view.search('a');

        assert.equal(marks(view).length, 0);
    });

    test('a word that only appears in an attribute is not a word in the letter', () => {
        // The body is parsed rather than scanned, so tag names, photo ids and
        // file extensions are not indexed as prose.
        const view = archive([letter('2026-03-25-9CRE', `${img('kites')}${para(400)}`)]);
        view.search('kites');

        assert.deepEqual(shown(view), []);
    });

    test('each letter says how much of what was asked for is inside it', () => {
        const view = archive();
        view.search('rain');

        const summary = view.post('2026-03-16-28MW').querySelector('.post__hits');
        assert.equal(summary.hidden, false);
        assert.equal(summary.textContent, '3 matches');
    });
});

describe('stepping between matches', () => {
    test('the stepper appears only when there is somewhere to step', () => {
        const view = archive();
        const nav = view.$('.search__nav');

        assert.equal(nav.hidden, true);

        view.search('Antigua');
        assert.equal(nav.hidden, false);
        assert.equal(view.$('.search__position').textContent, '1 matches');

        view.search('');
        assert.equal(nav.hidden, true);
    });

    test('next moves through them in the order they appear on the page', () => {
        const view = archive();
        view.search('rain');

        const next = view.$$('.search__step').at(-1);
        view.click(next);
        assert.equal(view.$('.search__position').textContent, '1 of 3');
        assert.equal(view.$('.hit--current').textContent, 'Rain');

        view.click(next);
        assert.equal(view.$('.search__position').textContent, '2 of 3');
        // Only ever one, or the reader cannot tell which one they are on.
        assert.equal(view.$$('.hit--current').length, 1);
    });

    test('previous from a fresh search wraps to the last match', () => {
        // Not to the one before it. `at` starts at -1, and stepping back from
        // nowhere used to arrive two from the end.
        const view = archive();
        view.search('rain');

        const previous = view.$('.search__step');
        view.click(previous);
        assert.equal(view.$('.search__position').textContent, '3 of 3');
    });

    test('stepping onto a hit inside a closed letter opens it', () => {
        // This is the whole reason the letters collapse rather than hide: a
        // hit in a closed letter is still a hit.
        const view = archive();
        view.search('paperwork');

        const toggle = view.post('2026-03-09-R32V').querySelector('.post__toggle');
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');

        view.click(view.$$('.search__step').at(-1));
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        // Centred rather than scrolled to the top, because the search bar is
        // sticky and a hit at the top of the viewport lands underneath it.
        // Read field by field: the options object was made inside the page's
        // own realm, so it is not deep-equal to one made out here.
        const { options } = view.record.scrolled.at(-1);
        assert.equal(options.block, 'center');
        assert.equal(options.behavior, 'smooth');
    });

    test('enter in the search box steps rather than reloading the page', () => {
        const view = archive();
        view.search('rain');

        const event = new view.window.Event('submit', { bubbles: true, cancelable: true });
        view.elements.searchForm.dispatchEvent(event);

        assert.equal(event.defaultPrevented, true);
        assert.equal(view.$('.search__position').textContent, '1 of 3');
    });
});
