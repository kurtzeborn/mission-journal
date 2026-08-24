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
// fails if any of this has drifted from what is below. That test is the only
// reason this arrangement is safe; do not delete it because it looks like it
// is testing a comment.
//
// The packing is *not* copied. That is wordcloud2's, and the book runs the
// same vendored copy of it the browser does -- see `cloud.js`.

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
 * Point size for a count, logarithmic and tied to the box.
 *
 * Copied from the reader's `scale`, and it has to stay copied: a book set on a
 * different curve to the screen would put a different word in the middle. A
 * word that came up four times as often is not four times as interesting, and
 * on a linear scale one runaway word flattens the other fifty-nine into a
 * single illegible size.
 *
 * @param {[string, number][]} words
 * @param {{width: number, height: number}} box in points
 * @returns {(count: number) => number}
 */
export function cloudScale(words, box) {
    const counts = words.map(([, n]) => n);
    const most = Math.max(...counts);
    const least = Math.min(...counts);

    const top = Math.max(20, Math.min(box.width, box.height) * 0.19);
    const floor = Math.max(11, top * 0.24);

    return (n) => {
        if (most <= least) return (top + floor) / 2;
        const step = (Math.log(n) - Math.log(least)) / (Math.log(most) - Math.log(least));
        return floor + step * (top - floor);
    };
}

// How many tones the cloud is drawn in, and which one a word gets. Off the
// word rather than off its position, so the same word is the same color on the
// page as it is on the screen. Both numbers are the reader's.
export const TONES = 6;

export function toneOf(word) {
    let hash = 0;
    for (let i = 0; i < word.length; i += 1) {
        hash = (hash * 31 + word.charCodeAt(i)) % 100003;
    }

    return hash % TONES;
}
