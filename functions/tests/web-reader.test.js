// Drawing the archive: what a letter looks like before anybody touches it.
//
// The letters are a list of disclosures, and almost everything here is about
// what is open, what is closed and what the summary line says -- which is the
// only thing most readers ever see, because a full mission collapsed is a
// screen of dates and a full mission expanded is several meters of column.

// Forced west of UTC before anything else runs. The dates in a letter carry no
// timezone -- they are already expressed in the missionary's own offset -- so
// handing one to Date would re-interpret it here and print the day before.
// In a UTC test runner that bug is invisible.
process.env.TZ = 'America/Denver';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { page, img, para, letter } from './reader-dom.js';

const THREE = [
    letter('2026-03-25-9CRE', para(200), { subject: 'Antigua at last' }),
    letter('2026-03-16-28MW', para(200), { subject: 'Rain, and more rain' }),
    letter('2026-03-09-R32V', para(200), { subject: 'A quiet week' })
];

const expanded = (view) => view.$$('.post__toggle').map((el) => el.getAttribute('aria-expanded'));

describe('the shape of the page', () => {
    test('the newest letter is open and the rest are shut', () => {
        const view = page();
        view.mount({ posts: THREE });

        assert.deepEqual(expanded(view), ['true', 'false', 'false']);
        assert.deepEqual(
            view.$$('.post__panel').map((el) => el.hidden),
            [false, true, true]
        );
        assert.equal(view.elements.state.hidden, true);
    });

    test('a heading is a button that owns the panel underneath it', () => {
        // The heading wraps the button rather than the other way round: a
        // <button> may only contain phrasing content, so an <h2> inside one
        // is invalid and heading navigation would lose the letters entirely.
        const view = page();
        view.mount({ posts: THREE });

        const item = view.post('2026-03-25-9CRE');
        const toggle = item.querySelector('.post__toggle');
        assert.equal(toggle.parentElement.tagName, 'H2');
        assert.equal(toggle.getAttribute('aria-controls'), 'panel-2026-03-25-9CRE');
        assert.equal(item.querySelector('.post__panel').id, 'panel-2026-03-25-9CRE');
    });

    test('clicking a heading opens its letter and clicking again shuts it', () => {
        const view = page();
        view.mount({ posts: THREE });

        const toggle = view.post('2026-03-09-R32V').querySelector('.post__toggle');
        view.click(toggle);
        assert.deepEqual(expanded(view), ['true', 'false', 'true']);

        view.click(toggle);
        assert.deepEqual(expanded(view), ['true', 'false', 'false']);
    });

    test('one control opens the whole archive and then closes it again', () => {
        const view = page();
        view.mount({ posts: THREE });

        const all = view.button('Expand all');
        view.click(all);
        assert.deepEqual(expanded(view), ['true', 'true', 'true']);
        assert.equal(all.textContent, 'Collapse all');

        view.click(all);
        assert.deepEqual(expanded(view), ['false', 'false', 'false']);
        assert.equal(all.textContent, 'Expand all');
    });

    test('there is no expand-all on an archive with one letter in it', () => {
        const view = page();
        view.mount({ posts: [THREE[0]] });

        assert.equal(view.$('.toolbar'), null);
    });
});

// Every link in a digest email names one letter. Without this the page opens
// the newest one instead, and a reader who chose a subject line out of their
// inbox arrives at a list of dates and has to find it again.
describe('arriving from a link that names a letter', () => {
    const at = (hash) => page({ url: `https://pdayletters.com/isaac.backman/${hash}` });

    test('the named letter is the one that is open', () => {
        const view = at('#panel-2026-03-09-R32V');
        view.mount({ posts: THREE });

        assert.deepEqual(expanded(view), ['false', 'false', 'true']);
    });

    test('and the page is scrolled to it, because it is at the bottom', () => {
        const view = at('#panel-2026-03-09-R32V');
        view.mount({ posts: THREE });

        assert.equal(view.record.scrolled.at(-1).node, view.post('2026-03-09-R32V'));
    });

    test('a letter that is no longer here leaves the page as it was', () => {
        // Hidden by an owner, or deleted, between the email going out and
        // somebody reading it. The archive still has to open.
        const view = at('#panel-2019-01-01-GONE');
        view.mount({ posts: THREE });

        assert.deepEqual(expanded(view), ['true', 'false', 'false']);
    });

    test('a fragment that is not one of ours is ignored', () => {
        const view = at('#main');
        view.mount({ posts: THREE });

        assert.deepEqual(expanded(view), ['true', 'false', 'false']);
    });
});

