// Telling somebody their letter arrived.
//
// The scenario that shapes every test here is the good one: a family finds the
// service and forwards two years of letters in an afternoon. That has to
// produce exactly one reply. The receipt exists so nobody forwards the same
// letter five times wondering whether it worked, and a hundred receipts would
// be a worse answer to that than none.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ackEmail, acknowledgeForward } from '../src/lib/ack.js';
import { deliveryTrouble } from '../src/lib/delivery.js';
import { runIngest } from '../src/lib/ingest.js';
import { recordOptOut, issueOptOut } from '../src/lib/optout.js';
import { verifyEmbeddedDkim } from '../src/lib/dkim.js';
import { memoryStore } from './memory-store.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const quiet = { info() {}, warn() {}, error() {} };
const NOW = () => new Date('2026-08-16T09:00:00Z');
const SLUG = 'elder.example';
const KEY = 'a'.repeat(44);
const READER = [{ email: 'scott@kurtzeborn.org', role: 'reader' }];

const recorder = (status = 'sent') => {
    const mailer = { sent: [], send: async (m) => (mailer.sent.push(m), { status }) };
    return mailer;
};

const noNetwork = async (name) => {
    throw new Error(`unit tests must not resolve DNS (asked for ${name})`);
};

const config = {
    authservId: 'mx.cloudflare.net',
    missionaryDomains: ['missionary.org'],
    baseUrl: 'https://pdayletters.com'
};

/** One forwarded letter, all the way through ingest, with a mailer watching. */
const forward = async (store, mailer, name = 'outlook-web-attached', ulid = '01TEST0000000000000000000') => {
    store.seed(ulid, await raw(name));
    return runIngest({
        ulid,
        store,
        tables: store,
        mailer,
        config,
        log: quiet,
        now: NOW,
        verifyDkim: (extracted) => verifyEmbeddedDkim(extracted, { resolver: noNetwork })
    });
};

const ack = (store, mailer, extra = {}) =>
    acknowledgeForward({
        tables: store,
        mailer,
        to: 'aunt@example.com',
        slug: SLUG,
        author: 'Elder Example',
        baseUrl: 'https://pdayletters.com',
        now: NOW,
        log: quiet,
        ...extra
    });

describe('what the receipt says', () => {
    test('it names the missionary in the body and not in the subject', async () => {
        // A subject line is visible on a lock screen; a body is not. Same split
        // the nudge makes, for the same reason.
        const body = ackEmail({ author: 'Elder Example', slug: SLUG, baseUrl: 'https://pdayletters.com' });

        assert.equal(body.subject, 'Your letter arrived');
        assert.doesNotMatch(body.subject, /Example/);
        assert.match(body.text, /Elder Example/);
        assert.match(body.html, /Elder Example/);
    });

    test('it says not to send it again, and that one note covers the lot', async () => {
        const body = ackEmail({ author: '', slug: SLUG, baseUrl: 'https://pdayletters.com' });

        assert.match(body.text, /do not need to send it\s*\n?again/);
        assert.match(body.text, /one note rather than one per letter/);
    });

    test('an unknown author leaves no gap in the sentence', async () => {
        const body = ackEmail({ author: '', slug: SLUG, baseUrl: 'https://pdayletters.com' });

        assert.match(body.text, /the letter you forwarded is in the archive/);
        assert.doesNotMatch(body.text, /letter from\s/);
    });

    test('the archive link is built from the slug, escaped', async () => {
        const body = ackEmail({ author: '', slug: 'elder.o&brien', baseUrl: 'https://pdayletters.com/' });

        assert.match(body.text, /https:\/\/pdayletters\.com\/elder\.o%26brien\//);
        assert.doesNotMatch(body.html, /o&brien/);
    });

    test('somebody who never asked for this is told what happened', async () => {
        // The address came out of a stranger's mail headers. A receipt that
        // explains nothing reads as the beginning of a spam campaign.
        const body = ackEmail({ author: 'Elder Example', slug: SLUG, baseUrl: 'https://pdayletters.com' });

        assert.match(body.text, /If you were not expecting this/);
        assert.match(body.text, /Nothing was published anywhere public/);
    });
});

describe('sending it', () => {
    test('the reply comes from the address they wrote to, and threads', async () => {
        const store = memoryStore();
        const mailer = recorder();

        await ack(store, mailer, { messageId: '<their-forward@example.com>' });

        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].from, 'P-Day Letters <post@pdayletters.com>');
        assert.equal(mailer.sent[0].headers['In-Reply-To'], '<their-forward@example.com>');
        assert.equal(mailer.sent[0].headers.References, '<their-forward@example.com>');
        // A reply to a receipt must reach a person, not the ingest pipeline.
        assert.equal(mailer.sent[0].headers['Reply-To'], 'hello@pdayletters.com');
        assert.equal(mailer.sent[0].headers['Auto-Submitted'], 'auto-replied');
    });

    test('no inbound message id means no threading headers at all', async () => {
        // Empty `In-Reply-To` is not the same as absent, and some clients
        // treat it as a malformed reference.
        const store = memoryStore();
        const mailer = recorder();

        await ack(store, mailer);

        assert.ok(!('In-Reply-To' in mailer.sent[0].headers));
        assert.ok(!('References' in mailer.sent[0].headers));
    });

    test('a hundred letters in one sitting is one thank you', async () => {
        const store = memoryStore();
        const mailer = recorder();

        for (let i = 0; i < 100; i++) await ack(store, mailer);

        assert.equal(mailer.sent.length, 1);
    });

    test('the same person is thanked again the next day', async () => {
        // The gate is a courtesy limit, not a one-per-lifetime rule. Somebody
        // who forwards weekly should hear back weekly.
        const store = memoryStore();
        const mailer = recorder();

        await ack(store, mailer);
        await ack(store, mailer, { now: () => new Date('2026-08-17T09:00:00Z') });

        assert.equal(mailer.sent.length, 2);
    });

    test('two people forwarding on the same day are both thanked', async () => {
        const store = memoryStore();
        const mailer = recorder();

        await ack(store, mailer, { to: 'aunt@example.com' });
        await ack(store, mailer, { to: 'uncle@example.com' });

        assert.equal(mailer.sent.length, 2);
    });

    test('the same person forwarding to two archives hears about both', async () => {
        const store = memoryStore();
        const mailer = recorder();

        await ack(store, mailer, { slug: 'elder.one' });
        await ack(store, mailer, { slug: 'elder.two' });

        assert.equal(mailer.sent.length, 2);
    });

    test('somebody who opted out is not thanked', async () => {
        const store = memoryStore();
        const mailer = recorder();
        await recordOptOut({
            tables: store,
            token: issueOptOut({ email: 'aunt@example.com', slug: SLUG, key: KEY, now: NOW }),
            key: KEY,
            now: NOW,
            log: quiet
        });

        const result = await ack(store, mailer);

        assert.equal(result.status, 'optedout');
        assert.equal(mailer.sent.length, 0);
    });

    test('a receipt that bounces is written down against the address', async () => {
        // The receipt is the first thing many of these addresses are ever sent,
        // so it is the first chance to learn that they do not work.
        const store = memoryStore();
        const mailer = recorder('bounced');

        await ack(store, mailer);

        const trouble = await deliveryTrouble({ tables: store, emails: ['aunt@example.com'], log: quiet });
        assert.equal(trouble.get('aunt@example.com').status, 'bounced');
    });

    test('without a mailer or a slug it simply does not happen', async () => {
        const store = memoryStore();
        assert.equal((await ack(store, null)).status, 'skipped');
        assert.equal((await ack(store, recorder(), { slug: '' })).status, 'skipped');
    });
});

