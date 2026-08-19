// The book emails.
//
// The copy is a draft and will be rewritten. These tests are over the things
// that must stay true whatever the sentences end up saying.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bookFailedEmail, bookReadyEmail } from '../src/lib/bookmail.js';

const ready = (overrides = {}) =>
    bookReadyEmail({
        baseUrl: 'https://pdayletters.com',
        slug: 'isaac.backman',
        missionary: 'Elder Isaac Backman',
        pages: 96,
        letters: 41,
        ...overrides
    });

const failed = (overrides = {}) =>
    bookFailedEmail({
        baseUrl: 'https://pdayletters.com',
        slug: 'isaac.backman',
        missionary: 'Elder Isaac Backman',
        reason: 'there are no letters to print yet',
        ...overrides
    });

describe('the email that says a book is finished', () => {
    test('links to the page and not to either of the files', () => {
        const { link, text, html } = ready();

        // Both renditions are handed out behind storage links that die in
        // fifteen minutes. Mail is read hours later, so a link to one of them
        // would be broken by the time anybody pressed it -- and would be a
        // copy of the book sitting in an inbox besides.
        assert.equal(link, 'https://pdayletters.com/book/isaac.backman');
        assert.ok(text.includes(link));
        assert.ok(html.includes(link));
        assert.ok(!text.includes('.pdf'), 'a rendition link would be dead on arrival');
        assert.ok(!html.includes('.pdf'));
    });

    test('does not name the missionary in the subject', () => {
        // The rule from the claim email, and for the same reason: subject
        // lines are visible on a locked phone.
        assert.ok(!ready().subject.includes('Backman'));
    });

    test('names them in the body, for an owner who looks after two archives', () => {
        assert.match(ready().text, /Elder Isaac Backman/);
        assert.match(ready().html, /Elder Isaac Backman/);
    });

    test('manages without a name at all', () => {
        const { text, link } = ready({ missionary: '' });

        // The slug is an email address with the @ taken out, so it is a URL
        // and never a phrase. Everywhere but the link it falls back to a
        // possessive that needs no name.
        assert.match(text, /your letters/);
        assert.ok(!text.replace(link, '').includes('isaac.backman'));
    });

    test('quotes the letters and the pages, which are deliberately different numbers', () => {
        // A short archive is padded up to the printer's two dozen sheets, so
        // the pages routinely account for more than the letters do. Saying
        // both is what stops that reading as a mistake.
        assert.match(ready().text, /41 letters, 96 pages/);
    });

    test('counts one of a thing as one thing', () => {
        assert.match(ready({ letters: 1, pages: 24 }).text, /1 letter, 24 pages/);
    });

    test('says nothing has been printed, because nothing has', () => {
        assert.match(ready().text, /Nothing has been sent to a printer/);
    });
});

describe('the email that says a book did not finish', () => {
    test('carries the build s own sentence, which is written for a person', () => {
        // "there are no letters to print yet" is fixable in a moment.
        // "something went wrong" is not fixable at all.
        assert.match(failed().text, /there are no letters to print yet/);
        assert.match(failed().html, /there are no letters to print yet/);
    });

    test('still says something useful when the failure had no sentence', () => {
        const { text } = failed({ reason: '' });

        assert.match(text, /did not finish/);
        assert.match(text, /Nothing has happened to the letters/);
    });

    test('escapes a reason before putting it in the html body', () => {
        // The reasons are ours today. They are also the one string in either
        // message that comes from a thrown error, and errors quote input.
        const { html } = failed({ reason: '<script>alert(1)</script>' });

        assert.ok(!html.includes('<script>'));
        assert.match(html, /&lt;script&gt;/);
    });

    test('sends them back to the page to try again', () => {
        assert.equal(failed().link, 'https://pdayletters.com/book/isaac.backman');
        assert.match(failed().text, /Try it again/);
    });
});
