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
import { sanitizeBody, redactAccessLinks, PHOTO_PREFIX } from '../src/lib/sanitize.js';
import { issueClaimToken, PURPOSE } from '../src/lib/claimtoken.js';

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

    test('a block holding only a line break is a paragraph break, and is kept', () => {
        // Gmail's mobile composer writes every paragraph as a bare <div> with
        // no margin of its own and puts the blank line between them in one of
        // these. Removing it as empty runs the whole letter together.
        assert.equal(
            sanitizeBody('<div>One.</div><div><br></div><div>Two.</div>'),
            '<div>One.</div><div><br /></div><div>Two.</div>'
        );
    });

    test('the same shape survives Gmail opening with a bare text node', () => {
        // The letter's first line is a text node inside the wrapper rather
        // than a block of its own, so the break after it is judged before any
        // block holding text has closed. This is the exact shape of the first
        // direct send the service received, and the reason the guard watches
        // text nodes rather than closing tags.
        const out = sanitizeBody('<div>Hola<div><br></div><div>Next.</div></div>');
        assert.equal(out, '<div>Hola<div><br /></div><div>Next.</div></div>');
    });

    test('a break before the letter starts separates nothing', () => {
        // Outlook for Android opens every message with three of these above
        // its own advertisement. Honoring them would put blank lines at the
        // top of almost every forward.
        assert.equal(sanitizeBody('<div><br></div><div><br></div><p>Hi</p>'), '<p>Hi</p>');
    });

    test('a break after the letter ends separates nothing either', () => {
        // Trailing breaks cannot be judged while the document is still being
        // walked, so they are trimmed from the finished output instead --
        // including when they are nested, which needs more than one pass.
        assert.equal(sanitizeBody('<p>Hi</p><div><br></div>'), '<p>Hi</p>');
        assert.equal(sanitizeBody('<p>Hi</p><div><div><br></div></div>'), '<p>Hi</p>');
    });

    test('breaks inside a dropped header block do not space out the letter', () => {
        // Outlook writes its quoted header block with <br> between the lines,
        // and those are recorded as kept breaks before the block holding them
        // is judged and removed. Removing it rewinds the output over the
        // positions they were recorded at, so every spacer paragraph after it
        // read as a deliberate paragraph break and the letter came out double
        // spaced. Reported from a real forward; the block below is its shape.
        const text = 'Dear family, the mantis on the wall was the size of my hand.';
        const html =
            '<div><p>From: elder.example@missionary.org<br>Sent: Monday<br>' +
            'To: family@example.com<br>Subject: Week 12</p></div>' +
            `<p>${text}</p><p>&nbsp;</p><p>It did not move all week.</p>`;

        const out = sanitizeBody(html, { letterText: text });

        assert.equal(out, `<p>${text}</p><p>It did not move all week.</p>`);
    });

    test('trimming the end stops at the letter', () => {
        // The trailing pass runs on a string, so the thing worth proving is
        // that it cannot eat backwards into content.
        assert.equal(
            sanitizeBody('<p>One.</p><div><br></div><p>Two.</p><div><br></div>'),
            '<p>One.</p><div><br /></div><p>Two.</p>'
        );
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

describe('only the missionary is left above the letter', () => {
    const letter = 'Dear family, the mantis on the wall was the size of my hand.';
    const headers =
        '<p>From: elder.example@missionary.org<br>Sent: Monday<br>' +
        'To: family@example.com<br>Subject: Week 12</p>';

    test("the forwarding client's advertisement and rule are discarded", () => {
        // Outlook for iOS signs every forward and draws a line under itself.
        // Reported from a real letter, where both stood above the archive.
        const html =
            '<div><p>Get <a href="https://aka.ms/o0ukef">Outlook for iOS</a></p></div>' +
            `<div><hr></div><div>${headers}</div><p>${letter}</p>`;

        assert.equal(sanitizeBody(html, { letterText: letter }), `<p>${letter}</p>`);
    });

    test('a comment somebody typed before passing the letter on is discarded', () => {
        const html = `<p>Sharing this one, it made me laugh!</p><div>${headers}</div><p>${letter}</p>`;

        assert.equal(sanitizeBody(html, { letterText: letter }), `<p>${letter}</p>`);
    });

    test('quoted headers below the letter do not take the letter with them', () => {
        // A missionary answering something keeps the headers of what they
        // answered underneath their own words. Cutting there would throw away
        // the letter and leave the quotation, which is exactly backwards.
        const html = `<p>${letter}</p><div>${headers}</div><p>What you sent me.</p>`;
        const out = sanitizeBody(html, { letterText: letter });

        assert.ok(out.startsWith(`<p>${letter}</p>`));
        assert.ok(!out.includes('Subject: Week 12'));
    });

    test('the photos the missionary sent survive the cut', () => {
        const html =
            `<p>Sent along.</p><div>${headers}</div>` +
            `<p>${letter}</p><p><img src="/api/photo/elder/one.jpg" alt=""></p>`;

        assert.ok(sanitizeBody(html, { letterText: letter, keepPhotoPrefix: '/api/photo/elder/' })
            .includes('/api/photo/elder/one.jpg'));
    });

    test('without the plain-text letter to compare against, nothing is cut', () => {
        // The probe is the only proof of where the letter starts. Absent it,
        // removing anything would be a guess, and the guess is unrecoverable.
        const html = `<p>Sharing this one!</p><div>${headers}</div><p>${letter}</p>`;

        assert.ok(sanitizeBody(html).includes('Sharing this one!'));
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

// Our own claim and invitation links are bearer credentials. A relative
// forwarding one of our emails to post@ publishes it into the archive, where
// an invitation carrying the owner role would let a reader promote themselves.
//
// The token is minted by the real issuer rather than written out by hand, so
// these cannot keep passing against a token shape that has changed.
describe('our own access links never reach the archive', () => {
    const token = () =>
        issueClaimToken({
            slug: SLUG,
            key: 'test-key',
            expiresAt: '2026-12-01T00:00:00.000Z',
            purpose: PURPOSE.invite
        }).token;

    // Enough of the token to be worth having. Asserting on the whole string
    // would pass for a redaction that removed one character.
    const head = (value) => value.slice(0, 40);

    test('a claim link in an anchor loses both the href and the visible text', () => {
        const link = `https://pdayletters.com/claim#${token()}`;
        const out = sanitizeBody(`<p>Here you go: <a href="${link}">${link}</a></p>`);

        assert.doesNotMatch(out, /\/claim#/);
        assert.equal(out.includes(head(link.split('#')[1])), false);
        assert.match(out, /Here you go/);
    });

    test('an invitation link pasted as bare text goes too', () => {
        const link = `https://pdayletters.com/invite#${token()}`;
        const out = sanitizeBody(`<p>${link}</p>`);

        assert.doesNotMatch(out, /\/invite#/);
        assert.match(out, /\[link removed\]/);
    });

    test('a link wrapped across lines is still destroyed', () => {
        // A token is far longer than a mail client's wrap column, so this is
        // the shape a plain-text forward actually produces. Only the first
        // chunk matches -- which is the point: it holds the payload, and what
        // is left cannot be verified or reassembled.
        const raw = token();
        const link = `https://pdayletters.com/invite#${raw}`;
        const wrapped = `${link.slice(0, 80)}\n${link.slice(80)}`;
        const out = sanitizeBody(`<p>${wrapped}</p>`);

        assert.equal(out.includes(head(raw)), false);
        assert.doesNotMatch(out, /\/invite#/);
    });

    test('the same scrub is available to the plain-text path', () => {
        // Ingest stores a text-only letter as bodyText and render builds its
        // own HTML from it; neither goes through sanitizeBody, and readers are
        // served bodyText whenever render has not run.
        const raw = token();
        const out = redactAccessLinks(`Sign in here: https://pdayletters.com/claim#${raw}\nLove, Mum`);

        assert.equal(out.includes(head(raw)), false);
        assert.equal(out, 'Sign in here: [link removed]\nLove, Mum');
    });

    test('null and undefined pass through rather than becoming the string "null"', () => {
        // bodyText is null for every letter that had an HTML part, and that
        // null is stored.
        assert.equal(redactAccessLinks(null), null);
        assert.equal(redactAccessLinks(undefined), undefined);
    });

    test('an ordinary link in a letter is left alone', () => {
        // The scrub is host-agnostic, so this is the boundary worth pinning:
        // it keys on the path and the fragment, not on any URL we recognize.
        const html = '<p>Read <a href="https://churchofjesuschrist.org/study">this</a>.</p>';
        assert.match(sanitizeBody(html), /churchofjesuschrist\.org\/study/);
        assert.match(sanitizeBody('<p>See https://example.com/claims for more.</p>'), /\/claims/);
    });

    test('a letter that opens with a link does not lose its first paragraph', () => {
        // The header-block guard compares the plain-text letter against the
        // sanitized HTML. Redacting one side and not the other would turn a
        // match into a miss, and a miss there drops the block holding the
        // letter -- data loss, from a control that exists to prevent a leak.
        const link = `https://pdayletters.com/claim#${token()}`;
        const text = `${link}\n\nDear family, this week we walked to Cusco and it rained the whole way.`;
        const html =
            '<div><p>From: elder.example@missionary.org<br>Sent: Monday<br>' +
            'To: family@example.com<br>Subject: Week 12</p>' +
            `<p>${link}</p><p>Dear family, this week we walked to Cusco and it rained the whole way.</p></div>`;

        const out = sanitizeBody(html, { letterText: text });

        assert.match(out, /walked to Cusco/);
        assert.doesNotMatch(out, /family@example\.com/);
    });
});
