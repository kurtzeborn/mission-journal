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
import { readHeaderBlock, authenticateClaim, isClaimVerb, recipientVerbs, addressedToClaim } from '../src/lib/claimverb.js';
import { describeClaim, redeemClaim } from '../src/lib/claim.js';
import { membershipsFor } from '../src/lib/memberships.js';
import { setSiteName, sitesBySlug } from '../src/lib/sites.js';

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
        assert.deepEqual(recipientVerbs('post@pdayletters.com, claim@pdayletters.com'), ['post', 'claim']);
        assert.deepEqual(recipientVerbs(''), []);
    });
});

// --- the fan-out -----------------------------------------------------------
//
// Cloudflare Email Routing does not hand us one message with two recipients.
// It invokes the Worker once per matching rule, each with a single address in
// `envelope.to`. The original guard here asked `isClaimVerb(envelope.to)` and
// was tested by passing it a comma-separated list -- a shape the fake would
// accept and the real Worker has never produced. It could not fire on the copy
// that needed stopping, and did not: a live message `To: claim@, Cc: post@`
// was published to the sender's own archive with an ownership-granting access
// link quoted in the body.
describe('a message copied to both verbs', () => {
    // The same message, as the two deliveries Cloudflare actually makes: same
    // bytes, same headers, one envelope recipient each.
    const bothVerbs = () =>
        Buffer.from(
            [
                `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=missionary.org; spf=pass smtp.mailfrom=missionary.org; dmarc=pass header.from=missionary.org`,
                'Message-ID: <ask-both@missionary.org>',
                `From: Elder Example <${SLUG}@missionary.org>`,
                'To: claim@pdayletters.com',
                'Cc: post@pdayletters.com',
                'Subject: Re: Your Pday Letters access link',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'test',
                '',
                '> https://pdayletters.com/claim#a.token-that-must-never-be-published',
                ''
            ].join('\r\n'),
            'utf8'
        );

    const deliver = (store, mailer, envelopeTo, ulid) => {
        store.seed(ulid, bothVerbs(), { to: envelopeTo, from: `${SLUG}@missionary.org` });
        return runIngest({ ulid, store, mailer, config, log: silent, now: NOW, verifyDkim: offlineDkim });
    };

    test('publishes nothing from the post@ copy', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'parent@example.com', role: 'owner' }]);
        const mailer = fakeMailer();

        const result = await deliver(store, mailer, 'post@pdayletters.com', '01CLAIM000000000000000010');

        assert.equal(result.status, 'suppressed');
        assert.equal(
            [...store.blobs.keys()].some((k) => k.startsWith('raw/')),
            false,
            'an access link was published into the archive it grants ownership of'
        );
    });

    test('answers exactly once across both deliveries', async () => {
        // Both copies replying would be its own bug: the second link supersedes
        // the first, so the missionary would receive two mails of which the
        // older one is already dead.
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'parent@example.com', role: 'owner' }]);
        const mailer = fakeMailer();

        await deliver(store, mailer, 'claim@pdayletters.com', '01CLAIM000000000000000011');
        await deliver(store, mailer, 'post@pdayletters.com', '01CLAIM000000000000000012');

        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].to, `${SLUG}@missionary.org`);
    });

    test('reads the verb from the headers when the envelope has lost it', () => {
        const raw = bothVerbs();
        assert.equal(isClaimVerb('post@pdayletters.com'), false, 'the envelope alone cannot see it');
        assert.equal(addressedToClaim({ envelopeTo: 'post@pdayletters.com', raw }), true);
        assert.equal(addressedToClaim({ envelopeTo: 'claim@pdayletters.com', raw }), true);
    });

    test('leaves an ordinary letter alone', async () => {
        // The header check must not turn every message into a claim request.
        // A real letter to post@ has no claim@ anywhere in To or Cc.
        const store = memoryStore();
        store.seed('01TEST0000000000000000000', await raw('direct-missionary'));
        const result = await runIngest({
            ulid: '01TEST0000000000000000000',
            store,
            config: { ...config, acceptedIngestDomains: [] },
            log: silent,
            now: NOW,
            verifyDkim: offlineDkim
        });

        assert.notEqual(result.status, 'suppressed');
        assert.ok(store.json('pending', `${SLUG}/claim.json`), 'an ordinary letter was swallowed by the verb check');
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
        assert.equal(message.from, 'Pday Letters <claim@pdayletters.com>');
        assert.equal(message.headers['In-Reply-To'], '<ask-1@missionary.org>');

        const token = message.text.match(/#([\w.-]+)/)[1];
        const described = await describeClaim({ store, tables: store, token, key: KEY, now: NOW });
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
        assert.equal((await describeClaim({ store, tables: store, token: first, key: KEY, now: NOW })).status, 'superseded');
        assert.equal((await describeClaim({ store, tables: store, token: second, key: KEY, now: NOW })).status, 'ready');
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

// The claim page has one form and two jobs, and it cannot tell them apart on
// its own. Everything below is the difference between "set this archive up"
// and "let me into the archive my mother has been running since March" --
// which is a copy problem right up until the form asks for a name the site
// already has and quietly overwrites it.
describe('the description of a missionary grant', () => {
    const tokenFrom = (mailer) => mailer.sent[0].text.match(/#([\w.-]+)/)[1];

    test('says the archive already exists and what it is called', async () => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'parent@example.com', role: 'owner' }]);
        await setSiteName({ tables: store, slug: SLUG, missionaryDisplayName: 'Elder Example' });

        const { mailer } = await runClaim(store);
        const described = await describeClaim({
            store, tables: store, token: tokenFrom(mailer), key: KEY, now: NOW
        });

        assert.equal(described.alreadyOwned, true);
        // Without this the form asks a question the site answered months ago,
        // and any answer at all replaces what is already there.
        assert.equal(described.displayName, 'Elder Example');
    });

    test('says the archive does not exist yet when only letters are held', async () => {
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

        const { mailer } = await runClaim(store);
        const described = await describeClaim({
            store, tables: store, token: tokenFrom(mailer), key: KEY, now: NOW
        });

        assert.equal(described.alreadyOwned, false);
        assert.equal(described.displayName, '');
    });

    test('never names the site on the pending path', async () => {
        // The pending link goes to whoever a missionary happened to write to.
        // They are told a count and some subjects so they can recognise the
        // mail; the archive has no name yet and there is nothing to prefill.
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
        const described = await describeClaim({
            store, tables: store, token: issued.token, key: KEY, now: NOW
        });

        assert.equal(described.kind, 'pending');
        assert.equal(described.displayName, undefined);
        assert.equal(described.alreadyOwned, undefined);
    });
});

