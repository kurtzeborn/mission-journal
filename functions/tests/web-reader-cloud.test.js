// The word cloud.
//
// Every other view of an archive is organised by date, which is the one thing
// about a letter nobody remembers. The cloud is organised by what is in them,
// and it is only worth the screen it takes if the words it shows are the words
// that were actually written -- so the tests here are about the counting as
// much as the window: what gets thrown away, what gets kept, and what happens
// to the list behind when somebody picks a word out of it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { page, letter } from './reader-dom.js';

const POSTS = [
    letter(
        '2026-03-25-9CRE',
        '<p>Rain, rain, rain. Antigua was underwater and the bus never came.</p>'
    ),
    letter(
        '2026-03-16-28MW',
        '<p>Rain again in Antigua. We taught Ana about the bus timetable.</p>'
    ),
    letter(
        '2026-03-09-R32V',
        '<p>Ana fed us beans. Antigua is beautiful when it is not raining.</p>'
    )
];

// Enough distinct words for the scatter to have something to scatter, with one
// of them well ahead of the rest so there is a biggest word to point at.
const BUSY = [
    letter(
        '2026-04-20-1AAA',
        `<p>${'Volcano '.repeat(9)} chapel cathedral district baptism candles branch canoe earthquake.</p>`
    ),
    letter(
        '2026-04-13-2BBB',
        '<p>Volcano chapel cathedral district apartment blackout children coffee companion cobblestones.</p>'
    ),
    letter(
        '2026-04-06-3CCC',
        '<p>Volcano chapel district apartment blackout children coffee dog elder market mountain.</p>'
    )
];

function archive(posts = POSTS) {
    const view = page();
    view.mount({ posts });
    return view;
}

function opened(posts = POSTS) {
    const view = archive(posts);
    view.click(view.button('Word cloud'));
    return view;
}

const sizeOf = (view, word) =>
    Number.parseFloat(view.$(`.cloud__word[data-word="${word}"]`).style.fontSize);

describe('getting to the cloud', () => {
    test('it is a button on the same row as Expand all, at the other end of it', () => {
        const view = archive();
        const toolbar = view.$('.toolbar');

        // Expand all sits on the right, over the Expand buttons it works on.
        assert.deepEqual(
            [...toolbar.querySelectorAll('button')].map((el) => el.textContent),
            ['Word cloud', 'Expand all']
        );
    });

    test('nothing is counted until somebody asks for it', () => {
        // Most readers never open it, and walking every letter on the way to
        // drawing a page they are not looking at is a cost they should not pay.
        const view = archive();

        assert.equal(view.cloud(), null);
    });

    test('a single letter is not an archive, so it gets no toolbar at all', () => {
        const view = archive([POSTS[0]]);

        assert.equal(view.$('.toolbar'), null);
    });

    test('opening it puts a modal over the letters', () => {
        const view = opened();

        assert.equal(view.cloud().hasAttribute('open'), true);
        assert.equal(view.cloud().getAttribute('aria-labelledby'), 'cloud-title');
    });
});

describe('what the cloud is made of', () => {
    test('the words the letters keep coming back to are in it', () => {
        const view = opened();

        for (const word of ['rain', 'antigua', 'bus', 'ana', 'beans']) {
            assert.ok(view.cloudWords().includes(word), `expected ${word}`);
        }
    });

    test('the words a sentence needs rather than a letter are not', () => {
        // A cloud of "the", "and" and "was" is a cloud of English, not of
        // somebody's two years.
        const view = opened();

        for (const word of ['the', 'and', 'was', 'about', 'when', 'not']) {
            assert.ok(!view.cloudWords().includes(word), `did not expect ${word}`);
        }
    });

    test('short words and numbers are left out', () => {
        const view = opened([
            letter('2026-03-25-9CRE', '<p>We ate at 7 on 2026-03-25 in a hut by the sea.</p>'),
            letter('2026-03-16-28MW', '<p>The hut by the sea again, and the sea again.</p>')
        ]);

        assert.deepEqual(view.cloudWords().sort(), ['again', 'ate', 'hut', 'sea']);
    });

    test('subject lines are not letters, so they are not counted', () => {
        // Every fixture subject reads "Week of ...", and an archive whose
        // biggest word is "week" has learned nothing about itself.
        const view = opened();

        assert.ok(!view.cloudWords().includes('week'));
    });

    test('the words are scattered rather than sorted, so the eye wanders over them', () => {
        const words = opened().cloudWords();

        assert.ok(words.length > 3);
        assert.notDeepEqual(words, [...words].sort((a, b) => a.localeCompare(b)));
    });

    test('the same archive scatters the same way every time it is opened', () => {
        assert.deepEqual(opened().cloudWords(), opened().cloudWords());
    });

    test('some of them stand on their end, and the biggest never do', () => {
        const view = opened(BUSY);
        const upright = view.$$('.cloud__word--upright');

        assert.ok(upright.length > 0);
        for (const word of upright) {
            assert.ok(Number.parseFloat(word.style.fontSize) < 1.9, word.dataset.word);
        }
    });
});