describe('the summary line', () => {
    test('says how many photos are inside without opening the letter', () => {
        const view = page();
        view.mount({
            posts: [
                letter('2026-03-25-9CRE', para(200), { photos: [{ id: 'a1' }] }),
                letter('2026-03-16-28MW', para(200), { photos: [{ id: 'b1' }, { id: 'b2' }] }),
                letter('2026-03-09-R32V', para(200))
            ]
        });

        assert.deepEqual(
            view.$$('.post').map((el) => el.querySelector('.post__count')?.textContent ?? null),
            ['1 photo', '2 photos', null]
        );
    });

    test('a letter that arrived without a subject still has something to click', () => {
        const view = page();
        view.mount({ posts: [letter('2026-03-25-9CRE', para(200), { subject: '' })] });

        assert.equal(view.$('.post__title').textContent, 'Untitled');
    });

    test('the date is the missionary\'s day, not the reader\'s', () => {
        const view = page();

        // Run in Denver. A naive parse of a date-only string treats it as UTC
        // midnight and prints the 2nd here, which is the wrong day for
        // everyone reading from a different continent -- and that is most of
        // the audience.
        const shown = view.formatDate('2026-08-03');
        assert.match(shown, /\b3\b/);
        assert.match(shown, /2026/);
    });

    test('a date the pipeline could not produce prints nothing rather than "Invalid Date"', () => {
        const view = page();

        assert.equal(view.formatDate(''), '');
        assert.equal(view.formatDate(undefined), '');
        assert.equal(view.formatDate('sometime in March'), '');
    });
});

describe('what a letter says about itself', () => {
    test('a letter held for review is dimmed, and says why', () => {
        // Readers never receive these at all. The marking is for the owner,
        // who otherwise cannot tell a held letter from a published one.
        const view = page();
        view.mount({
            posts: [letter('2026-03-25-9CRE', para(200), { hidden: true, heldReason: 'over the daily cap' })]
        });

        assert.ok(view.post('2026-03-25-9CRE').classList.contains('post--hidden'));
        assert.equal(view.$('.post__held').textContent, 'Hidden — over the daily cap');
    });

    test('a letter hidden by an owner carries no reason but is still marked', () => {
        // Hiding by hand sets no `heldReason` -- only the ingest guard does --
        // so the sentence has to read without one.
        const view = page();
        view.mount({ posts: [letter('2026-03-25-9CRE', para(200), { hidden: true })] });

        assert.equal(view.$('.post__held').textContent, 'Hidden — by an owner');
    });

    test('a published letter is neither dimmed nor marked', () => {
        const view = page();
        view.mount({ posts: [letter('2026-03-25-9CRE', para(200))] });

        assert.equal(view.post('2026-03-25-9CRE').classList.contains('post--hidden'), false);
        assert.equal(view.$('.post__held'), null);
    });

    // The flag is still recorded on the post. It is evidence for a decision
    // about fetching these albums, not something a reader is told: the link it
    // describes is already there in the letter, spelled out as a link.
    test('a linked album is recorded without being announced', () => {
        const view = page();
        view.mount({
            posts: [
                letter('2026-03-25-9CRE', para(200), {
                    linkedPhotoServices: ['https://photos.app.goo.gl/example']
                })
            ]
        });

        assert.equal(view.$('.post__panel .note'), null);
    });

    test('a letter that never rendered still shows its words', () => {
        const view = page();
        view.mount({
            posts: [
                letter('2026-03-25-9CRE', '', { bodyText: 'Plain text, and <b>not</b> markup.' })
            ]
        });

        // Set as text, so the DOM escapes it rather than us.
        assert.equal(view.$('.post__body').textContent, 'Plain text, and <b>not</b> markup.');
        assert.equal(view.$('.post__body b'), null);
    });
});

describe('an archive with nothing in it yet', () => {
    test('says where to send the first letter when there is somewhere to send it', () => {
        const view = page();
        view.mount({
            posts: [],
            help: { address: 'isaac@pdayletters.com', href: '/faq#nothing-happened' }
        });

        assert.equal(view.elements.state.hidden, false);
        assert.match(view.elements.state.textContent, /^No letters have arrived yet\./);
        assert.match(view.elements.state.textContent, /isaac@pdayletters\.com/);
        assert.equal(view.$('#state a').getAttribute('href'), '/faq#nothing-happened');
    });

    test('says only the first sentence inside a downloaded folder', () => {
        // There is no site to link to and no address worth naming in a zip on
        // a plane, and neither is something the reader could act on anyway.
        const view = page();
        view.mount({ posts: [] });

        assert.equal(view.elements.state.textContent, 'No letters have arrived yet.');
        assert.equal(view.$('#state a'), null);
    });

    test('draws nothing else at all', () => {
        const view = page();
        view.mount({ posts: [] });

        assert.equal(view.$('.post'), null);
        assert.equal(view.$('.toolbar'), null);
        // The search form stays hidden: there is nothing to search, and a box
        // that answers every query with "no letters match" is worse than no box.
        assert.equal(view.elements.searchForm.hidden, true);
    });
});

describe('the letters and the pictures together', () => {
    test('a letter opens with its photos already decorated', () => {
        const view = page();
        view.mount({ posts: [letter('2026-03-25-9CRE', `${img('p1')}${para(400)}`)] });

        assert.equal(view.$$('.photo').length, 1);
        assert.equal(view.$('.photo img').getAttribute('data-photo'), '/api/photo/isaac.backman/p1/small.webp');
    });
});
