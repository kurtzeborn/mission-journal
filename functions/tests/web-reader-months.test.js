// Months, which are the archive's table of contents.
//
// There is no menu and no second list: a month is a heading in the list of
// letters, and folding it shuts the letters underneath it away. That choice is
// what these tests are really about -- because it means the folding has to
// stay out of the way of everything else the page already does. A digest link
// lands inside a folded month. A search hit is inside one. Expand all has two
// kinds of thing to expand now. Each of those is a way for a letter to become
// unreachable while the page looks perfectly fine.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { page, letter } from './reader-dom.js';

// Three months, and enough letters in them to cross the folding threshold.
const MANY = [
    ...['25', '18', '11', '04'].map((day) => letter(`2026-03-${day}-A${day}`, '<p>March.</p>')),
    ...['25', '18', '11', '04'].map((day) => letter(`2026-02-${day}-B${day}`, '<p>February.</p>')),
    ...['28', '21', '14', '07', '01'].map((day) =>
        letter(`2026-01-${day}-C${day}`, '<p>January.</p>')
    )
];

// The same three months, kept short enough to stay under it.
const FEW = [
    letter('2026-03-25-A25', '<p>March.</p>'),
    letter('2026-02-18-B18', '<p>February.</p>'),
    letter('2026-01-07-C07', '<p>January.</p>')
];

function archive(posts = MANY, hash = '') {
    const view = page({ url: `https://pdayletters.com/isaac.backman${hash}` });
    view.mount({ posts });
    return view;
}

const months = (view) => view.$$('.month').filter((el) => !el.hidden);
const headings = (view) => months(view).map((el) => el.querySelector('.month__name').textContent);
const counts = (view) => months(view).map((el) => el.querySelector('.month__count').textContent);
const folded = (view) => months(view).map((el) => el.classList.contains('month--folded'));

/** The letters a reader can actually see, in page order. */
const reachable = (view) =>
    view.$$('.post')
        .filter((el) => !el.hidden)
        .filter((el) => !el.closest('.month__posts')?.hidden && !el.closest('.month')?.hidden)
        .map((el) => el.dataset.post);

describe('the shape of the list', () => {
    test('letters are gathered under the month they were written in', () => {
        const view = archive();

        assert.deepEqual(headings(view), ['March 2026', 'February 2026', 'January 2026']);
        assert.deepEqual(counts(view), ['4 letters', '4 letters', '5 letters']);
    });

    test('a month keeps its letters in the order they were already in', () => {
        const view = archive();
        const march = view.$('.month__posts');

        assert.deepEqual(
            [...march.querySelectorAll('.post')].map((el) => el.dataset.post),
            ['2026-03-25-A25', '2026-03-18-A18', '2026-03-11-A11', '2026-03-04-A04']
        );
    });

    test('an archive that fits in one month is not grouped at all', () => {
        // A single heading over the whole list is a row that says nothing the
        // page had not already said.
        const view = archive([
            letter('2026-03-25-A25', '<p>One.</p>'),
            letter('2026-03-18-A18', '<p>Two.</p>')
        ]);

        assert.deepEqual(headings(view), []);
        assert.equal(view.$$('.post').length, 2);
    });

    test('a letter nobody can date leaves the whole archive ungrouped', () => {
        // Rather than mostly grouped, with one heading that has no month to
        // put in it.
        const view = archive([
            letter('2026-03-25-A25', '<p>One.</p>'),
            { ...letter('2026-02-18-B18', '<p>Two.</p>'), originalDate: '' }
        ]);

        assert.deepEqual(headings(view), []);
        assert.equal(view.$$('.post').length, 2);
    });
});

describe('what is folded when the page arrives', () => {
    test('a long archive arrives folded, with the newest month left open', () => {
        // Thirteen letters is more than a screen of dates, so the contents are
        // worth having. The month holding the open letter cannot be shut.
        const view = archive();

        assert.deepEqual(folded(view), [false, true, true]);
        assert.deepEqual(reachable(view), [
            '2026-03-25-A25',
            '2026-03-18-A18',
            '2026-03-11-A11',
            '2026-03-04-A04'
        ]);
    });

    test('a short one arrives open, because folding it would hide a short list', () => {
        const view = archive(FEW);

        assert.deepEqual(folded(view), [false, false, false]);
        assert.deepEqual(reachable(view), FEW.map((post) => post.id));
    });

    test('the newest letter is open inside its month either way', () => {
        for (const posts of [MANY, FEW]) {
            const view = archive(posts);
            const open = view.$$('.post--open').map((el) => el.dataset.post);
            assert.deepEqual(open, [posts[0].id]);
        }
    });
});

