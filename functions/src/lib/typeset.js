import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// pdfkit already depends on this -- it is how pdfkit itself decides where a
// line may break -- but it is declared in package.json all the same, because
// relying on a transitive dependency is relying on somebody else's changelog.
const LineBreaker = require('linebreak');

/**
 * Break a block's styled runs into the smallest pieces a line may end on.
 *
 * The unit is not the word. UAX #14, which is what `linebreak` implements, is
 * a good deal cleverer than splitting on spaces: "well-known" may break after
 * the hyphen, an em-dash is a break opportunity on its own, and neither of
 * those is a space. In a column four hundred points wide those cases come up
 * constantly -- a missionary writing home about the Argentina Buenos Aires
 * North Mission will otherwise leave a hand's width of white at the end of a
 * line because the next word had nowhere to go.
 *
 * Trailing whitespace stays attached to the piece it followed, which is what
 * makes joining pieces a plain concatenation and makes a line that ends on a
 * hyphen come out as "well-" rather than "well- ". Each piece therefore
 * carries two widths' worth of text: `text` for when it sits mid-line, and
 * `tail` for when it ends one.
 *
 * A `\n` -- which is what `flowBody` writes for a `<br>` -- becomes an empty
 * piece marked `hard`. Empty so it costs no width, marked so the line stops
 * there. Two of them in a row therefore produce a blank line rather than
 * collapsing into one break, which is what the writer meant by typing them.
 *
 * @param {{text: string}[]} runs
 * @returns {{text: string, tail: string, run: object, hard: boolean}[]}
 */
export function segments(runs) {
    const out = [];

    for (const run of runs ?? []) {
        const parts = String(run.text ?? '').split('\n');

        parts.forEach((part, index) => {
            if (index) out.push({ text: '', tail: '', run, hard: true });
            if (!part) return;

            const breaker = new LineBreaker(part);
            let last = 0;

            for (let point = breaker.nextBreak(); point; point = breaker.nextBreak()) {
                const text = part.slice(last, point.position);
                last = point.position;
                if (text) out.push({ text, tail: text.replace(/\s+$/, ''), run, hard: false });
            }
        });
    }

    return out;
}

/**
 * How many pieces fit on one line of the given width.
 *
 * Greedy, which is what almost every typesetter that is not TeX does, and
 * what a reader expects: the alternative optimises the paragraph as a whole
 * and moves words around on lines the reader has already accepted.
 *
 * Two things stop it looping. A piece is always taken when the line is empty,
 * so a word wider than the column overhangs rather than being reconsidered
 * forever -- a URL in a letter, usually. And a hard piece ends the line the
 * moment it is taken.
 *
 * `width` is asked for by the caller per line rather than fixed here, because
 * a line beside a photograph is narrower than one below it, and that is the
 * whole point of the exercise.
 *
 * @returns {number} the index one past the last piece on this line
 */
export function fillLine(pieces, from, { measure, width }) {
    let used = 0;
    let to = from;

    while (to < pieces.length) {
        const piece = pieces[to];

        // Measured against the trimmed text, because if the line ends here
        // the trailing space is never printed and must not be paid for. It
        // is what stops a line breaking one word early on every paragraph
        // that happens to fill the column exactly.
        if (to > from && used + measure(piece.tail, piece.run) > width) break;

        used += measure(piece.text, piece.run);
        to += 1;

        if (piece.hard) break;
    }

    return to;
}
