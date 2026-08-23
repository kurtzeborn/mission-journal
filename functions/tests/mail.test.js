// Sending, and refusing to send.
//
// The interesting cases here are all failures. A working send is one assertion;
// everything else is about what happens when the provider says no, when the
// recipient is somebody we never meant to write to, and when a mail failure
// meets a letter that has already been safely stored.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMailer, parseAllowlist, maskAddress } from '../src/lib/mail.js';
import { offerClaim, resendClaim, remindPending, invitationDue } from '../src/lib/offer.js';
import { holdPending } from '../src/lib/pending.js';
import { memoryStore } from './memory-store.js';

const KEY = 'a'.repeat(44);
const NOW = () => new Date('2026-08-04T12:00:00Z');
const SLUG = 'elder.example';
const SENDER = 'elder.example@missionary.org';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const collecting = () => {
    const errors = [];
    return { log: { ...quiet, error: (m, d) => errors.push({ m, d }) }, errors };
};

// A fetch double. `replies` is consumed one call at a time; `calls` records
// what was asked of it.
const fakeFetch = (replies) => {
    const calls = [];
    const queue = [...replies];
    const doFetch = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        const next = queue.shift() ?? { ok: true, status: 200, json: { success: true, result: { delivered: ['x'] } } };
        if (next.throws) throw new Error(next.throws);
        return { ok: next.ok, status: next.status, json: async () => next.json };
    };
    return { doFetch, calls };
};

const ok = { ok: true, status: 200, json: { success: true, result: { delivered: ['a@b.com'], permanent_bounces: [], queued: [] } } };

const mailerWith = (replies, allowlist = '*') => {
    const { doFetch, calls } = fakeFetch(replies);
    return {
        mailer: createMailer({ accountId: 'acct', token: 'secret-token', allowlist, fetch: doFetch }),
        calls
    };
};

const message = { from: 'post@pdayletters.com', to: 'a@b.com', subject: 'hi', text: 'hi', html: '<p>hi</p>' };

// --- the allowlist ---------------------------------------------------------

describe('who may be written to', () => {
    test('an empty setting sends to nobody at all', async () => {
        const { mailer, calls } = mailerWith([ok], '');
        const { log, errors } = collecting();

        const result = await mailer.send({ ...message, log });

        assert.equal(result.status, 'blocked');
        assert.equal(calls.length, 0, 'the provider was never contacted');
        assert.ok(errors.some((e) => e.m.includes('allowlist')));
    });

    test('an address on the list goes through, one that is not does not', async () => {
        const { mailer, calls } = mailerWith([ok, ok], 'Allowed@Example.com');

        assert.equal((await mailer.send({ ...message, to: 'allowed@example.com', log: quiet })).status, 'sent');
        assert.equal((await mailer.send({ ...message, to: 'stranger@example.com', log: quiet })).status, 'blocked');
        assert.equal(calls.length, 1);
    });

    test('the list is matched case-insensitively, because addresses are typed by hand', async () => {
        const { mailer } = mailerWith([ok], 'allowed@example.com');
        assert.equal((await mailer.send({ ...message, to: 'ALLOWED@Example.COM', log: quiet })).status, 'sent');
    });

    test('`*` is the only way to reach everyone, and it has to be written down', () => {
        assert.equal(parseAllowlist('*').open, true);
        assert.equal(parseAllowlist('').open, false);
        assert.equal(parseAllowlist(undefined).open, false);
        assert.equal(parseAllowlist('a@b.com, c@d.com').addresses.size, 2);
    });

    test('a blocked recipient is never written to a log in full', async () => {
        const { mailer } = mailerWith([], '');
        const { log, errors } = collecting();

        await mailer.send({ ...message, to: 'grandma@example.com', log });

        const written = JSON.stringify(errors);
        assert.ok(!written.includes('grandma@example.com'));
        assert.ok(written.includes('g***@example.com'));
    });

    test('masking keeps the domain, which is the part worth having in a log', () => {
        assert.equal(maskAddress('someone@example.com'), 's***@example.com');
        assert.equal(maskAddress('not-an-address'), '(invalid)');
        assert.equal(maskAddress(''), '(invalid)');
    });
});

