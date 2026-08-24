// What a mission was mostly about, counted.
//
// The reader has drawn a word cloud since the archive shipped, and the book
// now prints one. They have to be the same cloud -- an owner who has looked
// at the screen version for a year would notice at once if the printed one
// put a different word in the middle, and would have no way to find out
// which of the two was lying.
//
// **This file is the second copy of that counting, and the duplication is
// deliberate.** The reader is a plain script rather than a module because it
// has to run from `file://` inside a downloaded zip, and a browser will not
// load an ES module over that scheme at all. So it cannot import this, and
// nothing here can import it. What holds the two together is
// `functions/tests/words.test.js`, which reads `web/reader.js` off disk and
// fails if either the stopword list or the tokenizer has drifted from what is
// below. That test is the only reason this arrangement is safe; do not delete
// it because it looks like it is testing a comment.

// The words that are in every letter because they are in every sentence.
// Deliberately shorter than a proper stopword list -- these are somebody's
// letters, not a corpus, and "home", "week" and "love" earn their place even
// though a search engine would throw all three away.
export const NOISE = new Set(
    `a about after all also am an and any are as at be because been before
     being but by can could did do does doing done down each even ever
     every few for from get got had has have having he her here hers him
     his how i if in into is it its just like me more most much my no nor
     not now of off on once one only or other our out over own said same
     she should so some such than that the their them then there these
     they thing things this those though through to too under until up us
     very was we well were what when where which while who why will with
     would yet you your
     cant didnt dont hes im isnt its ive id ill shes thats theres theyre
     wasnt weve wont youre`
        .trim()
        .split(/\s+/)
);

// A pasted link is usually its own link text, so the URL is in the visible
// words of the letter and not only in an href. Split on punctuation it
// becomes the alphabetic runs of a Google Photos share id -- "egtkcgt",
// "kxqodvf" -- which look like words, are counted like words, and are not
// words. Anything with a scheme, an @ or a slash in it goes first.
//
// Exported only so the drift test can compare it with the reader's copy.
export const LINKS = /\b(?:[a-z][\w+.-]*:\/\/|www\.|mailto:)\S*|\S+@\S+\.\S+|\S*\/\S*/gi;

/**
 * The countable words of a passage.
 *
 * Letters only, so years and house numbers stay out of it, and apostrophes
 * folded away so "don't" and "dont" are one word rather than two.
 */
