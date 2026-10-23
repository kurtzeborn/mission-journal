import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { cloudScale, countWords, wordsIn } from '../src/lib/words.js';
import { page } from './reader-dom.js';

const zipf = (count) => Array.from({ length: count }, (_, n) => [`word${n}`, count - n]);

describe('scaling the cloud for DOM elements and print boxes', () => {
    test('sets a word at the same size whether dimensions come from a box or an element', () => {
        const view = page();
        const words = zipf(40);

        const ours = cloudScale(words, { width: 444, height: 586 });
        const them = view.window.Reader.cloudScale(words, { clientWidth: 444, clientHeight: 586 });

        for (const [, count] of words) {
            assert.ok(Math.abs(ours(count) - them(count)) < 1e-9, `${count} sized differently`);
        }
    });
});

describe('the countable words of a letter', () => {
    test('drops the words that are in every sentence', () => {
        assert.deepEqual(wordsIn('We walked to the chapel and it was very cold'), [
            'walked',
            'chapel',
            'cold'
        ]);
    });

    test('drops routine language while keeping meaningful themes', () => {
        assert.deepEqual(
            wordsIn(
                'Week really lots come getting read little aboard between during inside toward via without home love notwithstanding underneath'
            ),
            ['home', 'love', 'notwithstanding', 'underneath']
        );
    });

    test('drops years, house numbers and two-letter scraps', () => {
        assert.deepEqual(wordsIn('In 2026 we moved to 14 Rua do Sol'), ['moved', 'rua', 'sol']);
    });

    test('folds an apostrophe away so a word is one word', () => {
        assert.deepEqual(wordsIn("We couldn\u2019t and we couldnt"), ['couldnt', 'couldnt']);
    });

    test('refuses to count a pasted link as vocabulary', () => {
        // The share ids are the reason this exists: split on punctuation they
        // come out as pronounceable runs, and an archive full of photo links
        // finds its commonest word is a fragment of a URL.
        assert.deepEqual(
            wordsIn('Photos at https://photos.app.goo.gl/egtkcgtKxqodvf from the baptism'),
            ['photos', 'baptism']
        );
    });
});

describe('tallying a whole archive', () => {
    const letters = [
        'The baptism was the baptism we had waited for',
        'A baptism and a transfer in the same week',
        'Transfer week again'
    ];

    test('puts the commonest word first', () => {
        assert.deepEqual(countWords(letters)[0], ['baptism', 3]);
    });

    test('breaks a tie on the word, so the same archive always sets the same', () => {
        const [first, second] = countWords(['Zebra zebra amber amber']).filter(
            ([, count]) => count === 2
        );
        assert.ok(first[0] < second[0], `${first[0]} came before ${second[0]}`);
    });

    test('keeps only as many words as were asked for', () => {
        assert.equal(countWords(letters, { most: 2 }).length, 2);
    });

    test('survives a letter with nothing in it', () => {
        assert.deepEqual(countWords([undefined, '', '   ']), []);
    });
});
