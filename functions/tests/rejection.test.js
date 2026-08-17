// Telling somebody on the list why their letter did not arrive.
//
// The pull here is the opposite of nudge.js. There, the risk is saying too
// much to a stranger; here, the risk is saying nothing to a family member and
// letting a letter vanish while they believe it worked. So these tests check
// both edges: that a member is told, and that a non-member still is not.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { runIngest } from '../src/lib/ingest.js';
import { rejectionEmail, explainRejection, isTold, TOLD } from '../src/lib/rejection.js';
import { TABLES } from '../src/lib/tables.js';
import { memoryStore } from './memory-store.js';

const config = {
    authservId: 'mx.cloudflare.net',
    missionaryDomains: ['missionary.org'],
    baseUrl: 'https://pdayletters.com'
};
const silent = { info() {}, warn() {}, error() {} };
const NOW = () => new Date('2026-08-03T12:00:00Z');

const recorder = () => {
    const mailer = { sent: [], send: async (m) => (mailer.sent.push(m), { status: 'sent' }) };
    return mailer;
};

// A DMARC-passing message from an ordinary family address with nothing
// forwarded inside it. Synthesized rather than taken from the corpus because
// every real capture carries a genuine letter -- which is the whole reason
// none of them reach these two rejection reasons.
const bare = (from = 'gran@example.com') =>
    [
        'Authentication-Results: mx.cloudflare.net;',
        '        dmarc=pass header.from=example.com policy.dmarc=none;',
        `From: Gran <${from}>`,
        'To: post@pdayletters.com',
        'Subject: Fwd: a letter',
        'Date: Mon, 3 Aug 2026 11:00:00 +0000',
        'Message-ID: <bare-1@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Sending this along.',
        ''
    ].join('\r\n');

const member = (store, email, slug = 'elder.example') =>
    store.upsertEntity(TABLES.memberships, { partitionKey: email, rowKey: slug, role: 'reader' });

describe('which rejections are answered at all', () => {
    test('only the two a member can actually cause', () => {
        assert.equal(isTold('no-recoverable-original'), true);
        assert.equal(isTold('author-not-missionary'), true);
    });

    test('a stranger forwarding junk is still met with silence', () => {
        // Answering this one would confirm which missionaries have archives,
        // to somebody who guessed.
        assert.equal(isTold('forwarder-not-on-acl'), false);
    });

    test('the bootstrap reasons stay with the nudge, which answers them better', () => {
        assert.equal(isTold('bootstrap-not-attached'), false);
        assert.equal(isTold('bootstrap-unverified'), false);
    });
});

describe('what the explanation says', () => {
    test('it names the address we actually found, or the reader cannot follow it', async () => {
        // Told only that the letter "was not from a missionary", somebody
        // looking at a letter that plainly is from one learns nothing.
        const body = rejectionEmail({
            reason: TOLD.notMissionary,
            author: 'aunt@example.com',
            baseUrl: 'https://pdayletters.com'
        });

        assert.match(body.text, /aunt@example\.com/);
        assert.match(body.html, /aunt@example\.com/);
    });

    test('it still makes sense when there was no address to name', async () => {
        const body = rejectionEmail({ reason: TOLD.notMissionary, baseUrl: 'https://x.test' });

        assert.doesNotMatch(body.text, /undefined|null/);
        assert.doesNotMatch(body.html, /undefined|null/);
    });

    test('both reasons promise that trying again is free', async () => {
        // The point of the whole message. Somebody just told they did
        // something wrong will not try again until they know what it costs.
        for (const reason of Object.values(TOLD)) {
            const body = rejectionEmail({ reason, baseUrl: 'https://x.test' });
            assert.match(body.text, /forward the same letter as many times/i, reason);
            assert.match(body.html, /forward the same letter as many times/i, reason);
        }
    });

    test('both parts say the same things', async () => {
        for (const reason of Object.values(TOLD)) {
            const body = rejectionEmail({ reason, author: 'a@b.test', baseUrl: 'https://x.test' });
            const stripped = body.html.replace(/<[^>]+>/g, ' ');
            for (const phrase of ['not added to the archive', 'Nothing was lost']) {
                assert.match(stripped, new RegExp(phrase, 'i'), `${reason}: ${phrase}`);
            }
        }
    });
});

