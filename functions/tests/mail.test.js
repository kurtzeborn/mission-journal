// Sending, and refusing to send.
//
// The interesting cases here are all failures. A working send is one assertion;
// everything else is about what happens when the provider says no, when the
// recipient is somebody we never meant to write to, and when a mail failure
// meets a letter that has already been safely stored.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMailer, parseAllowlist, maskAddress } from '../src/lib/mail.js';
import { offerClaim, POST_ADDRESS } from '../src/lib/offer.js';
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
        assert.equal(calls[0].body.from, POST_ADDRESS);
        assert.equal(calls[0].body.headers['In-Reply-To'], '<first@missionary.org>');
        // RFC 3834: this is a response to a specific message, not mail that
        // nothing triggered.
        assert.equal(calls[0].body.headers['Auto-Submitted'], 'auto-replied');
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
