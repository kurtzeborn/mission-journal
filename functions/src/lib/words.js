// What a mission was mostly about, counted.
//
// The reader has drawn a word cloud since the archive shipped, and the book
// now prints one. They have to be the same cloud -- an owner who has looked
// at the screen version for a year would notice at once if the printed one
// put a different word in the middle, and would have no way to find out
// which of the two was lying.
//
// Just as `cloud.js` runs the vendored copy of `wordcloud2.js` from
// `src/assets/reader/`, this module loads the synced `src/assets/reader/reader.js`
// script in a minimal VM context and re-exports its tokenizer, stopword list,
// logarithmic scale, and tone hash directly. `sync-reader-assets.js` and
// `archive.test.js` keep `src/assets/reader/reader.js` byte-for-byte identical
// to `web/reader.js`, so the browser and the printed book always run one
// implementation.

import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../assets/reader/reader.js', import.meta.url), 'utf8');
const host = { addEventListener: () => {} };
new Function('window', SOURCE)(host);

const reader = host.Reader;

export const NOISE = reader.NOISE;
export const LINKS = reader.LINKS;
export const wordsIn = reader.wordsIn;
export const MOST = reader.MOST;
export const cloudScale = reader.cloudScale;
export const TONES = reader.TONES;
export const CLOUD_TONES = reader.CLOUD_TONES;
export const toneOf = reader.toneOf;

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
