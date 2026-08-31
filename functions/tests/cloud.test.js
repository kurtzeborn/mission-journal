// The cloud the book prints is the cloud the site draws, and these tests are
// about the seam between the two rather than about wordcloud2, which is
// somebody else's library and already has its own. What is worth holding here
// is that the seam holds: every word comes back, it comes back in the same
// place every time, and it comes back somewhere on the paper.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CLOUD, layoutCloud } from '../src/lib/cloud.js';
import { cloudScale } from '../src/lib/words.js';

// The text block of a Letter page, which is what the cloud is actually given.
const PAGE = { width: 444, height: 586 };

const zipf = (count) =>
    Array.from({ length: count }, (_, n) => [`word${n}`.padEnd(4 + (n % 7), 'x'), count - n]);

const lay = (words, box = PAGE) =>
    layoutCloud(words, { ...box, size: cloudScale(words, box) });

// Where a word actually lands, which is not where it says it is: the reported
// box is the unturned one, and a word on its side swings about a point four
// tenths of the way down it.
function boundsOf(item) {
    const pivotX = item.x + item.width / 2;
    const pivotY = item.y + item.height * 0.4;
    const angle = (item.turn * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const corners = [
        [-item.width / 2, -item.height * 0.4],
        [item.width / 2, -item.height * 0.4],
        [item.width / 2, item.height * 0.6],
        [-item.width / 2, item.height * 0.6]
    ].map(([x, y]) => [pivotX + x * cos - y * sin, pivotY + x * sin + y * cos]);

    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);

    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

const extentOf = (placed) => {
    const bounds = placed.map(boundsOf);
    return {
        left: Math.min(...bounds.map((b) => b.left)),
        right: Math.max(...bounds.map((b) => b.right)),
        top: Math.min(...bounds.map((b) => b.top)),
        bottom: Math.max(...bounds.map((b) => b.bottom))
    };
};

describe('laying the word cloud out for the press', () => {
    // Packing sixty words takes real seconds -- the library rasterises every
    // one of them, twice over when it has to shrink to fit -- so the suite
    // lays the page out once and then asks it questions.
    const placed = lay(zipf(60));

    test('finds room for every word', () => {
        // Sixty words is what a mission's worth of letters comes to, and a
        // word that gets dropped is a word the reader can see on the site and
        // the owner cannot find in the book.
        assert.equal(placed.length, 60);
    });

    test('keeps the words on the paper', () => {
        // Not to the point -- the reported box is padded around the letters
        // and the library only promises the ink is inside -- but nothing may
        // wander off toward the trim.
        const slack = Math.max(...placed.map((item) => item.size));

        for (const item of placed) {
            const at = boundsOf(item);
            assert.ok(at.left > -slack, `${item.word} ran off the spine`);
            assert.ok(at.right < PAGE.width + slack, `${item.word} ran off the fore-edge`);
            assert.ok(at.top > -slack, `${item.word} ran off the head`);
            assert.ok(at.bottom < PAGE.height + slack, `${item.word} ran off the foot`);
        }
    });

    test('fills the leaf rather than huddling in the middle', () => {
        // The reason `ellipticity` is the one setting the book does not take
        // from the browser. Left at its default the cloud came out squashed to
        // a landscape blob with white bands above and below it.
        const at = extentOf(placed);

        assert.ok(at.right - at.left > PAGE.width * 0.85, 'the cloud left the margins wide');
        assert.ok(at.bottom - at.top > PAGE.height * 0.8, 'the cloud left bands at the head and foot');
    });

    test('sets the same archive the same way twice', () => {
        // The book is set in two passes -- one to count the pages, one to draw
        // them -- and an unseeded die would have the second pass disagree with
        // the first. It also means reprinting an archive gets the same object.
        assert.deepEqual(lay(zipf(20)), lay(zipf(20)));
    });

    test('sets a word larger the more it was written', () => {
        // The reader's scale decides what a word asks for. The library is
        // allowed to give it less -- `shrinkToFit` takes a word down a size
        // when the only gap left is too small for it -- but never more, and a
        // word nobody wrote twice must not end up shouting.
        const asked = cloudScale(zipf(60), PAGE);

        for (const item of placed) {
            assert.ok(item.size <= asked(item.count) + 1e-9, `${item.word} was set too large`);
        }

        const ranked = [...placed].sort((a, b) => b.count - a.count);
        const top = ranked.slice(0, 5).map((item) => item.size);
        const bottom = ranked.slice(-5).map((item) => item.size);

        assert.ok(Math.min(...top) > Math.max(...bottom) * 2, 'the cloud came out all one size');
    });

    test('turns a word onto its side or leaves it alone', () => {
        const turned = placed.filter((item) => item.turn !== 0);

        for (const item of placed) {
            assert.ok([-90, 0, 90].includes(item.turn), `${item.word} came out at ${item.turn}`);
        }

        // `rotateRatio` is 0.3. A die is a die, so this is only checking that
        // the setting arrived rather than that it came out exactly three in ten.
        assert.ok(turned.length > 6 && turned.length < 30, `${turned.length} of 60 were turned`);
    });

    test('has nothing to draw for an archive with nothing in it', () => {
        assert.deepEqual(layoutCloud([], { ...PAGE, size: () => 12 }), []);
    });

    test('asks the library for what the browser asks it for', () => {
        // The settings are copied from `web/reader.js`; this is here so that a
        // stray edit to one of them reads as a decision rather than a typo.
        assert.deepEqual(CLOUD, {
            gridSize: 6,
            rotateRatio: 0.3,
            rotationSteps: 2,
            minRotation: -Math.PI / 2,
            maxRotation: Math.PI / 2,
            shape: 'square',
            drawOutOfBound: false,
            shrinkToFit: true
        });
    });
});