describe('when ingest sends one', () => {
    test('a forward into an existing archive is acknowledged', async () => {
        const store = memoryStore();
        store.acl(SLUG, READER);
        const mailer = recorder();

        const result = await forward(store, mailer);

        assert.equal(result.status, 'stored');
        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].to, 'scott@kurtzeborn.org');
        assert.equal(mailer.sent[0].subject, 'Your letter arrived');
    });

    test('it threads onto the message we were actually sent', async () => {
        const store = memoryStore();
        store.acl(SLUG, READER);
        const mailer = recorder();

        const result = await forward(store, mailer);

        // The forwarder's own message, not the letter inside it. Replying to
        // the letter would thread the receipt into a conversation the
        // recipient may never have had.
        assert.equal(mailer.sent[0].headers['In-Reply-To'], result.post.receivedMessageId);
        assert.notEqual(result.post.receivedMessageId, result.post.originalMessageId);
    });

    test('the post records both message ids', async () => {
        const store = memoryStore();
        store.acl(SLUG, READER);

        const result = await forward(store, recorder());
        const post = store.json('rendered', `${SLUG}/posts.json`)[0];

        assert.ok(post.receivedMessageId, 'nothing could ever reply to this letter');
        assert.equal(post.receivedMessageId, result.post.receivedMessageId);
        assert.ok(post.originalMessageId);
    });

    test('a letter that deduped is still an arrival, and is still acknowledged', async () => {
        // The sender forwarded a letter and the letter is in the archive. That
        // somebody else got there first is a fact about our storage.
        const store = memoryStore();
        store.acl(SLUG, READER);
        const mailer = recorder();

        await forward(store, mailer, 'outlook-web-attached', '01FIRST000000000000000000');
        const again = await forward(store, mailer, 'outlook-web-attached', '01SECOND00000000000000000');

        assert.equal(again.status, 'duplicate');
        // Still one, because of the daily gate -- which is the same forwarder.
        assert.equal(mailer.sent.length, 1);
    });

    test("the missionary's own letter is not acknowledged", async () => {
        // Answering a direct send would be telling somebody what they just did.
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'owner@example.com', role: 'owner' }]);
        const mailer = recorder();

        const result = await forward(store, mailer, 'direct-missionary');

        assert.equal(result.status, 'stored');
        assert.equal(mailer.sent.length, 0);
    });

    test('a mailer that throws does not cost the letter', async () => {
        const store = memoryStore();
        store.acl(SLUG, READER);
        const broken = {
            send: async () => {
                throw new Error('the provider is down');
            }
        };

        const result = await forward(store, broken);

        assert.equal(result.status, 'stored');
        assert.equal(store.json('rendered', `${SLUG}/posts.json`).length, 1);
    });
});
