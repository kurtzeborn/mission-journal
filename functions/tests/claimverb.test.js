// The `claim@` verb.
//
// Two things are being tested here, and only one of them is a feature.
//
// The feature is the reply: a missionary who emails `claim@` from their own
// address gets a link that makes them a `verifiedMissionary` owner, whether the
// site is waiting in `pending/` or has been live under a parent for months.
//
// The other is a refusal, and it is the reason this file exists at all.
// `ingest` checks the recipient *domain* and never looked at the local-part, so
// once `claim@` was routed to the same Worker, a missionary asking for control
// of their site had that message classified `direct` and published to their own
// archive. The first test below is the one that must never go green for the
// wrong reason.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIngest } from '../src/lib/ingest.js';
import { verifyEmbeddedDkim } from '../src/lib/dkim.js';
import { memoryStore } from './memory-store.js';
import { readHeaderBlock, authenticateClaim, isClaimVerb, recipientVerbs } from '../src/lib/claimverb.js';
import { describeClaim, redeemClaim } from '../src/lib/claim.js';
import { membershipsFor } from '../src/lib/memberships.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const KEY = 'a-signing-key-from-key-vault';
const SLUG = 'elder.example';
const NOW = () => new Date('2026-08-03T12:00:00Z');
const silent = { info() {}, warn() {}, error() {} };

const config = {
    authservId: 'mx.cloudflare.net',
    missionaryDomains: ['missionary.org'],
    acceptedIngestDomains: ['pdayletters.com'],
    claimTokenKey: KEY,
    baseUrl: 'https://pdayletters.com'
};

const noNetwork = async (name) => {
    throw new Error(`unit tests must not resolve DNS (asked for ${name})`);
};
const offlineDkim = (extracted) => verifyEmbeddedDkim(extracted, { resolver: noNetwork });

// Records what was sent without sending it. `status: 'sent'` because every
// caller branches on it and a fake that always failed would exercise only the
// error paths.
function fakeMailer() {
    const sent = [];
    return {
        sent,
        send: async (message) => {
            sent.push(message);
            return { status: 'sent' };
        }
    };
}

// The claim@ message. A real one is a missionary typing three words into their
// phone, so it is built rather than captured: what matters is the header block,
// and specifically the Authentication-Results our own provider stamps.
function claimMessage({
    from = `${SLUG}@missionary.org`,
    dmarcFrom = null,
    dmarc = 'pass',
    authserv = 'mx.cloudflare.net',
    messageId = '<ask-1@missionary.org>',
    body = 'Can I have access to my letters?'
} = {}) {
    const evaluated = dmarcFrom ?? from.slice(from.lastIndexOf('@') + 1);
    return Buffer.from(
        [
            `Authentication-Results: ${authserv}; dkim=pass header.d=missionary.org; spf=pass smtp.mailfrom=missionary.org; dmarc=${dmarc} header.from=${evaluated}`,
            `Message-ID: ${messageId}`,
            `From: Elder Example <${from}>`,
            'To: claim@pdayletters.com',
            'Subject: claim',
            'Content-Type: text/plain; charset=utf-8',
            '',
            body,
            ''
        ].join('\r\n'),
        'utf8'
    );
}

const toClaim = { to: 'claim@pdayletters.com', from: `${SLUG}@missionary.org` };

async function runClaim(store, { mailer = fakeMailer(), message = claimMessage(), ulid = '01CLAIM000000000000000000' } = {}) {
    store.seed(ulid, message, toClaim);
    const result = await runIngest({
        ulid,
        store,
        mailer,
        config,
        log: silent,
        now: NOW,
        verifyDkim: offlineDkim
    });
    return { result, mailer };
}

// --- the exposure ----------------------------------------------------------

describe('mail addressed to claim@', () => {
    test('is never parsed, classified, or published', async () => {
        const store = memoryStore();

        // A real letter, with real attachments, sent to the wrong verb. If the
        // verb is not read this is a textbook `direct` publish.
        const { result } = await runClaim(store, { message: await raw('direct-missionary') });

        assert.notEqual(result.status, 'published');
        assert.equal(
            [...store.blobs.keys()].some((k) => k.startsWith('raw/')),
            false,
            'a message to claim@ reached the publish path'
        );
        assert.equal(
            [...store.blobs.keys()].some((k) => k.startsWith('pending/')),
            false,
            'a message to claim@ created a pending site'
        );
    });

    test('the verb is read from the recipient, not the sender', () => {
        assert.equal(isClaimVerb('claim@pdayletters.com'), true);
        assert.equal(isClaimVerb('post@pdayletters.com'), false);
        assert.equal(isClaimVerb('CLAIM@PDayLetters.com'), true);
        // Both verbs on one envelope takes the path that publishes nothing.
        assert.equal(isClaimVerb('post@pdayletters.com, claim@pdayletters.com'), true);
        assert.deepEqual(recipientVerbs('post@pdayletters.com, claim@pdayletters.com'), ['post', 'claim']);
        assert.deepEqual(recipientVerbs(''), []);
    });
});

