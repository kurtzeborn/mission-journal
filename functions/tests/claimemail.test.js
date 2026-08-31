// Claim email tests.
//
// Over the things that must stay true whatever the sentences end up saying.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { claimEmail, missionaryClaimEmail } from '../src/lib/claimemail.js';

const build = (overrides = {}) =>
    claimEmail({
        baseUrl: 'https://pdayletters.com',
        token: 'payload.signature',
        messageCount: 4,
        sender: 'elder.example@missionary.org',
        expiresAt: '2026-10-02T12:00:00.000Z',
        ...overrides
    });

const reply = (overrides = {}) =>
    missionaryClaimEmail({
        baseUrl: 'https://pdayletters.com',
        token: 'payload.signature',
        expiresAt: '2026-10-02T12:00:00.000Z',
        ...overrides
    });

// Both bodies are compared as one line, so rewrapping the copy is not a test
// failure and the same assertion can be made of the text and the HTML.
const flat = (body) => body.replace(/\s+/g, ' ');

describe('the claim email', () => {
    test('puts the token in a fragment, where no server will ever see it', () => {
        const { link, text, html } = build();

        assert.equal(link, 'https://pdayletters.com/claim#payload.signature');
        // A link scanner that fetches this URL sends only /claim, so it cannot
        // read the token and cannot spend it.
        assert.ok(!link.includes('?'), 'a query string would be logged');
        assert.ok(text.includes(link));
        assert.ok(html.includes(link));
    });

    test('does not name the missionary in the subject', () => {
        const { subject } = build();

        // Visible on a lock screen and to every hop in between.
        assert.ok(!subject.includes('elder.example'));
        assert.ok(!subject.includes('missionary.org'));
        assert.ok(!/\d/.test(subject), 'a count is a detail too');
    });

    test('asks for a personal account, in both bodies', () => {
        const { text, html } = build();
        assert.match(text, /personal account/i);
        assert.match(html, /personal<\/strong> account|personal account/i);
    });

    test('gives the deadline as a date rather than a duration', () => {
        const { text, html } = build();

        // "in 60 days" is useless in a message opened three weeks late.
        assert.ok(text.includes('October 2, 2026'));
        assert.ok(html.includes('October 2, 2026'));
        assert.ok(!/\b60 days\b/.test(text));
    });

    test('counts one letter as one letter', () => {
        assert.ok(build({ messageCount: 1 }).text.startsWith('Your letter has arrived'));
        assert.ok(build({ messageCount: 2 }).text.startsWith('Your 2 letters have arrived'));
        assert.ok(build({ messageCount: 1, forwarded: true }).text.startsWith('You forwarded a letter'));
        assert.ok(build({ messageCount: 2, forwarded: true }).text.startsWith('You forwarded 2 letters'));
    });

    test('tells the missionary they can hand the job to someone at home', () => {
        const mine = build();
        assert.match(mine.text, /forward this email to a parent/);
        assert.match(mine.html, /forward this email to a parent/);

        // The forwarder is already the one doing the setting up; telling them
        // to pass it on would send them looking for somebody else to ask.
        const theirs = build({ forwarded: true });
        assert.ok(!theirs.text.includes('forward this email'));
        assert.ok(!theirs.html.includes('forward this email'));
    });

    test('names the account the missionary must not use', () => {
        // The one address certain to stop working, and the only recipient who
        // has one.
        assert.match(build().text, /official missionary/);
        assert.ok(!build({ forwarded: true }).text.includes('official missionary'));
    });

    test('escapes the sender, which arrives from a header', () => {
        const { html } = build({ forwarded: true, sender: '"><script>alert(1)</script>@evil.test' });

        assert.ok(!html.includes('<script>'), 'a From: header is not trusted markup');
        assert.ok(html.includes('&lt;script&gt;'));
    });

    test('survives a base URL with a trailing slash', () => {
        // Both builders, because both compose the link the same way.
        for (const make of [build, reply]) {
            assert.equal(
                make({ baseUrl: 'https://pdayletters.com/' }).link,
                'https://pdayletters.com/claim#payload.signature'
            );
        }
    });
});

describe('the claim@ reply', () => {
    test('puts the token in a fragment, where no server will ever see it', () => {
        const { link, text, html } = reply();

        assert.equal(link, 'https://pdayletters.com/claim#payload.signature');
        assert.ok(!link.includes('?'), 'a query string would be logged');
        assert.ok(text.includes(link));
        assert.ok(html.includes(link));
    });

    test('names nobody in the subject', () => {
        // Says more than the pending one does, because it answers a request
        // its recipient just made. It still names no person and no site.
        assert.equal(reply().subject, 'Your Pday Letters access link');
    });

    test('gives the deadline as a date rather than a duration', () => {
        assert.ok(reply().text.includes('October 2, 2026'));
        assert.ok(reply().html.includes('October 2, 2026'));
    });

    test('rules out the one account that is certain to stop working', () => {
        // In both bodies: an owner entry keyed on the missionary address dies
        // with the mailbox, and this is the last moment anyone can act on it.
        for (const body of [reply().text, reply().html]) {
            assert.match(flat(body), /personal.{0,20}Google or Microsoft account/);
            assert.match(flat(body), /not your official missionary/);
            assert.match(flat(body), /60 days after you come home/);
        }
    });

    test('does not warn that the link works only once', () => {
        // True of the pending link and actively wrong of this one. The
        // recipient proved who they are, so another is theirs for the asking.
        const { text } = reply();

        assert.ok(!text.includes('whoever uses it first'));
        assert.match(flat(text), /Email claim@pdayletters.com again for a new one/);
    });

    test('promises a claimed archive cannot be taken back', () => {
        const { text, html } = reply({ alreadyOwned: true });

        // The reassurance leads. A parent already running the site happily is
        // not being displaced by this link, and must not read as though they
        // are.
        assert.match(flat(text), /added alongside them rather than in place of them/);

        // `members.js` keeps this promise: a verifiedMissionary owner cannot be
        // removed or demoted by anyone, an operator included.
        assert.match(flat(text), /nobody can remove you/);
        assert.match(flat(html), /nobody can remove you/);
        assert.match(flat(text), /these are your letters and this is your archive/i);
    });

    test('tells a first claimant the link makes the archive', () => {
        const { text } = reply();

        assert.match(flat(text), /sets the archive up and makes you its owner/);
        assert.ok(!flat(text).includes('alongside'), 'there is nobody to stand alongside yet');
    });

});
