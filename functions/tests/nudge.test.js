// The one rejection that gets an answer.
//
// Two things are being checked here and they pull in opposite directions: that
// a parent who used the wrong menu item is told how to fix it, and that no
// amount of mail can make us send that advice more than once.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runIngest } from '../src/lib/ingest.js';
import { nudgeEmail, nudgeOnce, NUDGE } from '../src/lib/nudge.js';
import { memoryStore } from './memory-store.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const config = { authservId: 'mx.cloudflare.net', missionaryDomains: ['missionary.org'] };
const silent = { info() {}, warn() {}, error() {} };
const NOW = () => new Date('2026-08-03T12:00:00Z');

const recorder = () => {
    const mailer = { sent: [], send: async (m) => (mailer.sent.push(m), { status: 'sent' }) };
    return mailer;
};

const forward = async (store, mailer, name, ulid = '01TEST0000000000000000000', cfg = config) => {
    store.seed(ulid, await raw(name));
    return runIngest({
        ulid,
        store,
        tables: store,
        mailer,
        config: cfg,
        log: silent,
        now: NOW,
        verifyDkim: async () => ({ verified: false, reason: 'test', signatures: [] })
    });
};

describe('advising a forwarder who quoted instead of attaching', () => {
    test('answers an inline forward that would otherwise vanish', async () => {
        const store = memoryStore();
        const mailer = recorder();
        const result = await forward(store, mailer, 'outlook-web-inline');

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'bootstrap-not-attached');
        assert.equal(mailer.sent.length, 1, 'the forwarder was told nothing');
        assert.match(mailer.sent[0].text, /forward as attachment/i);
        // A stranger's mail arriving from a bare address reads as spam. The
        // name is the difference between "who is this" and "this is the thing
        // I just wrote to".
        assert.equal(mailer.sent[0].from, 'Pday Letters <post@pdayletters.com>');
    });

    test('says nothing at all the second time', async () => {
        // The scenario in the plan: somebody backfills a stack of old letters
        // in one sitting. Twenty forwards must not become twenty emails.
        const store = memoryStore();
        const mailer = recorder();
        await forward(store, mailer, 'outlook-web-inline', '01FIRST000000000000000000');
        await forward(store, mailer, 'outlook-web-inline', '01SECOND00000000000000000');
        await forward(store, mailer, 'outlook-web-inline', '01THIRD000000000000000000');

        assert.equal(mailer.sent.length, 1);
    });

    test('but a different person forwarding the same letter is still advised', async () => {
        // The advice is about the sender's own mail client, so it is owed to
        // each sender. These two fixtures carry the same missionary and
        // different families, which is exactly the case that must not be
        // silenced by the first one.
        const store = memoryStore();
        const mailer = recorder();
        await forward(store, mailer, 'outlook-web-inline', '01FIRST000000000000000000');
        await forward(store, mailer, 'gmail-web-inline', '01SECOND00000000000000000');

        assert.equal(mailer.sent.length, 2);
        assert.notEqual(mailer.sent[0].to, mailer.sent[1].to);
    });

    test('keeps nothing, because the letter was still refused', async () => {
        const store = memoryStore();
        await forward(store, recorder(), 'outlook-web-inline');

        assert.equal(store.json('pending', 'elder.example/claim.json'), null);
        assert.equal(
            [...store.blobs.keys()].some((k) => k.startsWith('raw/') || k.startsWith('pending/')),
            false,
            'an unverifiable letter was stored anyway'
        );
    });

    test('an attachment that failed to verify gets the other advice', async () => {
        // This used to be answered with silence, on the reasoning that the
        // sender had already attached the original and there was nothing left
        // to tell them. There is now: their client rebuilt the message, and
        // there are two ways round that. Silence here is what strands every
        // family whose only mail client is the Outlook desktop app.
        const store = memoryStore();
        const mailer = recorder();
        const result = await forward(store, mailer, 'outlook-web-attached');

        assert.equal(result.reason, 'bootstrap-unverified');
        assert.equal(mailer.sent.length, 1);
        assert.match(mailer.sent[0].text, /Outlook on the web/);
    });

    test('the two kinds of advice do not suppress each other', async () => {
        // The ordinary path through this is inline first, attachment second.
        // Keyed on person and missionary alone, the advice that actually
        // unblocks an Outlook user could never be sent -- it would always be
        // shadowed by the advice they had already followed.
        const store = memoryStore();
        const mailer = recorder();
        const common = {
            tables: store,
            mailer,
            to: 'parent@example.com',
            author: 'elder.one@missionary.org',
            slug: 'elder.one',
            now: NOW,
            log: silent
        };

        await nudgeOnce({ ...common, kind: NUDGE.attach });
        const second = await nudgeOnce({ ...common, kind: NUDGE.rebuilt });

        assert.equal(second.status, 'sent');
        assert.equal(mailer.sent.length, 2);

        const third = await nudgeOnce({ ...common, kind: NUDGE.rebuilt });
        assert.equal(third.status, 'duplicate');
    });

    test('a forward to a site that already exists is left in silence', async () => {
        // Answering here would confirm the archive exists to somebody who is
        // not on its ACL. The existence oracle is accepted for slugs with no
        // site; it is not extended to slugs with one.
        const store = memoryStore();
        store.acl('elder.example', [{ email: 'somebody@example.com', role: 'owner' }]);
        const mailer = recorder();
        const result = await forward(store, mailer, 'outlook-web-inline');

        assert.equal(result.reason, 'forwarder-not-on-acl');
        assert.equal(mailer.sent.length, 0);
    });

    test('a second missionary gets its own advice', async () => {
        // Keyed on sender *and* slug: a parent with two children out at once
        // has two archives to start, and advice they never read about the
        // first does not help them with the second.
        const store = memoryStore();
        const mailer = recorder();

        await nudgeOnce({
            tables: store,
            mailer,
            to: 'parent@example.com',
            author: 'elder.one@missionary.org',
            slug: 'elder.one',
            now: NOW,
            log: silent
        });
        await nudgeOnce({
            tables: store,
            mailer,
            to: 'parent@example.com',
            author: 'elder.two@missionary.org',
            slug: 'elder.two',
            now: NOW,
            log: silent
        });

        assert.equal(mailer.sent.length, 2);
    });

    test('the row is written even when the send fails, so it cannot retry forever', async () => {
        const store = memoryStore();
        const failing = { sent: [], send: async () => ({ status: 'failed' }) };

        await nudgeOnce({
            tables: store,
            mailer: failing,
            to: 'parent@example.com',
            author: 'elder.one@missionary.org',
            slug: 'elder.one',
            now: NOW,
            log: silent
        });
        const second = await nudgeOnce({
            tables: store,
            mailer: failing,
            to: 'parent@example.com',
            author: 'elder.one@missionary.org',
            slug: 'elder.one',
            now: NOW,
            log: silent
        });

        assert.equal(second.status, 'duplicate');
    });

    test('the advice names the missionary but the subject does not', async () => {
        // Safe to name in the body: this answers a message its recipient sent
        // us, quoting back an address they supplied. The subject line is
        // visible on a lock screen, so it stays anonymous.
        const body = nudgeEmail({ author: 'elder.example@missionary.org' });

        assert.match(body.text, /elder\.example@missionary\.org/);
        assert.doesNotMatch(body.subject, /elder\.example/);
    });

    test('carries no claim link, because nothing has been claimed', async () => {
        const body = nudgeEmail({ author: 'elder.example@missionary.org' });
        assert.doesNotMatch(body.text, /\/claim#/);
        assert.doesNotMatch(body.html, /\/claim#/);
    });

    test('the FAQ link is absolute and anchored, in both parts', async () => {
        // A relative href is fine on a page and useless in an email, and the
        // anchor matters as much as the host: someone reading this has one
        // question, and /faq alone lands them on a contents list.
        const body = nudgeEmail({
            author: 'elder.example@missionary.org',
            baseUrl: 'https://pdayletters.com/'
        });

        const expected = 'https://pdayletters.com/faq#forward-did-nothing';
        assert.ok(body.text.includes(expected), 'plain text link');
        assert.ok(body.html.includes(`href="${expected}"`), 'html link');
    });

    test('both parts say the same things', async () => {
        // Nothing in the send path checks that they agree, so a client showing
        // one and a client showing the other could be told different stories.
        const body = nudgeEmail({
            author: 'elder.example@missionary.org',
            baseUrl: 'https://pdayletters.com'
        });
        const stripped = body.html.replace(/<[^>]+>/g, ' ');

        for (const phrase of [
            'Forward as attachment',
            'post@pdayletters.com',
            'only needed for the first letter'
        ]) {
            assert.ok(body.text.includes(phrase), `text: ${phrase}`);
            assert.ok(stripped.includes(phrase), `html: ${phrase}`);
        }
    });

    test('both parts of the second advice say the same things too', async () => {
        const body = nudgeEmail({
            author: 'elder.example@missionary.org',
            baseUrl: 'https://pdayletters.com',
            kind: NUDGE.rebuilt,
            askUrl: 'https://pdayletters.com/ask#tok',
            requester: 'parent@example.com'
        });
        const stripped = body.html.replace(/<[^>]+>/g, ' ');

        for (const phrase of [
            'rebuilt the letter as it sent it',
            'Outlook on the web does not rebuild the message',
            'never spoofed or faked on this',
            'only needed for the first letter'
        ]) {
            assert.ok(body.text.includes(phrase), `text: ${phrase}`);
            assert.ok(stripped.includes(phrase), `html: ${phrase}`);
        }

        // The URL itself cannot be word-identical: the HTML hides it behind
        // anchor text and the plain-text part has nowhere to hide it. Both
        // must still carry it somewhere usable.
        assert.ok(body.text.includes('https://pdayletters.com/ask#tok'));
        assert.match(body.html, /href="https:\/\/pdayletters\.com\/ask#tok"/);
    });

    test('the second advice offers the web route before it offers the missionary', async () => {
        // A missionary has a set number of minutes to write home. The route
        // that costs nobody anything goes first, and the order is the only
        // thing enforcing that.
        const body = nudgeEmail({
            author: 'elder.example@missionary.org',
            baseUrl: 'https://pdayletters.com',
            kind: NUDGE.rebuilt,
            askUrl: 'https://pdayletters.com/ask#tok'
        });

        assert.ok(body.text.indexOf('outlook.com') < body.text.indexOf('/ask#tok'));
    });

    test('a missing relay link costs the second route, not the advice', async () => {
        // The signing key is the only thing that can be absent here, and the
        // first route works without us.
        const body = nudgeEmail({
            author: 'elder.example@missionary.org',
            baseUrl: 'https://pdayletters.com',
            kind: NUDGE.rebuilt,
            askUrl: ''
        });

        assert.match(body.text, /Outlook on the web/);
        assert.doesNotMatch(body.text, /\/ask#/);
    });

    test('the first advice offers the missionary too, for a phone that cannot attach', async () => {
        // The Outlook and Gmail phone apps have no "forward as attachment"
        // item at all, so an inline forwarder holding only a phone was being
        // given advice they could not follow and nothing else. Withholding
        // the link here bought no security: the author address in quoted text
        // is no less forgeable than one in an attached file.
        const body = nudgeEmail({
            author: 'elder.example@missionary.org',
            baseUrl: 'https://pdayletters.com',
            kind: NUDGE.attach,
            askUrl: 'https://pdayletters.com/ask#tok',
            requester: 'parent@example.com'
        });
        const stripped = body.html.replace(/<[^>]+>/g, ' ');

        for (const phrase of [
            'Forward the letter again as an attachment',
            'never spoofed or faked on this',
            'only needed for the first letter'
        ]) {
            assert.ok(body.text.includes(phrase), `text: ${phrase}`);
            assert.ok(stripped.includes(phrase), `html: ${phrase}`);
        }

        assert.ok(body.text.includes('https://pdayletters.com/ask#tok'));
        assert.match(body.html, /href="https:\/\/pdayletters\.com\/ask#tok"/);
    });

    test('the link is anchored, not printed bare, and names who it is for', async () => {
        // A naked URL in a message about not trusting unverified mail reads
        // like the thing it is warning about. The address is shown because it
        // is what the missionary will be asked to forward to, and the reader
        // is the only person who can catch it being wrong.
        for (const kind of [NUDGE.attach, NUDGE.rebuilt]) {
            const body = nudgeEmail({
                author: 'elder.example@missionary.org',
                baseUrl: 'https://pdayletters.com',
                kind,
                askUrl: 'https://pdayletters.com/ask#tok',
                requester: 'parent@example.com'
            });

            assert.match(body.html, /<a href="https:\/\/pdayletters\.com\/ask#tok">Click this link<\/a>/, kind);
            assert.doesNotMatch(body.html, />https:\/\/pdayletters\.com\/ask#tok</, `${kind}: bare link`);
            assert.ok(body.text.includes('parent@example.com'), `${kind}: text address`);
            assert.ok(body.html.includes('parent@example.com'), `${kind}: html address`);
        }
    });

    test('the first advice offers the attachment before it offers the missionary', async () => {
        // Same ordering rule as the other reply, and for the same reason: the
        // route that spends a missionary's minutes goes second.
        const body = nudgeEmail({
            author: 'elder.example@missionary.org',
            baseUrl: 'https://pdayletters.com',
            kind: NUDGE.attach,
            askUrl: 'https://pdayletters.com/ask#tok'
        });

        assert.ok(body.text.indexOf('Forward as attachment') < body.text.indexOf('/ask#tok'));
    });

    test('an inline forward is answered with a usable link, not just a menu item', async () => {
        // End to end, because the link is minted in ingest and the branch that
        // does it used to withhold it for exactly this kind.
        const store = memoryStore();
        const mailer = recorder();
        const result = await forward(store, mailer, 'outlook-web-inline', '01LINK0000000000000000000', {
            ...config,
            claimTokenKey: 'test-key',
            baseUrl: 'https://pdayletters.com'
        });

        assert.equal(result.reason, 'bootstrap-not-attached');
        assert.match(mailer.sent[0].text, /https:\/\/pdayletters\.com\/ask#/);
    });
});