describe('the name a verified missionary submits', () => {
    const nameOf = async (store) =>
        (await sitesBySlug({ tables: store, slugs: [SLUG] })).get(SLUG).missionaryDisplayName;

    const liveSite = async (existingName) => {
        const store = memoryStore();
        store.acl(SLUG, [{ email: 'parent@example.com', role: 'owner' }]);
        if (existingName) {
            await setSiteName({ tables: store, slug: SLUG, missionaryDisplayName: existingName });
        }
        const { mailer } = await runClaim(store);
        return { store, token: mailer.sent[0].text.match(/#([\w.-]+)/)[1] };
    };

    const redeem = (store, token, displayName) =>
        redeemClaim({
            store, tables: store, token, key: KEY,
            principal: 'personal@gmail.com', displayName, now: NOW, log: silent
        });

    test('renames the archive when they change it', async () => {
        // The form shows them the current name, so an edit is a deliberate act
        // by the one person who has proved control of the mailbox the letters
        // come from. Refusing it would make the field a lie.
        const { store, token } = await liveSite('Elder Example');
        const result = await redeem(store, token, 'Elder Declan Example');

        assert.equal(result.status, 'ok');
        assert.equal(await nameOf(store), 'Elder Declan Example');
    });

    test('leaves it alone when they submit what they were shown', async () => {
        const { store, token } = await liveSite('Elder Example');
        await redeem(store, token, 'Elder Example');

        assert.equal(await nameOf(store), 'Elder Example');
    });

    test('does not blank a live archive from an emptied box', async () => {
        // Nothing on the page offers clearing as an action, so a blank arriving
        // here is far likelier to be a stray keystroke than an intention.
        const { store, token } = await liveSite('Elder Example');
        await redeem(store, token, '   ');

        assert.equal(await nameOf(store), 'Elder Example');
    });

    test('names the archive when the claim is what created it', async () => {
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

        const { mailer } = await runClaim(store);
        const result = await redeem(store, mailer.sent[0].text.match(/#([\w.-]+)/)[1], 'Elder Example');

        assert.equal(result.created, true, 'the page needs this to know which ending to show');
        assert.equal(await nameOf(store), 'Elder Example');
    });

    test('reports that it joined an archive it did not create', async () => {
        const { store, token } = await liveSite('Elder Example');
        const result = await redeem(store, token, 'Elder Example');

        assert.equal(result.created, false);
        assert.equal(result.promoted.promoted, 0, 'a live site has no backlog to publish');
    });
});
