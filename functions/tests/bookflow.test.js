// Taking a letter apart for print.
//
// The assertions worth making here are about the shapes email actually
// arrives in, not about HTML in general: a photo pasted into the middle of a
// sentence, a signature wrapped in Outlook's table layout, a list whose
// numbering has to restart when it nests, and the separators a forward drags
// along with it. Everything under test has already been through
// `sanitizeBody`, so nothing here is a security assertion.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { flowBody, inlinePhotoIds, photoIdFromSrc } from '../src/lib/bookflow.js';

const SLUG = 'isaac.backman';

const flow = (html) => flowBody(html, SLUG);

// The letter as a reader would say it aloud, one string per block. Most
// assertions are about order and grouping, and comparing text is the shortest
// way to say what those should be.
const said = (blocks) =>
    blocks.map((block) =>
        block.kind === 'photo'
            ? `[photo ${block.photoId}]`
            : block.kind === 'rule'
              ? '[rule]'
              : block.runs.map((run) => run.text).join('')
    );

describe('a letter comes apart into blocks', () => {
    test('paragraphs survive as paragraphs', () => {
        const blocks = flow('<p>We ate with a family.</p><p>Then it rained.</p>');

        assert.deepEqual(said(blocks), ['We ate with a family.', 'Then it rained.']);
        assert.deepEqual(
            blocks.map((b) => b.kind),
            ['para', 'para']
        );
    });

    test('whitespace between tags does not become a block', () => {
        const blocks = flow('<p>One.</p>\n    \n<p>Two.</p>');

        assert.equal(blocks.length, 2);
    });

    test('the indentation email is written with does not open gaps in a sentence', () => {
        const blocks = flow('<p>We walked\n        a long way\n        today.</p>');

        assert.deepEqual(said(blocks), ['We walked a long way today.']);
    });

    test('a line break stays inside its paragraph', () => {
        const blocks = flow('<p>Elder Backman<br>Missão Brasil<br>São Paulo</p>');

        assert.equal(blocks.length, 1);
        assert.equal(said(blocks)[0], 'Elder Backman\nMissão Brasil\nSão Paulo');
    });

    test('entities are decoded once, not printed', () => {
        const blocks = flow('<p>caf&eacute; &amp; bread &mdash; every morning</p>');

        assert.equal(said(blocks)[0], 'café & bread — every morning');
    });

    test('headings keep their level', () => {
        const blocks = flow('<h2>Week one</h2><p>It began.</p>');

        assert.equal(blocks[0].kind, 'head');
        assert.equal(blocks[0].level, 2);
    });
});

describe('emphasis becomes runs', () => {
    test('a bold phrase is its own run', () => {
        const blocks = flow('<p>It was <strong>very</strong> cold.</p>');

        assert.deepEqual(
            blocks[0].runs.map((run) => [run.text, run.bold]),
            [
                ['It was ', false],
                ['very', true],
                [' cold.', false]
            ]
        );
    });

    test('both spellings of emphasis mean the same thing', () => {
        const [b] = flow('<p><b>one</b></p>');
        const [strong] = flow('<p><strong>one</strong></p>');

        assert.equal(b.runs[0].bold, strong.runs[0].bold);
    });

    test('nested emphasis of the same kind survives the inner close', () => {
        // Malformed, and mail clients emit it anyway. A boolean flag would
        // switch bold off at the first close and leave the tail upright.
        const blocks = flow('<p><b>one <b>two</b> three</b></p>');

        assert.ok(blocks[0].runs.every((run) => run.bold));
    });

    test('a link is underlined and keeps where it pointed', () => {
        const blocks = flow('<p>See <a href="https://example.org/x">the photos</a>.</p>');
        const linked = blocks[0].runs.find((run) => run.link);

        assert.equal(linked.text, 'the photos');
        assert.equal(linked.link, 'https://example.org/x');
        assert.ok(linked.underline);
    });

    test('text after a link is not still linked', () => {
        const blocks = flow('<p><a href="https://example.org">here</a> and here</p>');

        assert.equal(blocks[0].runs.at(-1).link, null);
    });
});

