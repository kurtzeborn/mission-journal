// Sanitizer tests.
//
// The sanitizer is the one control standing between third-party HTML and a
// page that can call the API with the reader's session cookie, so its rules
// are worth asserting directly rather than only through the render pipeline.
//
// These cover the tidying pass in particular, because its failure mode is
// quiet: it removes markup, and the difference between "removed a blank line
// a mail client invented" and "removed the letter" is one predicate.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeBody, PHOTO_PREFIX } from '../src/lib/sanitize.js';

const SLUG = 'elder.example';
const keep = { keepPhotoPrefix: `${PHOTO_PREFIX}${SLUG}/` };
const photo = `${PHOTO_PREFIX}${SLUG}/abc/large.webp`;

describe('empty block removal', () => {
    test('the spacer blocks mail clients invent are removed', () => {
        const html = '<p> </p><p>Real prose.</p><p> </p><p>&nbsp;</p><p><br></p>';
        assert.equal(sanitizeBody(html), '<p>Real prose.</p>');
    });

    test('empty divs and spans go too, but nothing else does', () => {
        assert.equal(sanitizeBody('<div> </div><span> </span><p>Hi</p>'), '<p>Hi</p>');

        // Deliberately left alone: an empty <li> still consumes a bullet and
        // an empty <td> still holds a column open, so removing either changes
        // the shape of something the writer built on purpose.
        assert.equal(sanitizeBody('<ul><li> </li><li>One</li></ul>'), '<ul><li> </li><li>One</li></ul>');
    });

    test('nesting collapses in a single pass', () => {
        // A parent's text is the text of its whole subtree, so the wrapper is
        // judged empty in the same sweep that empties it. This is the shape
        // every stored letter arrived in.
        assert.equal(sanitizeBody('<div><div><p> </p><p><br></p></div></div><p>Hi</p>'), '<p>Hi</p>');
    });

    test('a block is kept for its picture even with no text at all', () => {
        const html = `<p><img src="${photo}" alt=""></p>`;
        const out = sanitizeBody(html, keep);
        assert.match(out, /<img/);
        assert.match(out, /<p>/);
    });

    test('a block holding only a horizontal rule keeps both', () => {
        // <hr> contributes no text and is not a media child, so without the
        // position bookkeeping the wrapper reads as empty and the rule is
        // dropped along with it.
        assert.equal(sanitizeBody('<div><hr></div>'), '<div><hr /></div>');
    });

    test('a rule elsewhere in the letter does not rescue an unrelated empty block', () => {
        // The guard must be about containment, not mere presence: the rule is
        // a sibling here, so the empty divs still go.
        assert.equal(sanitizeBody('<div> </div><hr><div> </div>'), '<hr />');
    });

    test('a block whose only image was a tracking pixel is removed with it', () => {
        // The pixel is stripped for leaking reader IPs; the wrapper it left
        // behind is exactly the blank line this pass exists to remove.
        assert.equal(sanitizeBody('<div><img src="https://track.test/p.gif"></div><p>Hi</p>'), '<p>Hi</p>');
    });

    test('text-bearing markup is untouched', () => {
        const html = '<p>One <b>bold</b> word.</p><blockquote>Quoted.</blockquote>';
        assert.equal(sanitizeBody(html), html);
    });

    test('tidying is idempotent', () => {
        // Every owner edit re-sanitizes an already-stored body, so a pass that
        // kept changing its own output would rewrite letters forever.
        const html = '<div>\n<p> </p>\n<p>Prose.</p>\n<p> </p>\n</div>';
        const once = sanitizeBody(html, keep);
        assert.equal(sanitizeBody(once, keep), once);
    });

    test('a letter that is genuinely empty stays empty rather than throwing', () => {
        assert.equal(sanitizeBody('<div><p> </p></div>'), '');
    });
});

describe('tidying does not weaken the security rules', () => {
    test('script is still discarded, not flattened into prose', () => {
        const out = sanitizeBody('<p>Hi</p><script>alert(1)</script>');
        assert.equal(out, '<p>Hi</p>');
    });

    test('an off-site image is still dropped even inside real prose', () => {
        const out = sanitizeBody('<p>Look <img src="https://track.test/p.gif"> here</p>');
        assert.doesNotMatch(out, /<img/);
        assert.match(out, /Look/);
    });

    test('an already-rendered photo survives a second pass only for its own slug', () => {
        assert.match(sanitizeBody(`<p><img src="${photo}"></p>`, keep), /<img/);
        assert.doesNotMatch(
            sanitizeBody(`<p><img src="${photo}"></p>`, {
                keepPhotoPrefix: `${PHOTO_PREFIX}someone.else/`
            }),
            /<img/
        );
    });
});
