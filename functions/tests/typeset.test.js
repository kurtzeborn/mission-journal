import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fillLine, segments } from '../src/lib/typeset.js';

// A monospace font, ten points to the character, so a width is a character
// count and every expectation below can be read without reaching for a
// calculator. The real measure asks pdfkit; this one asks arithmetic.
const measure = (text) => text.length * 10;

const texts = (pieces) => pieces.map((piece) => piece.text);

const line = (pieces, from, width) => pieces.slice(from, fillLine(pieces, from, { measure, width }));

describe('cutting a paragraph into pieces a line may end on', () => {
    it('keeps the space that followed a word on the word', () => {
        assert.deepEqual(texts(segments([{ text: 'one two three' }])), ['one ', 'two ', 'three']);
    });

    it('remembers the word without its space, for when it ends a line', () => {
        assert.deepEqual(
            segments([{ text: 'one two' }]).map((piece) => piece.tail),
            ['one', 'two']
        );
    });

    it('breaks after a hyphen and leaves no space behind', () => {
        assert.deepEqual(texts(segments([{ text: 'a well-known place' }])), ['a ', 'well-', 'known ', 'place']);
    });

    it('lets a line end on an em-dash', () => {
        assert.deepEqual(texts(segments([{ text: 'we left \u2014 finally' }])), ['we ', 'left ', '\u2014 ', 'finally']);
    });

    it('never breaks a word that has nowhere to break', () => {
        assert.deepEqual(texts(segments([{ text: 'Antananarivo' }])), ['Antananarivo']);
    });

    it('turns a line break into an empty piece that stops the line', () => {
        const pieces = segments([{ text: 'up\ndown' }]);

        assert.deepEqual(texts(pieces), ['up', '', 'down']);
        assert.deepEqual(
            pieces.map((piece) => piece.hard),
            [false, true, false]
        );
    });

    it('keeps two line breaks as two, so the blank line survives', () => {
        assert.equal(segments([{ text: 'up\n\ndown' }]).filter((piece) => piece.hard).length, 2);
    });

    it('breaks a paragraph that opens on one', () => {
        assert.deepEqual(texts(segments([{ text: '\ndown' }])), ['', 'down']);
    });

    it('carries each run its own styling', () => {
        const bold = { text: 'shouted ', bold: true };
        const plain = { text: 'quietly' };

        assert.deepEqual(
            segments([bold, plain]).map((piece) => piece.run),
            [bold, plain]
        );
    });

    it('has nothing to say about nothing', () => {
        assert.deepEqual(segments([]), []);
        assert.deepEqual(segments([{ text: '' }]), []);
    });
});

describe('filling one line', () => {
    it('takes as many pieces as the width allows', () => {
        const pieces = segments([{ text: 'one two three four' }]);

        assert.deepEqual(texts(line(pieces, 0, 80)), ['one ', 'two ']);
    });

    it('does not pay for the space it will never print', () => {
        // "one two" is seven characters set and eight with the space between
        // them made permanent. At seventy points the greedy fit has to notice
        // that the trailing space of "two" falls off the end of the line.
        const pieces = segments([{ text: 'one two' }]);

        assert.deepEqual(texts(line(pieces, 0, 70)), ['one ', 'two']);
    });

    it('carries on from where the line before stopped, at whatever width it is given', () => {
        // The two widths are the point: beside a photograph a line is narrow
        // and below it the next one is not, and the filler is told so a line
        // at a time rather than once for the paragraph.
        const pieces = segments([{ text: 'one two three four' }]);
        const to = fillLine(pieces, 0, { measure, width: 80 });

        assert.deepEqual(texts(pieces.slice(0, to)), ['one ', 'two ']);
        assert.deepEqual(texts(line(pieces, to, 200)), ['three ', 'four']);
    });

    it('lets a word wider than the column overhang rather than looping', () => {
        const pieces = segments([{ text: 'Antananarivo next' }]);

        assert.deepEqual(texts(line(pieces, 0, 40)), ['Antananarivo ']);
    });

    it('stops at a line break however much room is left', () => {
        const pieces = segments([{ text: 'up\ndown' }]);

        assert.deepEqual(texts(line(pieces, 0, 1000)), ['up', '']);
    });

    it('joins a hyphen to what follows when both fit', () => {
        const pieces = segments([{ text: 'well-known' }]);

        assert.deepEqual(texts(line(pieces, 0, 1000)), ['well-', 'known']);
    });

    it('measures each piece in its own run', () => {
        const wide = (text, run) => text.length * (run?.bold ? 40 : 10);
        const pieces = segments([{ text: 'one ' }, { text: 'two', bold: true }]);

        assert.equal(fillLine(pieces, 0, { measure: wide, width: 80 }), 1);
    });
});