describe('lists', () => {
    test('bullets are marked and indented', () => {
        const blocks = flow('<ul><li>Bread</li><li>Cheese</li></ul>');

        assert.deepEqual(
            blocks.map((b) => [b.kind, b.marker, b.indent]),
            [
                ['item', '\u2022', 1],
                ['item', '\u2022', 1]
            ]
        );
    });

    test('a numbered list counts', () => {
        const blocks = flow('<ol><li>First</li><li>Second</li><li>Third</li></ol>');

        assert.deepEqual(
            blocks.map((b) => b.marker),
            ['1.', '2.', '3.']
        );
    });

    test('a numbered list inside another restarts and then resumes', () => {
        const blocks = flow(
            '<ol><li>One</li><ol><li>Inner</li><li>Inner two</li></ol><li>Two</li></ol>'
        );

        assert.deepEqual(
            blocks.map((b) => [b.marker, b.indent]),
            [
                ['1.', 1],
                ['1.', 2],
                ['2.', 2],
                ['2.', 1]
            ]
        );
    });
});

describe('what a photo does to the letter around it', () => {
    const src = (id) => `/api/photo/${SLUG}/${id}/large.webp`;

    test('a photo pasted mid-sentence splits the paragraph in reading order', () => {
        const blocks = flow(`<p>Before it. <img src="${src('p_aaaaaaaaaaaa')}"> After it.</p>`);

        assert.deepEqual(said(blocks), ['Before it. ', '[photo p_aaaaaaaaaaaa]', ' After it.']);
    });

    test('an image that is not ours is dropped rather than left as a hole', () => {
        // A newsletter logo or a tracking pixel that beat the size filter.
        // There are no bytes in rendered/ to print for either.
        const blocks = flow('<p>Hi</p><img src="https://tracker.example/open.gif">');

        assert.deepEqual(said(blocks), ['Hi']);
    });

    test('a photo belonging to another site is not ours either', () => {
        const blocks = flow('<img src="/api/photo/declan.kurtzeborn/p_bbbbbbbbbbbb/large.webp">');

        assert.deepEqual(blocks, []);
    });

    test('the inline photos are listed in the order the letter places them', () => {
        const blocks = flow(
            `<img src="${src('p_cccccccccccc')}"><p>Then</p><img src="${src('p_dddddddddddd')}">`
        );

        assert.deepEqual(inlinePhotoIds(blocks), ['p_cccccccccccc', 'p_dddddddddddd']);
    });

    test('a photo url yields its id and nothing else does', () => {
        assert.equal(photoIdFromSrc(src('p_eeeeeeeeeeee'), SLUG), 'p_eeeeeeeeeeee');
        assert.equal(photoIdFromSrc('/api/photo/', SLUG), null);
        assert.equal(photoIdFromSrc(undefined, SLUG), null);
    });
});

describe('the shapes forwarded mail arrives in', () => {
    test("Outlook's table layout comes out as prose, not as a grid", () => {
        const blocks = flow(
            '<table><tr><td>Elder Backman</td></tr><tr><td>Sent from my iPhone</td></tr></table>'
        );

        assert.deepEqual(said(blocks), ['Elder Backman', 'Sent from my iPhone']);
    });

    test('a quoted block is indented rather than nested', () => {
        const blocks = flow('<p>He wrote:</p><blockquote><p>We are well.</p></blockquote>');

        assert.deepEqual(
            blocks.map((b) => [b.kind, b.indent]),
            [
                ['para', 0],
                ['para', 1]
            ]
        );
    });

    test('the separators a forward drags along do not open the chapter', () => {
        const blocks = flow('<hr><p>Forwarded message</p><hr>');

        assert.deepEqual(said(blocks), ['Forwarded message']);
    });

    test('a rule between two letters is kept', () => {
        const blocks = flow('<p>One</p><hr><p>Two</p>');

        assert.deepEqual(said(blocks), ['One', '[rule]', 'Two']);
    });

    test('a definition term is emphasised without claiming a contents entry', () => {
        const blocks = flow('<dl><dt>Companion</dt><dd>Elder Reyes</dd></dl>');

        assert.deepEqual(
            blocks.map((b) => b.kind),
            ['para', 'para']
        );
        assert.ok(blocks[0].runs[0].bold);
        assert.ok(!blocks[1].runs[0].bold);
    });

    test('preformatted text keeps the spacing it was written with', () => {
        const blocks = flow('<pre>Mon   walked\nTue   rained</pre>');

        assert.equal(blocks[0].kind, 'pre');
        assert.equal(said(blocks)[0], 'Mon   walked\nTue   rained');
    });

    test('an empty letter is no blocks rather than one empty one', () => {
        assert.deepEqual(flow('<p></p><div>  </div>'), []);
        assert.deepEqual(flow(''), []);
        assert.deepEqual(flowBody(undefined, SLUG), []);
    });
});
