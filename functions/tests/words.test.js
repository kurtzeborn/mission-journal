import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { LINKS, NOISE, countWords, packCloud, wordsIn } from '../src/lib/words.js';

const reader = readFileSync(new URL('../../web/reader.js', import.meta.url), 'utf8');

// Roughly how a serif face sets: wide enough that a long word is a real
// obstacle, cheap enough that a few thousand placements are instant. The
// packing does not care what the numbers mean, only that they are consistent
// between the pass that measures and the pass that draws.
const measure = (word, size) => word.length * size * 0.52;

const zipf = (count) => Array.from({ length: count }, (_, n) => [`word${n}`, count - n]);

describe('keeping the printed cloud and the screen cloud the same cloud', () => {
    // The reader cannot import this module -- it has to run from `file://`
    // inside a downloaded zip, where a browser refuses ES modules outright --
    // so the two copies are held together by nothing but these three checks.
    // If one of them fails, the book and the website are about to disagree
    // about what the mission was mostly about, and the owner has no way to
    // tell which of the two is lying.

    it('counts the same words as noise', () => {
        const [, listed] = reader.match(/const NOISE = new Set\(\s*`([^`]*)`/) ?? [];
        assert.ok(listed, 'no stopword list found in web/reader.js');

        assert.deepEqual(new Set(listed.trim().split(/\s+/)), NOISE);
    });

    it('throws away the same links', () => {
        const [, written] = reader.match(/const LINKS = (\/.+\/[a-z]*);/) ?? [];
        assert.ok(written, 'no link pattern found in web/reader.js');

        assert.equal(written, String(LINKS));
    });

    it('splits a passage into words the same way', () => {
        const [, written] = reader.match(/const wordsIn = \(text\) =>([\s\S]*?);\r?\n/) ?? [];
        assert.ok(written, 'no tokenizer found in web/reader.js');

        // Whitespace only, so the reader's deeper indentation is allowed to
        // differ. Everything else has to be character for character.
        const flatten = (code) => code.replace(/\s+/g, ' ').trim();
        assert.equal(flatten(written), flatten(String(wordsIn).replace(/^\(text\) =>/, '')));
    });
});

describe('the countable words of a letter', () => {
    it('drops the words that are in every sentence', () => {
        assert.deepEqual(wordsIn('We walked to the chapel and it was very cold'), [
            'walked',
            'chapel',
            'cold'
        ]);
    });

    it('drops years, house numbers and two-letter scraps', () => {
        assert.deepEqual(wordsIn('In 2026 we moved to 14 Rua do Sol'), ['moved', 'rua', 'sol']);
    });

    it('folds an apostrophe away so a word is one word', () => {
        assert.deepEqual(wordsIn("We couldn\u2019t and we couldnt"), ['couldnt', 'couldnt']);
    });

    it('refuses to count a pasted link as vocabulary', () => {
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

    it('puts the commonest word first', () => {
        assert.deepEqual(countWords(letters)[0], ['baptism', 3]);
    });

    it('breaks a tie on the word, so the same archive always sets the same', () => {
        const [first, second] = countWords(letters).filter(([, count]) => count === 2);
        assert.ok(first[0] < second[0], `${first[0]} came before ${second[0]}`);
    });

    it('keeps only as many words as were asked for', () => {
        assert.equal(countWords(letters, { most: 2 }).length, 2);
    });

    it('survives a letter with nothing in it', () => {
        assert.deepEqual(countWords([undefined, '', '   ']), []);
    });
});

describe('packing a cloud onto a page', () => {
    const box = { width: 444, height: 620 };
    const pack = (words, options = {}) =>
        packCloud(words, { ...box, measure, size: (count) => 9.5 + count * 0.4, ...options });

    it('keeps every word inside the page', () => {
        // Half a word hanging over the trim is worse than a word that did not
        // make it in, and the trim is where the printer cuts, not where the
        // margin is drawn.
        for (const item of pack(zipf(60))) {
            assert.ok(item.x >= 0 && item.y >= 0, `${item.word} started off the page`);
            assert.ok(item.x + item.width <= box.width + 0.001, `${item.word} ran off the side`);
            assert.ok(item.y + item.height <= box.height + 0.001, `${item.word} ran off the foot`);
        }
    });

    it('never sets one word on top of another', () => {
        const placed = pack(zipf(60));

        for (let i = 0; i < placed.length; i += 1) {
            for (let j = i + 1; j < placed.length; j += 1) {
                const a = placed[i];
                const b = placed[j];
                const over =
                    a.x < b.x + b.width &&
                    b.x < a.x + a.width &&
                    a.y < b.y + b.height &&
                    b.y < a.y + a.height;

                assert.ok(!over, `${a.word} and ${b.word} collided`);
            }
        }
    });

    it('lays the same archive out the same way twice', () => {
        // The book is set twice -- once to count the pages the contents will
        // cite, once for real -- and only the second one is kept. A layout
        // that differed between the passes would print a cloud the measuring
        // pass never saw.
        assert.deepEqual(pack(zipf(60)), pack(zipf(60)));
    });

    it('sets a commoner word larger', () => {
        const placed = pack(zipf(30));
        const [biggest] = placed;

        for (const item of placed.slice(1)) {
            assert.ok(item.size <= biggest.size + 0.001, `${item.word} outgrew the commonest word`);
        }
    });

    it('fills the page it was given rather than huddling in the middle', () => {
        // The sizes handed in are a shape, not a fit: nothing about a tally
        // knows how large the paper is. Unscaled, sixty words at ten points
        // came out as a small tight knot adrift in white, which read as a
        // printing fault. This is the check that the scaling still happens.
        const placed = pack(zipf(60));

        const right = Math.max(...placed.map((item) => item.x + item.width));
        const foot = Math.max(...placed.map((item) => item.y + item.height));
        const left = Math.min(...placed.map((item) => item.x));
        const top = Math.min(...placed.map((item) => item.y));

        assert.ok((right - left) / box.width > 0.8, 'the cloud left the sides empty');
        assert.ok((foot - top) / box.height > 0.8, 'the cloud left the head and foot empty');
    });

    it('fills a small page as fully as a large one', () => {
        const share = (width, height) => {
            const placed = packCloud(zipf(60), {
                width,
                height,
                measure,
                size: (count) => 9.5 + count * 0.4
            });

            const ink = placed.reduce((sum, item) => sum + item.width * item.height, 0);
            return ink / (width * height);
        };

        // Same words, a postcard and a poster. Within a little of each other
        // is the whole point of scaling from area rather than from a table of
        // point sizes somebody liked once.
        assert.ok(Math.abs(share(444, 620) - share(200, 280)) < 0.08);
    });

    it('leaves out a word that could never fit', () => {
        const placed = packCloud([['antidisestablishmentarianism', 40], ['rain', 2]], {
            width: 60,
            height: 60,
            measure,
            size: (count) => 9.5 + count * 4
        });

        assert.deepEqual(
            placed.map((item) => item.word),
            ['rain']
        );
    });

    it('has nothing to say about an archive with no words in it', () => {
        assert.deepEqual(pack([]), []);
    });
});
