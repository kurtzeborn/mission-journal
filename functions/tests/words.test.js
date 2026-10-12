import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { TONES, cloudScale, countWords, toneOf, wordsIn } from '../src/lib/words.js';

const reader = readFileSync(new URL('../../web/reader.js', import.meta.url), 'utf8');

// Lifting a function straight out of the reader and running it. Comparing the
// two as text would fail the day somebody reflowed a comment, and comparing
// them by what they return is the thing actually worth holding: the book and
// the screen have to agree on the answer, not on the wording.
const liftedFrom = (pattern, name, scope = {}) => {
    const [source] = reader.match(pattern) ?? [];
    assert.ok(source, `no ${name} found in web/reader.js`);

    const keys = Object.keys(scope);
    return new Function(...keys, `${source}; return ${name};`)(...keys.map((key) => scope[key]));
};

const zipf = (count) => Array.from({ length: count }, (_, n) => [`word${n}`, count - n]);

describe('keeping the printed cloud and the screen cloud the same cloud', () => {
    // The reader cannot import this module -- it has to run from `file://`
    // inside a downloaded zip, where a browser refuses ES modules outright --
    // so the two copies are held together by nothing but these checks. If one
    // of them fails, the book and the website are about to disagree about what
    // the mission was mostly about, and the owner has no way to tell which of
    // the two is lying.

    test('tokenizes representative text the same way', () => {
        const [, listed] = reader.match(/const NOISE = new Set\(\s*`([^`]*)`/) ?? [];
        assert.ok(listed, 'no stopword list found in web/reader.js');
        const browserNoise = new Set(listed.trim().split(/\s+/));

        const [, written] = reader.match(/const LINKS = (\/.+\/[a-z]*);/) ?? [];
        assert.ok(written, 'no link pattern found in web/reader.js');
        const browserLinks = new Function(`return ${written}`)();

        const browserWordsIn = liftedFrom(
            /const wordsIn = \(text\) =>[\s\S]*?;\r?\n/,
            'wordsIn',
            { NOISE: browserNoise, LINKS: browserLinks }
        );
        const passage =
            "We couldn't walk to Antigua; photos are at https://photos.app.goo.gl/abc-def. Rain, rain!";

        assert.deepEqual(browserWordsIn(passage), wordsIn(passage));
    });

    test('sets a word at the same size', () => {
        const theirs = liftedFrom(/function scale\(words, box\) \{[\s\S]*?\n {4}\}/, 'scale');
        const words = zipf(40);

        // The reader measures a live element and the book knows its own box,
        // which is the only difference between the two signatures.
        const ours = cloudScale(words, { width: 444, height: 586 });
        const them = theirs(words, { clientWidth: 444, clientHeight: 586 });

        for (const [, count] of words) {
            assert.ok(Math.abs(ours(count) - them(count)) < 1e-9, `${count} sized differently`);
        }
    });

    test('gives a word the same tone', () => {
        const [, count] = reader.match(/const TONES = (\d+);/) ?? [];
        assert.equal(Number(count), TONES);

        const theirs = liftedFrom(/function toneOf\(word\) \{[\s\S]*?\n {4}\}/, 'toneOf', { TONES });

        for (const [word] of zipf(40)) assert.equal(toneOf(word), theirs(word));
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

    test('drops routine weekly language and common prepositions but keeps meaningful themes', () => {
        assert.deepEqual(
            wordsIn('Week aboard across amid beneath between during inside outside toward via without home love'),
            ['home', 'love']
        );
    });

    test('keeps less common prepositions available as themes', () => {
        assert.deepEqual(
            wordsIn(
                'notwithstanding underneath excepting excluding failing including regarding unlike throughout'
            ),
            [
                'notwithstanding',
                'underneath',
                'excepting',
                'excluding',
                'failing',
                'including',
                'regarding',
                'unlike',
                'throughout'
            ]
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