// --- who is ignored --------------------------------------------------------

describe('claim@ ignores', () => {
    const cases = [
        ['a sender on any other domain', { from: 'stranger@example.com' }, 'not-a-missionary-domain'],
        ['a DMARC failure', { dmarc: 'fail' }, 'dmarc-fail'],
        ['a forged From: that DMARC evaluated elsewhere', { dmarcFrom: 'example.com' }, 'dmarc-misaligned'],
        ['a header stamped by someone who is not our provider', { authserv: 'mx.google.com' }, 'no-auth-results']
    ];

    for (const [name, overrides, reason] of cases) {
        test(`${name}, without replying`, async () => {
            const store = memoryStore();
            store.acl(SLUG, [{ email: 'parent@example.com', role: 'owner' }]);
            const { result, mailer } = await runClaim(store, { message: claimMessage(overrides) });

            assert.equal(result.status, 'ignored');
            assert.equal(result.reason, reason);
            assert.equal(mailer.sent.length, 0, 'a refusal told the sender something');
        });
    }

    test('a missionary with no site at all', async () => {
        const store = memoryStore();
        const { result, mailer } = await runClaim(store);

        assert.equal(result.status, 'no-site');
        assert.equal(mailer.sent.length, 0);
        // Nothing was created for a slug that does not exist.
        assert.equal([...store.blobs.keys()].some((k) => k.startsWith('config/')), false);
    });

    test('a forged domain check cannot be reached before DMARC', async () => {
        // `From:` says missionary.org, but DMARC evaluated a different domain.
        // This must fail as a DMARC failure -- the domain allowlist must never
        // be consulted for an unauthenticated header.
        const headers = readHeaderBlock(claimMessage({ dmarcFrom: 'example.com' }));
        const auth = authenticateClaim({ headers, config });
        assert.equal(auth.ok, false);
        assert.equal(auth.reason, 'dmarc-misaligned');
    });
});

// --- the header-only reader ------------------------------------------------

describe('the header block reader', () => {
    test('stops at the blank line and never sees the body', () => {
        const headers = readHeaderBlock(claimMessage({ body: 'X-Not-A-Header: forged' }));
        assert.equal(headers.some((h) => h.key === 'x-not-a-header'), false);
    });

    test('unfolds continuations', () => {
        const message = Buffer.from(
            ['Subject: one', '  two', '\tthree', 'From: a@b.com', '', 'body'].join('\r\n'),
            'utf8'
        );
        const headers = readHeaderBlock(message);
        assert.equal(headers.find((h) => h.key === 'subject').value, 'one two three');
        assert.equal(headers.length, 2);
    });

    test('agrees with the MIME parser about Authentication-Results', async () => {
        // The whole safety argument is that this reader can replace the parser
        // for the one header the decision rests on. If the two disagree, the
        // claim path is deciding from something the rest of the system does not
        // recognise.
        const { extractOriginal } = await import('../src/lib/extract.js');
        const bytes = await raw('direct-missionary');
        const parsed = (await extractOriginal(bytes)).headers.filter(
            (h) => h.key === 'authentication-results'
        );
        const cheap = readHeaderBlock(bytes).filter((h) => h.key === 'authentication-results');

        assert.deepEqual(cheap.map((h) => h.value), parsed.map((h) => h.value));
    });
});

// --- the grant -------------------------------------------------------------

