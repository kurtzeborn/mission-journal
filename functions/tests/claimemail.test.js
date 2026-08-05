// Claim email tests.
//
// The copy is a draft and will be rewritten. These tests are over the things
// that must stay true whatever the sentences end up saying.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { claimEmail } from '../src/lib/claimemail.js';

const build = (overrides = {}) =>
    claimEmail({
        baseUrl: 'https://pdayletters.com',
        token: 'payload.signature',
        messageCount: 4,
        sender: 'elder.example@missionary.org',
        expiresAt: '2026-10-02T12:00:00.000Z',
        ...overrides
    });

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
        assert.ok(build({ messageCount: 1 }).text.startsWith('1 letter sent'));
        assert.ok(build({ messageCount: 2 }).text.startsWith('2 letters sent'));
    });

    test('escapes the sender, which arrives from a header', () => {
        const { html } = build({ sender: '"><script>alert(1)</script>@evil.test' });

        assert.ok(!html.includes('<script>'), 'a From: header is not trusted markup');
        assert.ok(html.includes('&lt;script&gt;'));
    });

    test('survives a base URL with a trailing slash', () => {
        assert.equal(
            build({ baseUrl: 'https://pdayletters.com/' }).link,
            'https://pdayletters.com/claim#payload.signature'
        );
    });
});