describe('how big a word is', () => {
    test('the one that came up most is the biggest', () => {
        // Rain four times, Antigua three, beans once.
        const view = opened();

        assert.ok(sizeOf(view, 'rain') > sizeOf(view, 'antigua'));
        assert.ok(sizeOf(view, 'antigua') > sizeOf(view, 'beans'));
    });

    test('the smallest word is still a readable size', () => {
        const view = opened();

        assert.ok(sizeOf(view, 'beans') >= 1, sizeOf(view, 'beans'));
        assert.ok(sizeOf(view, 'rain') <= 2.6, sizeOf(view, 'rain'));
    });

    test('an archive where everything came up once has no biggest word', () => {
        const view = opened([
            letter('2026-03-25-9CRE', '<p>Volcano.</p>'),
            letter('2026-03-16-28MW', '<p>Chicken.</p>')
        ]);

        assert.equal(sizeOf(view, 'volcano'), sizeOf(view, 'chicken'));
    });

    test('each word says how often it came up, for somebody who cannot see the size', () => {
        const view = opened();

        assert.equal(
            view.$('.cloud__word[data-word="rain"]').getAttribute('aria-label'),
            'rain, 4 times'
        );
        assert.equal(
            view.$('.cloud__word[data-word="beans"]').getAttribute('aria-label'),
            'beans, 1 time'
        );
    });
});

describe('picking a word out of it', () => {
    test('the word goes into the search box and the cloud gets out of the way', () => {
        const view = opened();

        view.click(view.$('.cloud__word[data-word="timetable"]'));

        assert.equal(view.cloud().hasAttribute('open'), false);
        assert.equal(view.elements.searchInput.value, 'timetable');
    });

    test('the list narrows to the letters that word is in', () => {
        const view = opened();

        view.click(view.$('.cloud__word[data-word="timetable"]'));

        const shown = view.$$('.post').filter((el) => !el.hidden).map((el) => el.dataset.post);
        assert.deepEqual(shown, ['2026-03-16-28MW']);
        assert.equal(view.$('.search__position').textContent, '1 match in 1 letter');
    });

    test('the search bar is scrolled to, because it is where the answer now is', () => {
        const view = opened();

        view.click(view.$('.cloud__word[data-word="timetable"]'));

        const last = view.record.scrolled.at(-1);
        assert.equal(last.node, view.elements.searchForm);
    });
});

describe('getting out of the cloud', () => {
    test('the x shuts it', () => {
        const view = opened();

        view.click(view.$('.cloud__close'));

        assert.equal(view.cloud().hasAttribute('open'), false);
    });

    test('escape shuts it', () => {
        const view = opened();

        view.key(view.cloud(), 'Escape');

        assert.equal(view.cloud().hasAttribute('open'), false);
    });

    test('clicking away from the words shuts it', () => {
        const view = opened();

        view.click(view.cloud());

        assert.equal(view.cloud().hasAttribute('open'), false);
    });

    test('it is counted once and reopens on the same words', () => {
        const view = opened();
        const first = view.cloudWords();

        view.click(view.$('.cloud__close'));
        view.click(view.button('Word cloud'));

        assert.equal(view.cloud().hasAttribute('open'), true);
        assert.deepEqual(view.cloudWords(), first);
    });
});