describe('who gets told', () => {
    test('somebody on an ACL is told', async () => {
        const store = memoryStore();
        const mailer = recorder();
        await member(store, 'gran@example.com');

        const result = await explainRejection({
            tables: store,
            mailer,
            to: 'gran@example.com',
            reason: TOLD.noOriginal,
            baseUrl: 'https://pdayletters.com',
            now: NOW,
            log: silent
        });

        assert.equal(result.status, 'sent');
        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].from, 'Pday Letters <post@pdayletters.com>');
        assert.equal(mailer.sent[0].headers['Auto-Submitted'], 'auto-replied');
    });

    test('somebody on nobody\u2019s ACL is not', async () => {
        const store = memoryStore();
        const mailer = recorder();

        const result = await explainRejection({
            tables: store,
            mailer,
            to: 'stranger@example.com',
            reason: TOLD.noOriginal,
            now: NOW,
            log: silent
        });

        assert.equal(result.status, 'not-a-member');
        assert.equal(mailer.sent.length, 0);
    });

    test('the address is matched however it was capitalised', async () => {
        const store = memoryStore();
        const mailer = recorder();
        await member(store, 'gran@example.com');

        const result = await explainRejection({
            tables: store,
            mailer,
            to: 'Gran@Example.COM',
            reason: TOLD.noOriginal,
            now: NOW,
            log: silent
        });

        assert.equal(result.status, 'sent');
    });
});

describe('how often', () => {
    test('a backfill of twenty letters is one explanation, not twenty', async () => {
        const store = memoryStore();
        const mailer = recorder();
        await member(store, 'gran@example.com');

        for (let i = 0; i < 20; i++) {
            await explainRejection({
                tables: store,
                mailer,
                to: 'gran@example.com',
                reason: TOLD.noOriginal,
                now: NOW,
                log: silent
            });
        }

        assert.equal(mailer.sent.length, 1);
    });

    test('but a different problem is a different explanation', async () => {
        // Two causes need two answers. Collapsing them would mean the second
        // problem is never explained to somebody hitting both.
        const store = memoryStore();
        const mailer = recorder();
        await member(store, 'gran@example.com');

        const send = (reason) =>
            explainRejection({
                tables: store,
                mailer,
                to: 'gran@example.com',
                reason,
                now: NOW,
                log: silent
            });

        await send(TOLD.noOriginal);
        await send(TOLD.notMissionary);

        assert.equal(mailer.sent.length, 2);
    });

    test('and tomorrow is a new day, because the cause may be gone', async () => {
        const store = memoryStore();
        const mailer = recorder();
        await member(store, 'gran@example.com');

        const on = (day) =>
            explainRejection({
                tables: store,
                mailer,
                to: 'gran@example.com',
                reason: TOLD.noOriginal,
                now: () => new Date(day),
                log: silent
            });

        await on('2026-08-03T12:00:00Z');
        await on('2026-08-04T09:00:00Z');

        assert.equal(mailer.sent.length, 2);
    });
});

describe('end to end, through ingest', () => {
    // The extractor falls back to the outer message when nothing is embedded,
    // so a forward carrying no letter presents as one whose author is the
    // forwarder. That is the same shape as the case this reason exists for --
    // a forward of a forward, where the innermost letter is an aunt's rather
    // than the missionary's -- which is why it is the one exercised here.
    const run = (store, mailer, ulid = '01REJECT00000000000000000') => {
        store.seed(ulid, Buffer.from(bare(), 'utf8'), { from: 'gran@example.com' });
        return runIngest({
            ulid,
            store,
            tables: store,
            mailer,
            config,
            log: silent,
            now: NOW,
            verifyDkim: async () => ({ verified: false, reason: 'test', signatures: [] })
        });
    };

    test('a member whose forward carried no usable letter is told why', async () => {
        const store = memoryStore();
        const mailer = recorder();
        await member(store, 'gran@example.com');

        const result = await run(store, mailer);

        assert.equal(result.status, 'rejected');
        assert.equal(result.reason, 'author-not-missionary');
        assert.equal(mailer.sent.length, 1, 'the member was told nothing');
        assert.equal(mailer.sent[0].to, 'gran@example.com');
        // The address we found, so they can see what we read and why it was
        // the wrong one.
        assert.match(mailer.sent[0].text, /gran@example\.com/);
    });

    test('the same message from a stranger is still silent', async () => {
        const store = memoryStore();
        const mailer = recorder();

        const result = await run(store, mailer);

        assert.equal(result.reason, 'author-not-missionary');
        assert.equal(mailer.sent.length, 0);
    });

    test('the letter is still refused, and nothing is stored', async () => {
        const store = memoryStore();
        await member(store, 'gran@example.com');
        await run(store, recorder());

        assert.equal(
            [...store.blobs.keys()].some((k) => k.startsWith('raw/') || k.startsWith('pending/')),
            false,
            'a rejected message was stored anyway'
        );
    });
});