describe('a verified missionary', () => {
    test('is added alongside an existing owner, never in place of them', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'parent@example.com', role: 'owner', addedAt: '2026-01-01T00:00:00Z' }]);

        const { result, mailer } = await runClaim(store);
        assert.equal(result.status, 'sent');
        assert.equal(mailer.sent.length, 1);

        const message = mailer.sent[0];
        assert.equal(message.to, `${SLUG}@missionary.org`);
        // From the address they wrote to, threading onto the message they sent:
        // both are the prior-correspondence argument, not decoration.
        assert.equal(message.from, 'claim@pdayletters.com');
        assert.equal(message.headers['In-Reply-To'], '<ask-1@missionary.org>');

        const token = message.text.match(/#([\w.-]+)/)[1];
        const described = await describeClaim({ store, token, key: KEY, now: NOW });
        assert.equal(described.status, 'ready');
        assert.equal(described.kind, 'missionary');

        const redeemed = await redeemClaim({
            store,
            tables: store,
            token,
            key: KEY,
            principal: 'personal@gmail.com',
            now: NOW,
            log: silent
        });
        assert.equal(redeemed.status, 'ok');

        const members = store.json('config', `${SLUG}/acl.json`).members;
        assert.equal(members.length, 2);
        assert.ok(members.find((m) => m.email === 'parent@example.com'), 'the existing owner was removed');
        const missionary = members.find((m) => m.email === 'personal@gmail.com');
        assert.equal(missionary.role, 'owner');
        assert.equal(missionary.verifiedMissionary, true);
    });

    test('upgrades an entry they already had without resetting it', async () => {
        const store = memoryStore();
        store.acl(SLUG, [
            { email: 'parent@example.com', role: 'owner' },
            { email: 'personal@gmail.com', role: 'reader', addedAt: '2026-01-01T00:00:00Z' }
        ]);

        const { mailer } = await runClaim(store);
        const token = mailer.sent[0].text.match(/#([\w.-]+)/)[1];
        await redeemClaim({
            store,
            tables: store,
            token,
            key: KEY,
            principal: 'personal@gmail.com',
            now: NOW,
            log: silent
        });

        const members = store.json('config', `${SLUG}/acl.json`).members;
        assert.equal(members.length, 2);
        const mine = members.find((m) => m.email === 'personal@gmail.com');
        assert.equal(mine.role, 'owner');
        assert.equal(mine.verifiedMissionary, true);
        assert.equal(mine.addedAt, '2026-01-01T00:00:00Z', 'membership was restarted');
    });

    test('is indexed so the site is reachable after signing in', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'parent@example.com', role: 'owner' }]);
        const { mailer } = await runClaim(store);
        const token = mailer.sent[0].text.match(/#([\w.-]+)/)[1];

        await redeemClaim({
            store,
            tables: store,
            token,
            key: KEY,
            principal: 'personal@gmail.com',
            now: NOW,
            log: silent
        });

        const mine = await membershipsFor({ tables: store, email: 'personal@gmail.com' });
        assert.deepEqual(mine.map((m) => m.slug), [SLUG]);
    });

    test('re-asking invalidates the previous link', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'parent@example.com', role: 'owner' }]);

        const { mailer } = await runClaim(store, { ulid: '01CLAIM000000000000000001' });
        const first = mailer.sent[0].text.match(/#([\w.-]+)/)[1];

        await runClaim(store, { mailer, ulid: '01CLAIM000000000000000002' });
        const second = mailer.sent[1].text.match(/#([\w.-]+)/)[1];

        assert.notEqual(first, second);
        assert.equal((await describeClaim({ store, token: first, key: KEY, now: NOW })).status, 'superseded');
        assert.equal((await describeClaim({ store, token: second, key: KEY, now: NOW })).status, 'ready');
    });

    test('cannot be granted by a link that was merely forwarded', async () => {
        // The pending path is the one anyone can reach by following a link out
        // of a mailbox, and it must never set the flag. This is the boundary the
        // whole two-record split exists to keep.
        const store = memoryStore();
        store.seed('01TEST0000000000000000000', await raw('direct-missionary'));
        await runIngest({
            ulid: '01TEST0000000000000000000',
            store,
            config: { ...config, acceptedIngestDomains: [] },
            log: silent,
            now: NOW,
            verifyDkim: offlineDkim
        });

        const { attachClaimToken } = await import('../src/lib/claim.js');
        const issued = await attachClaimToken({ store, slug: SLUG, key: KEY, now: NOW });
        const redeemed = await redeemClaim({
            store,
            tables: store,
            token: issued.token,
            key: KEY,
            principal: 'whoever@example.com',
            now: NOW,
            log: silent
        });

        assert.equal(redeemed.status, 'ok');
        const members = store.json('config', `${SLUG}/acl.json`).members;
        assert.equal(members[0].verifiedMissionary, false);
    });

    test('claiming a pending site publishes the backlog', async () => {
        const store = memoryStore();
        store.seed('01TEST0000000000000000000', await raw('direct-missionary'));
        await runIngest({
            ulid: '01TEST0000000000000000000',
            store,
            config: { ...config, acceptedIngestDomains: [] },
            log: silent,
            now: NOW,
            verifyDkim: offlineDkim
        });
        assert.ok(store.json('pending', `${SLUG}/claim.json`), 'expected a pending site');

        const { mailer } = await runClaim(store);
        const token = mailer.sent[0].text.match(/#([\w.-]+)/)[1];

        const redeemed = await redeemClaim({
            store,
            tables: store,
            token,
            key: KEY,
            principal: 'personal@gmail.com',
            now: NOW,
            log: silent
        });

        assert.equal(redeemed.status, 'ok');
        assert.equal(redeemed.promoted.promoted, 1);
        const members = store.json('config', `${SLUG}/acl.json`).members;
        assert.equal(members[0].verifiedMissionary, true);
    });
});