// --- talking to the provider ----------------------------------------------

describe('sending', () => {
    test('posts what the provider expects, with the token in the header and not the body', async () => {
        const { mailer, calls } = mailerWith([ok]);

        await mailer.send({ ...message, headers: { 'In-Reply-To': '<abc@x>' }, log: quiet });

        assert.match(calls[0].url, /accounts\/acct\/email\/sending\/send$/);
        assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token');
        assert.equal(calls[0].body.from, 'post@pdayletters.com');
        assert.equal(calls[0].body.headers['In-Reply-To'], '<abc@x>');
    });

    test('a reply address travels as a field, because as a header it is refused', async () => {
        // Cloudflare's `headers` object is an allowlist, and anything with a
        // first-class field of its own is rejected there with a 400 and no
        // partial send. Every claim link and every receipt this service tried
        // to send was lost that way before anyone noticed.
        const { mailer, calls } = mailerWith([ok]);

        await mailer.send({ ...message, replyTo: 'hello@pdayletters.com', log: quiet });

        assert.equal(calls[0].body.reply_to, 'hello@pdayletters.com');
        assert.equal('Reply-To' in calls[0].body.headers, false);
    });

    test('and is left out entirely when there is nowhere else to reply', async () => {
        const { mailer, calls } = mailerWith([ok]);

        await mailer.send({ ...message, log: quiet });

        assert.equal('reply_to' in calls[0].body, false);
    });

    test('a permanent bounce is a failure, not a success with a quiet note', async () => {
        const bounced = {
            ok: true,
            status: 200,
            json: { success: true, result: { delivered: [], permanent_bounces: ['a@b.com'], queued: [] } }
        };
        const { mailer } = mailerWith([bounced]);
        const { log, errors } = collecting();

        assert.equal((await mailer.send({ ...message, log })).status, 'bounced');
        assert.ok(errors.some((e) => e.m.includes('bounced')));
    });

    test('queued still counts as sent -- the provider has it', async () => {
        const queued = {
            ok: true,
            status: 200,
            json: { success: true, result: { delivered: [], permanent_bounces: [], queued: ['a@b.com'] } }
        };
        const { mailer } = mailerWith([queued]);
        assert.equal((await mailer.send({ ...message, log: quiet })).status, 'sent');
    });

    test('a rejection reports the provider`s own error code', async () => {
        const rejected = {
            ok: false,
            status: 403,
            json: { success: false, errors: [{ code: 10105, message: 'email.sending.error.authentication.not_entitled' }] }
        };
        const { mailer } = mailerWith([rejected]);
        const result = await mailer.send({ ...message, log: quiet });

        assert.equal(result.status, 'failed');
        assert.match(result.detail, /10105/);
    });

    test('a network failure never carries the request into the log', async () => {
        const { mailer } = mailerWith([{ throws: 'connect ECONNREFUSED with body containing the token' }]);
        const { log, errors } = collecting();

        const result = await mailer.send({ ...message, log });

        assert.equal(result.status, 'failed');
        assert.ok(!JSON.stringify(errors).includes('token'));
        assert.ok(!JSON.stringify(result).includes('token'));
    });

    test('missing credentials refuse rather than post to nowhere', async () => {
        const { doFetch, calls } = fakeFetch([ok]);
        const bare = createMailer({ accountId: '', token: '', allowlist: '*', fetch: doFetch });

        assert.equal((await bare.send({ ...message, log: quiet })).status, 'failed');
        assert.equal(calls.length, 0);
    });

    test('a suppressed address is a rejection like any other', async () => {
        // There was briefly a `suppressed` status of its own, matching on the
        // word. Cloudflare publishes no code for it over REST, so the match was
        // a guess -- and the page says the same useful thing either way. The
        // provider's words survive in `detail`, for logs.
        const suppressed = {
            ok: false,
            status: 400,
            json: { success: false, errors: [{ code: 10250, message: 'email.sending.error.email.suppressed' }] }
        };
        const { mailer } = mailerWith([suppressed]);
        const result = await mailer.send({ ...message, log: quiet });

        assert.equal(result.status, 'failed');
        assert.match(result.detail, /suppressed/);
    });
});