export const wordsIn = (text) =>
    text
        .replace(LINKS, ' ')
        .toLowerCase()
        .replace(/[\u2018\u2019]/g, "'")
        .split(/[^\p{L}']+/u)
        .map((word) => word.replace(/'/g, ''))
        .filter((word) => word.length > 2 && !NOISE.has(word));

// Enough to fill a page and read as a crowd. Past this the tail is words that
// came up twice, and sixty of those say nothing the first sixty did not
// already say louder.
export const MOST = 60;

/**
 * Tally the words of a whole archive.
 *
 * Commonest first. Ties break on the word itself so that the same archive
 * always produces the same list -- which matters more here than it does in
 * the reader, because the book is set twice and a tally that reordered
 * between the measuring pass and the real one would move the contents page.
 *
 * @param {Iterable<string>} texts plain text, one entry per letter
 * @param {{most?: number}} [options]
 * @returns {[string, number][]} word and how often it came up
 */
export function countWords(texts, { most = MOST } = {}) {
    const tally = new Map();

    for (const text of texts) {
        for (const word of wordsIn(text ?? '')) {
            tally.set(word, (tally.get(word) ?? 0) + 1);
        }
    }

    return [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, most);
}

/**
 * Where each word sits on the page, packed outwards from the middle.
 *
 * A word cloud is a rectangle-packing problem with no good exact answer, and
 * every implementation solves it the same greedy way: take the biggest word
 * first, walk a spiral out from the center, and drop it at the first place it
 * does not touch anything already placed. The reader gets this from
 * wordcloud2, which needs a canvas to do it; a PDF has no canvas and no DOM,
 * so it is done here instead.
 *
 * **Nothing rotates.** wordcloud2 turns three words in ten on their side,
 * which is right for a panel somebody is looking at and wrong for a page
 * somebody is reading -- a book that has to be turned sideways to be read is
 * a book that gets closed. Losing the vertical words costs some of the dense
 * interlocking look and buys a page that works at arm's length.
 *
 * Deterministic, with no randomness anywhere: the same tally packs the same
 * way every time. That is not tidiness. The book is set twice and only the
 * second one is kept, so a layout that differed between the passes would put
 * the cloud in a different place than the pass that measured it.
 *
 * @param {[string, number][]} words commonest first
 * @param {object} options
 * @param {number} options.width the box, in points
 * @param {number} options.height
 * @param {(text: string, size: number) => number} options.measure how wide a word sets
 * @param {(count: number) => number} options.size point size for a count
 * @param {number} [options.gap] clear space kept around each word
 * @param {number} [options.fill] share of the box the words' own area should cover
 * @returns {{word: string, count: number, size: number, x: number, y: number, width: number, height: number}[]}
 */
export function packCloud(words, { width, height, measure, size, gap = 3, fill = 0.46 }) {
    const placed = [];
    const midX = width / 2;
    const midY = height / 2;

    // The spiral's step, in points. Fine enough that the gaps between words
    // are not visibly quantised, coarse enough that sixty words settle in a
    // few thousand tries rather than a few hundred thousand.
    const STEP = 4;

    // An Archimedean spiral, stretched to the proportions of the box. Words
    // are far wider than they are tall, so a round spiral packs a disc and
    // leaves the corners of the page empty; stretching it spreads them over
    // the whole rectangle instead.
    const stretch = width / height;
    const radius = (turn) => turn * 2.4;

    // The furthest out worth looking. Measured in the unstretched circle, so
    // it is the box's own half-diagonal once the stretch is undone -- past
    // that there is nowhere left that was not already tried.
    const reach = Math.hypot(width / stretch, height) / 2;

    const points = fitSizes(words, { width, height, measure, size, fill });

    const clashes = (box) =>
        placed.some(
            (other) =>
                box.x < other.x + other.width + gap &&
                other.x < box.x + box.width + gap &&
                box.y < other.y + other.height + gap &&
                other.y < box.y + box.height + gap
        );

    for (const [word, count] of words) {
        const at = points(count);
        const box = { width: measure(word, at), height: at };

        // A word wider than the page can never be placed and would otherwise
        // burn the whole spiral finding that out.
        if (box.width > width || box.height > height) continue;

        // Walked by angle, with the radius growing as it turns. The arc a
        // fixed angular step covers gets longer the further out it is, so the
        // step is scaled by the radius to keep the sampling even -- without
        // that, the middle is searched densely and the outside in jumps wide
        // enough to skip gaps a word would have fitted.
        for (let turn = 0; radius(turn) <= reach; turn += STEP / Math.max(radius(turn), STEP)) {
            const r = radius(turn);
            const x = midX + r * stretch * Math.cos(turn) - box.width / 2;
            const y = midY + r * Math.sin(turn) - box.height / 2;

            // Inside the box entirely. Half a word hanging off the edge is
            // worse than a word that did not make it in.
            if (x < 0 || y < 0 || x + box.width > width || y + box.height > height) continue;

            const candidate = { ...box, x, y };
            if (clashes(candidate)) continue;

            placed.push({ word, count, size: at, ...candidate });
            break;
        }
    }

    return placed;
}

/**
 * The point sizes, scaled so the words fill the page they were given.
 *
 * The sizes handed in are a *shape* -- which word is larger than which, and by
 * how much -- rather than a fit. Nothing about a tally knows how big the page
 * is, and the same sixty words could as easily be asked to fill a postcard.
 * Packed at their nominal sizes they came out as a small tight knot adrift in
 * a lot of white paper, which was the first version of this page and read as a
 * printing fault rather than as a design.
 *
 * So the whole set is scaled by one factor, chosen from area. A word's area
 * grows with the square of its point size, so the factor that turns the words'
 * total area into the wanted share of the box is the square root of the ratio
 * between them -- one pass over the list, no searching, and the relative sizes
 * survive untouched because every word is scaled by the same number.
 *
 * `fill` is well under one because the words are packed as rectangles and set
 * as letterforms: the space above an "o" and either side of an "l" is inside
 * the box and empty on the page. Somewhere near a half looks full without
 * looking crowded.
 */
function fitSizes(words, { width, height, measure, size, fill }) {
    let ink = 0;
    for (const [word, count] of words) {
        const at = size(count);
        ink += measure(word, at) * at;
    }

    if (ink <= 0) return size;

    let scale = Math.sqrt((width * height * fill) / ink);

    // Nothing may end up wider than the page. Width is linear in point size,
    // so the worst offender's overhang is exactly the factor to come back by
    // and one pass settles it.
    let worst = 1;
    for (const [word, count] of words) {
        worst = Math.max(worst, measure(word, size(count) * scale) / width);
    }

    scale /= worst;
    return (count) => size(count) * scale;
}