describe('folding a month by hand', () => {
    const monthToggle = (view, name) =>
        view.$$('.month__toggle').find((el) => el.textContent.startsWith(name));

    test('shutting a month takes its letters off the page', () => {
        const view = archive(FEW);

        view.click(monthToggle(view, 'February 2026'));

        assert.deepEqual(folded(view), [false, true, false]);
        assert.deepEqual(reachable(view), ['2026-03-25-A25', '2026-01-07-C07']);
    });

    test('opening one puts them back, still shut', () => {
        const view = archive();

        view.click(monthToggle(view, 'January 2026'));

        assert.deepEqual(folded(view), [false, true, false]);
        assert.equal(reachable(view).length, 9);
        // Opened the month, not the letters inside it.
        assert.deepEqual(view.$$('.post--open').map((el) => el.dataset.post), ['2026-03-25-A25']);
    });

    test('the heading says whether it is open, for anyone who cannot see it', () => {
        const view = archive(FEW);
        const february = monthToggle(view, 'February 2026');

        assert.equal(february.getAttribute('aria-expanded'), 'true');
        assert.equal(
            february.getAttribute('aria-controls'),
            view.$('.month:nth-child(2) .month__posts').id
        );

        view.click(february);
        assert.equal(february.getAttribute('aria-expanded'), 'false');
    });
});

describe('getting into a folded month from outside it', () => {
    test('a link from the digest opens the letter and the month around it', () => {
        // Without this every link in that email lands on an archive whose
        // letter is present, shut, and inside something else that is shut.
        const view = archive(MANY, '#panel-2026-01-14-C14');

        assert.deepEqual(view.$$('.post--open').map((el) => el.dataset.post), ['2026-01-14-C14']);
        assert.ok(reachable(view).includes('2026-01-14-C14'));
        // And exactly one month is open: the one that was asked for.
        assert.deepEqual(folded(view), [true, true, false]);
    });

    test('a search hit opens the month it is buried in', () => {
        const view = archive([
            ...MANY,
            letter('2026-01-09-C09', '<p>We climbed the volcano at Antigua.</p>')
        ]);

        view.search('volcano');
        view.click(view.$$('.search__step')[1]);

        assert.ok(reachable(view).includes('2026-01-09-C09'));
    });

    test('searching opens every month, so nothing is answered from behind a fold', () => {
        const view = archive();
        view.search('February');

        assert.deepEqual(folded(view), [false]);
    });

    test('emptying the box folds them back the way they started', () => {
        const view = archive();

        view.search('February');
        view.search('');

        assert.deepEqual(folded(view), [false, true, true]);
    });
});

describe('what a month says while a search is running', () => {
    test('a month with nothing left in it goes with its letters', () => {
        const view = archive();
        view.search('February');

        assert.deepEqual(headings(view), ['February 2026']);
    });

    test('the count is what the month is showing, not what it holds', () => {
        // A heading claiming four letters above one letter is a heading that
        // has to be argued with.
        const view = archive([
            letter('2026-03-25-A25', '<p>We hiked above Antigua.</p>'),
            letter('2026-03-18-A18', '<p>Paperwork.</p>'),
            letter('2026-02-18-B18', '<p>Beans.</p>')
        ]);

        view.search('Antigua');
        assert.deepEqual(counts(view), ['1 letter']);

        view.search('');
        assert.deepEqual(counts(view), ['2 letters', '1 letter']);
    });
});

describe('expand all', () => {
    test('opens the months as well as the letters', () => {
        const view = archive();

        view.click(view.button('Expand all'));

        assert.deepEqual(folded(view), [false, false, false]);
        assert.equal(view.$$('.post--open').length, MANY.length);
    });

    test('and shuts them again on the way back', () => {
        const view = archive();

        view.click(view.button('Expand all'));
        view.click(view.button('Collapse all'));

        assert.deepEqual(folded(view), [true, true, true]);
        assert.equal(view.$$('.post--open').length, 0);
    });
});