// --- offering a pending site ----------------------------------------------

async function held(store, { count = 1, messageId = '<first@missionary.org>' } = {}) {
    for (let i = 0; i < count; i++) {
        await holdPending({
            store,
            slug: SLUG,
            ulid: `ulid-${i}`,
            raw: Buffer.from(`letter ${i}`),
            subject: `Week ${i + 1}`,
            sender: SENDER,
            messageId: i === count - 1 ? messageId : `<older-${i}@missionary.org>`,
            hasDirect: true,
            now: NOW,
            log: quiet
        });
    }
    return store;
}

const manifestOf = (store) =>
    JSON.parse(store.blobs.get(`pending/${SLUG}/claim.json`).bytes.toString('utf8'));

describe('offering a pending site', () => {
    test('emails the sender a link that works, and threads it to their own letter', async () => {
        const store = await held(memoryStore(), { count: 2 });
        const { mailer, calls } = mailerWith([ok]);

        const result = await offerClaim({ store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://pdayletters.com', now: NOW, log: quiet });

        assert.equal(result.status, 'sent');
        assert.equal(calls[0].body.to, SENDER);
        // The literal rather than `mailFrom(POST_ADDRESS)`: this is the string a
        // mail client actually parses, and restating the implementation would
        // let a broken one pass.
        assert.equal(calls[0].body.from, 'Pday Letters <post@pdayletters.com>');
        assert.equal(calls[0].body.headers['In-Reply-To'], '<first@missionary.org>');
        // RFC 3834: this is a response to a specific message, not mail that
        // nothing triggered.
        assert.equal(calls[0].body.headers['Auto-Submitted'], 'auto-replied');
        // A field, not a header. As a header this whole message is refused.
        assert.equal(calls[0].body.reply_to, 'hello@pdayletters.com');
        assert.match(calls[0].body.text, /\/claim#/);
    });

    test('threading headers are omitted rather than emptied when there is no Message-ID', async () => {
        const store = await held(memoryStore(), { messageId: '' });
        const { mailer, calls } = mailerWith([ok]);

        await offerClaim({ store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://pdayletters.com', now: NOW, log: quiet });

        assert.equal('In-Reply-To' in calls[0].body.headers, false);
        assert.equal('References' in calls[0].body.headers, false);
    });

    test('records the offer only once the provider has taken it', async () => {
        const store = await held(memoryStore());
        const { mailer } = mailerWith([ok]);

        assert.equal(manifestOf(store).claimEmailCount, 0);
        await offerClaim({ store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://x.com', now: NOW, log: quiet });

        const after = manifestOf(store);
        assert.equal(after.claimEmailCount, 1);
        assert.deepEqual(after.emailedAddresses, [SENDER]);
        assert.ok(after.claimEmailSentAt);
    });

    test('a failed send leaves no trace of having offered anything', async () => {
        const store = await held(memoryStore());
        const { mailer } = mailerWith([{ ok: false, status: 500, json: { success: false, errors: [] } }]);

        const result = await offerClaim({ store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://x.com', now: NOW, log: quiet });

        // This is the property the purge timer's "expired without ever being
        // offered" alarm rests on. If a failed send could still bump the
        // count, that alarm would go quiet in exactly the case it exists for.
        assert.equal(result.status, 'failed');
        const after = manifestOf(store);
        assert.equal(after.claimEmailCount, 0);
        assert.equal(after.claimEmailSentAt, null);
        assert.deepEqual(after.emailedAddresses, []);
    });

    test('a blocked recipient also leaves the count alone', async () => {
        const store = await held(memoryStore());
        const { mailer } = mailerWith([], 'someone.else@example.com');

        const result = await offerClaim({ store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://x.com', now: NOW, log: quiet });

        assert.equal(result.status, 'blocked');
        assert.equal(manifestOf(store).claimEmailCount, 0);
    });

    test('a claimed site is never offered again', async () => {
        const store = await held(memoryStore());
        const current = manifestOf(store);
        store.blobs.set(`pending/${SLUG}/claim.json`, {
            bytes: Buffer.from(JSON.stringify({ ...current, claimedAt: '2026-08-04T00:00:00Z' })),
            etag: 'x'
        });

        const { mailer, calls } = mailerWith([ok]);
        const result = await offerClaim({ store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://x.com', now: NOW, log: quiet });

        assert.equal(result.status, 'claimed');
        assert.equal(calls.length, 0);
    });

    test('a site with no return address says so instead of failing silently', async () => {
        const store = memoryStore();
        await holdPending({
            store, slug: SLUG, ulid: 'u', raw: Buffer.from('x'),
            subject: 'Week 1', sender: '', hasDirect: true, now: NOW, log: quiet
        });

        const { mailer, calls } = mailerWith([ok]);
        const { log, errors } = collecting();
        const result = await offerClaim({ store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://x.com', now: NOW, log });

        assert.equal(result.status, 'no-recipient');
        assert.equal(calls.length, 0);
        assert.ok(errors.some((e) => e.m.includes('no sender')));
    });
});

// --- "email me a new link" -------------------------------------------------

const at = (iso) => () => new Date(iso);
const DAY = 24 * 60 * 60 * 1000;
const later = (days) => at(new Date(NOW().getTime() + days * DAY).toISOString());

// Offer a pending site and hand back the token that went out in the email.
// Read out of the message rather than minted alongside it, because the token
// under test is the one a person actually received.
async function offered(store, mailer, calls, now = NOW) {
    await offerClaim({ store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://x.com', now, log: quiet });
    return /\/claim#(\S+)/.exec(calls[calls.length - 1].body.text)[1];
}

describe('asking for a new claim link', () => {
    // The shape this exists for: a token minted against the window as it stood
    // in August, a letter in September that rolls the window forward, and
    // somebody going looking for the email in November. The link is dead and
    // the letters are not.
    async function stale() {
        const store = await held(memoryStore());
        const { mailer, calls } = mailerWith([ok, ok]);
        const token = await offered(store, mailer, calls);

        await holdPending({
            store, slug: SLUG, ulid: 'u-later', raw: Buffer.from('another letter'),
            subject: 'Week 8', sender: SENDER, hasDirect: true, now: later(50), log: quiet
        });

        return { store, mailer, calls, token };
    }

    test('a stale link brings a working one, sent where the last one went', async () => {
        const { store, mailer, calls, token } = await stale();

        const result = await resendClaim({
            store, mailer, token, key: KEY, baseUrl: 'https://x.com', now: later(70), log: quiet
        });

        assert.equal(result.status, 'sent');
        assert.equal(calls.length, 2);
        assert.equal(calls[1].body.to, SENDER);
        // A different token, and the manifest now expects the new one -- the
        // old link has to stop working or every ask doubles the live
        // credentials.
        const reissued = /\/claim#(\S+)/.exec(calls[1].body.text)[1];
        assert.notEqual(reissued, token);
        assert.equal(manifestOf(store).claimEmailCount, 2);
    });

    test('nothing about who was written to comes back to the asker', async () => {
        const { store, mailer, token } = await stale();

        const result = await resendClaim({
            store, mailer, token, key: KEY, baseUrl: 'https://x.com', now: later(70), log: quiet
        });

        // The holder of a dead link may ask that somebody be written to. They
        // may not find out who that is.
        assert.deepEqual(Object.keys(result), ['status']);
    });

    test('a second ask within the hour is refused', async () => {
        const { store, mailer, calls, token } = await stale();
        await resendClaim({ store, mailer, token, key: KEY, baseUrl: 'https://x.com', now: later(70), log: quiet });

        const again = await resendClaim({
            store, mailer, token, key: KEY, baseUrl: 'https://x.com', now: later(70), log: quiet
        });

        assert.equal(again.status, 'recent');
        assert.equal(calls.length, 2);
    });

    test('and allowed again once the hour is up', async () => {
        const { store, mailer, calls, token } = await stale();
        await resendClaim({ store, mailer, token, key: KEY, baseUrl: 'https://x.com', now: later(70), log: quiet });

        const again = await resendClaim({
            store, mailer, token, key: KEY, baseUrl: 'https://x.com', now: later(71), log: quiet
        });

        assert.equal(again.status, 'sent');
        assert.equal(calls.length, 3);
    });

    test('a site whose own window has run out has nothing to send', async () => {
        // A fresh link would be born expired, and the letters are already on
        // the purge job's list.
        const store = await held(memoryStore());
        const { mailer, calls } = mailerWith([ok]);
        const token = await offered(store, mailer, calls);

        const result = await resendClaim({
            store, mailer, token, key: KEY, baseUrl: 'https://x.com', now: later(90), log: quiet
        });

        assert.equal(result.status, 'gone');
        assert.equal(calls.length, 1);
    });

    test('a claimed site has nothing to send either', async () => {
        const store = await held(memoryStore());
        const { mailer, calls } = mailerWith([ok]);
        const token = await offered(store, mailer, calls);
        const current = manifestOf(store);
        store.blobs.set(`pending/${SLUG}/claim.json`, {
            bytes: Buffer.from(JSON.stringify({ ...current, claimedAt: '2026-08-05T00:00:00Z' })),
            etag: 'x'
        });

        const result = await resendClaim({
            store, mailer, token, key: KEY, baseUrl: 'https://x.com', now: later(1), log: quiet
        });

        assert.equal(result.status, 'gone');
        assert.equal(calls.length, 1);
    });

    test('a token we did not sign is refused before anything is read', async () => {
        const { store, mailer, calls, token } = await stale();

        const result = await resendClaim({
            store, mailer, token, key: 'b'.repeat(44), baseUrl: 'https://x.com', now: later(70), log: quiet
        });

        assert.equal(result.status, 'invalid');
        assert.equal(calls.length, 1);
    });

    test('a live link may be resent too, and supersedes itself', async () => {
        // Not the case it was written for, but a person who has mislaid the
        // email cannot tell a stale link from a live one and should not have
        // to. The only cost is that the link they mislaid stops working.
        const store = await held(memoryStore());
        const { mailer, calls } = mailerWith([ok, ok]);
        const token = await offered(store, mailer, calls);

        const result = await resendClaim({
            store, mailer, token, key: KEY, baseUrl: 'https://x.com', now: later(2), log: quiet
        });

        assert.equal(result.status, 'sent');
        assert.equal(calls.length, 2);
    });
});

// --- chasing a site nobody came back to ------------------------------------

describe('inviting the missionary again', () => {
    const manifest = (count, sentDaysAgo) => ({
        claimEmailCount: count,
        claimEmailSentAt: new Date(NOW().getTime() - sentDaysAgo * 24 * 60 * 60 * 1000).toISOString()
    });

    test('the first letter always invites', () => {
        assert.equal(invitationDue({ claimEmailCount: 0 }, NOW()), true);
    });

    test('the gaps widen: thirty days, then ninety, then a hundred and eighty', () => {
        assert.equal(invitationDue(manifest(1, 29), NOW()), false);
        assert.equal(invitationDue(manifest(1, 30), NOW()), true);
        assert.equal(invitationDue(manifest(2, 89), NOW()), false);
        assert.equal(invitationDue(manifest(2, 90), NOW()), true);
        assert.equal(invitationDue(manifest(3, 179), NOW()), false);
        assert.equal(invitationDue(manifest(3, 180), NOW()), true);
    });

    test('and stay at a hundred and eighty rather than running off the end', () => {
        assert.equal(invitationDue(manifest(9, 179), NOW()), false);
        assert.equal(invitationDue(manifest(9, 180), NOW()), true);
    });

    test('a count with no stamp behind it invites once more', () => {
        // A manifest written before any of this existed. Inviting is the safe
        // direction; the alternative is a site that can never be chased again.
        assert.equal(invitationDue({ claimEmailCount: 2 }, NOW()), true);
    });
});

describe('reminding a forwarder', () => {
    // A pending site created by a forward rather than a direct send, offered
    // once, and then left alone.
    async function forwarded(mailer, calls) {
        const store = memoryStore();
        await holdPending({
            store, slug: SLUG, ulid: 'u', raw: Buffer.from('a letter'),
            subject: 'Week 1', sender: SENDER, messageId: '<m@x>', hasDirect: false,
            now: NOW, log: quiet
        });
        await offerClaim({
            store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://x.com',
            to: 'mum@example.com', forwarded: true, now: NOW, log: quiet
        });
        return store;
    }

    const chase = (store, mailer, days) =>
        remindPending({ store, mailer, key: KEY, baseUrl: 'https://x.com', now: later(days), log: quiet });

    test('nothing happens for the first week', async () => {
        const { mailer, calls } = mailerWith([ok, ok]);
        const store = await forwarded(mailer, calls);

        assert.deepEqual((await chase(store, mailer, 6)).reminded, []);
        assert.equal(calls.length, 1);
    });

    test('one reminder goes on the seventh day, to the address that was written to', async () => {
        const { mailer, calls } = mailerWith([ok, ok]);
        const store = await forwarded(mailer, calls);

        assert.deepEqual((await chase(store, mailer, 7)).reminded, [SLUG]);
        assert.equal(calls[1].body.to, 'mum@example.com');
    });

    test('and only one, however many nights the job runs', async () => {
        // Keyed to the site's own counter, so there is no "already reminded"
        // flag to forget to write.
        const { mailer, calls } = mailerWith([ok, ok, ok]);
        const store = await forwarded(mailer, calls);

        await chase(store, mailer, 7);
        assert.deepEqual((await chase(store, mailer, 8)).reminded, []);
        assert.equal(calls.length, 2);
    });

    test('a site the missionary writes to directly is left to ingest', async () => {
        // `hasDirect` means there is somebody to reply to, and replying to a
        // letter is the tapering series' job. Two chasers on one site would be
        // two emails a week apart saying the same thing.
        const { mailer, calls } = mailerWith([ok, ok]);
        const store = await held(memoryStore());
        await offerClaim({ store, mailer, slug: SLUG, key: KEY, baseUrl: 'https://x.com', now: NOW, log: quiet });

        assert.deepEqual((await chase(store, mailer, 30)).reminded, []);
        assert.equal(calls.length, 1);
    });

    test('a claimed site is not chased', async () => {
        const { mailer, calls } = mailerWith([ok, ok]);
        const store = await forwarded(mailer, calls);
        const current = manifestOf(store);
        store.blobs.set(`pending/${SLUG}/claim.json`, {
            bytes: Buffer.from(JSON.stringify({ ...current, claimedAt: '2026-08-06T00:00:00Z' })),
            etag: 'x'
        });

        assert.deepEqual((await chase(store, mailer, 7)).reminded, []);
        assert.equal(calls.length, 1);
    });

    test('nor one whose letters are already on their way out', async () => {
        // Forward-only sites hold for fourteen days. A reminder about letters
        // being deleted tonight is worse than no reminder.
        const { mailer, calls } = mailerWith([ok, ok]);
        const store = await forwarded(mailer, calls);

        assert.deepEqual((await chase(store, mailer, 20)).reminded, []);
        assert.equal(calls.length, 1);
    });

    test('nor one that was never successfully offered in the first place', async () => {
        // `claimEmailCount` is zero, which means nobody was ever told. That is
        // the purge sweep's alarm to raise, not a reminder to send about an
        // email that does not exist.
        const store = memoryStore();
        await holdPending({
            store, slug: SLUG, ulid: 'u', raw: Buffer.from('a letter'),
            subject: 'Week 1', sender: SENDER, hasDirect: false, now: NOW, log: quiet
        });
        const { mailer, calls } = mailerWith([ok]);

        assert.deepEqual((await chase(store, mailer, 7)).reminded, []);
        assert.equal(calls.length, 0);
    });
});
