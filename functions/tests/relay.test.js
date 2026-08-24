// The relay: asking a missionary to vouch for a family member.
//
// Two halves, and the second is the one that matters. The first is ordinary
// mail plumbing -- the right person is written to, once, and told who asked.
// The second is that the link inside that message is a live credential which
// travels through somebody else's mailbox on its way to its intended holder.
// It creates an archive and hands over ownership of it, so what is checked
// here is mostly what it refuses to do: work twice, work for a second person,
// work against an archive that already has an owner, or be minted at all by a
// caller naming their own beneficiary.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { issueClaimToken, PURPOSE } from '../src/lib/claimtoken.js';
import { describeClaim, redeemClaim } from '../src/lib/claim.js';
import {
    readRelay,
    relayEmail,
    requestRelay,
    RELAY_CLAIM,
    RELAY_TTL_DAYS
} from '../src/lib/relay.js';
import { memoryStore } from './memory-store.js';

const KEY = 'a-signing-key-for-tests';
const SLUG = 'elder.example';
const AUTHOR = 'elder.example@missionary.org';
const REQUESTER = 'parent@example.com';
const NOW = () => new Date('2026-03-01T12:00:00Z');
const LATER = () => new Date('2026-03-02T12:00:00Z');
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const recorder = () => {
    const sent = [];
    return { sent, send: async (message) => (sent.push(message), { status: 'sent' }) };
};

const relayToken = (overrides = {}) =>
    issueClaimToken({
        slug: SLUG,
        key: KEY,
        expiresAt: new Date(NOW().getTime() + RELAY_TTL_DAYS * 86400_000).toISOString(),
        purpose: PURPOSE.relay,
        subject: AUTHOR,
        recipient: REQUESTER,
        ...overrides
    }).token;

const ask = (store, mailer, overrides = {}) =>
    requestRelay({
        store,
        mailer,
        token: relayToken(),
        key: KEY,
        baseUrl: 'https://pdayletters.com',
        now: NOW,
        log: silent,
        ...overrides
    });

const grantOf = (store) => store.json('config', `${SLUG}/${RELAY_CLAIM}`);

// The link the missionary is asked to forward, pulled back out of the message
// we sent them -- rather than minted directly, so that a test of redemption is
// a test of the link a real recipient would actually be holding.
const linkFrom = (message) => message.text.match(/https:\/\/\S+\/claim#(\S+)/)[1];

// --- the link that triggers it ---------------------------------------------

describe('the link that asks', () => {
    test('a valid link names both parties', () => {
        const read = readRelay({ token: relayToken(), key: KEY, now: NOW });

        assert.equal(read.slug, SLUG);
        assert.equal(read.author, AUTHOR);
        assert.equal(read.requester, REQUESTER);
    });

    test('a claim link cannot be spent here', () => {
        // Purpose is inside the signature. Without the check, any token this
        // service has ever issued would double as a license to mail a
        // missionary.
        const token = issueClaimToken({
            slug: SLUG,
            key: KEY,
            expiresAt: '2027-01-01T00:00:00Z',
            purpose: PURPOSE.claim
        }).token;

        assert.equal(readRelay({ token, key: KEY, now: NOW }), null);
    });

    test('a relay link with no addresses in it is refused', () => {
        // Belt and braces: a token of the right purpose that names nobody
        // would otherwise reach the send with empty strings.
        const token = relayToken({ subject: '', recipient: '' });
        assert.equal(readRelay({ token, key: KEY, now: NOW }), null);
    });

    test('an invalid token sends nothing and records nothing', async () => {
        const store = memoryStore();
        const mailer = recorder();

        const result = await ask(store, mailer, { token: 'not-a-token' });

        assert.equal(result.status, 'invalid');
        assert.equal(mailer.sent.length, 0);
        assert.equal(grantOf(store), null);
    });
});

// --- what the missionary is sent -------------------------------------------

describe('the note to the missionary', () => {
    test('goes to the missionary, names who asked, and carries the link', async () => {
        const store = memoryStore();
        const mailer = recorder();

        const result = await ask(store, mailer);

        assert.equal(result.status, 'ok');
        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].to, AUTHOR);
        assert.match(mailer.sent[0].text, /parent@example\.com/);
        assert.match(mailer.sent[0].text, /https:\/\/pdayletters\.com\/claim#/);
    });

    test('says what forwarding the link does, and offers a way to refuse', async () => {
        // This is the one message in the system whose recipient is not the
        // beneficiary. "Pass this on" without "and here is what you are
        // handing over" is a favour nobody understood.
        const body = relayEmail({ requester: REQUESTER, link: 'https://x/claim#t', baseUrl: 'https://x' });

        assert.match(body.text, /sets up the archive and looks after it/);
        assert.match(body.text, /works once/);
        assert.match(body.text, /delete this message/);
        assert.doesNotMatch(body.subject, /elder\.example/);
    });

    test('nothing is asked of the missionary but the forward', async () => {
        // No attachment, no sign-in. Missionary accounts cannot sign in here
        // at all, and the whole point of sending a link rather than asking for
        // a letter is that forwarding text is the one thing every client does
        // correctly.
        const body = relayEmail({ requester: REQUESTER, link: 'https://x/claim#t', baseUrl: 'https://x' });

        assert.doesNotMatch(body.text, /attach/i);
        assert.doesNotMatch(body.text, /sign in to|sign in and/i);
    });

    test('both parts of the note say the same things', async () => {
        const body = relayEmail({ requester: REQUESTER, link: 'https://x/claim#t', baseUrl: 'https://x' });
        const stripped = body.html.replace(/<[^>]+>/g, ' ');

        for (const phrase of [
            REQUESTER,
            'forward this message to them',
            'works once',
            'delete this message'
        ]) {
            assert.ok(body.text.includes(phrase), `text: ${phrase}`);
            assert.ok(stripped.includes(phrase), `html: ${phrase}`);
        }
    });
});

// --- one grant at a time ---------------------------------------------------

describe('one outstanding grant per missionary', () => {
    test('pressing the button twice writes once and sends once', async () => {
        const store = memoryStore();
        const mailer = recorder();

        await ask(store, mailer);
        const before = grantOf(store);
        const second = await ask(store, mailer);

        // Reported as done, not as a duplicate: somebody pressing again is
        // somebody unsure the first press worked.
        assert.equal(second.status, 'ok');
        assert.equal(mailer.sent.length, 1);
        assert.equal(grantOf(store).claimTokenHash, before.claimTokenHash);
    });

    test('a second requester cannot take over an outstanding grant', async () => {
        // First writer wins, and it has to. The missionary was told a name and
        // asked to decide about it; rewriting the record afterwards would turn
        // "ask on my behalf" into "take the archive from whoever asked first".
        const store = memoryStore();
        const mailer = recorder();

        await ask(store, mailer);
        await ask(store, mailer, { token: relayToken({ recipient: 'someone.else@example.com' }) });

        assert.equal(mailer.sent.length, 1);
        assert.equal(grantOf(store).requester, REQUESTER);
    });

    test('a grant that expired unredeemed is replaced', async () => {
        // One message left unread must not lock a family out for good.
        const store = memoryStore();
        const mailer = recorder();
        const muchLater = () => new Date('2026-06-01T12:00:00Z');

        await ask(store, mailer);
        const first = grantOf(store).claimTokenHash;

        await ask(store, mailer, {
            now: muchLater,
            token: issueClaimToken({
                slug: SLUG,
                key: KEY,
                expiresAt: new Date(muchLater().getTime() + 86400_000).toISOString(),
                purpose: PURPOSE.relay,
                subject: AUTHOR,
                recipient: REQUESTER
            }).token
        });

        assert.equal(mailer.sent.length, 2);
        assert.notEqual(grantOf(store).claimTokenHash, first);
    });

    test('a grant that was used is not replaced', async () => {
        // The archive exists now. The way into an archive that exists is an
        // invitation from whoever owns it, not a second favour.
        const store = memoryStore();
        const mailer = recorder();

        await ask(store, mailer);
        await redeemClaim({
            store,
            tables: store,
            token: linkFrom(mailer.sent[0]),
            key: KEY,
            principal: REQUESTER,
            now: NOW,
            log: silent
        });

        const again = await ask(store, mailer, { now: LATER });

        assert.equal(again.status, 'ok', 'still says done, and still sends nothing');
        assert.equal(mailer.sent.length, 1);
    });
});

// --- redeeming the forwarded link ------------------------------------------

describe('the link the missionary forwards', () => {
    const asked = async () => {
        const store = memoryStore();
        const mailer = recorder();
        await ask(store, mailer);
        return { store, token: linkFrom(mailer.sent[0]) };
    };

    test('describes itself without any letters to point at', async () => {
        const { store, token } = await asked();

        const described = await describeClaim({ store, tables: store, token, key: KEY, now: NOW });

        assert.equal(described.status, 'ready');
        assert.equal(described.kind, 'relay');
        assert.equal(described.sender, AUTHOR);
        assert.equal(described.messageCount, 0);
        // The letter that started this was refused and never stored, so there
        // is nothing to summarise -- and nothing for a stray holder to read.
        assert.deepEqual(described.sampleSubjects, []);
    });

    test('makes the person who opens it an owner, but not the missionary', async () => {
        const { store, token } = await asked();

        const result = await redeemClaim({
            store,
            tables: store,
            token,
            key: KEY,
            principal: REQUESTER,
            displayName: 'Elder Example',
            now: NOW,
            log: silent
        });

        assert.equal(result.status, 'ok');

        const acl = store.json('config', `${SLUG}/acl.json`);
        assert.equal(acl.members.length, 1);
        assert.equal(acl.members[0].email, REQUESTER);
        assert.equal(acl.members[0].role, 'owner');
        // Following a forwarded link proves you were sent it. It does not
        // prove who you are, and the flag it would otherwise set confers
        // protection from removal.
        assert.equal(acl.members[0].verifiedMissionary, false);
    });

    test('works once', async () => {
        const { store, token } = await asked();
        const redeem = (principal) =>
            redeemClaim({ store, tables: store, token, key: KEY, principal, now: NOW, log: silent });

        assert.equal((await redeem(REQUESTER)).status, 'ok');

        const second = await redeem('opportunist@example.com');
        assert.equal(second.status, 'claimed');
        assert.equal(store.json('config', `${SLUG}/acl.json`).members.length, 1);
    });

    test('the same person may finish what they started', async () => {
        // A request that died between spending the grant and writing the ACL
        // must be resumable, or one closed tab strands somebody permanently.
        const { store, token } = await asked();
        const redeem = () =>
            redeemClaim({ store, tables: store, token, key: KEY, principal: REQUESTER, now: NOW, log: silent });

        await redeem();
        assert.equal((await redeem()).status, 'ok');
    });

    test('is refused against an archive that already has an owner', async () => {
        // Raced: somebody else got a verifiable forward through, or the
        // missionary claimed it themselves, while this link was in transit.
        const { store, token } = await asked();
        await store.writeBlob(
            'config',
            `${SLUG}/acl.json`,
            Buffer.from(JSON.stringify({ slug: SLUG, members: [{ email: 'someone@example.com', role: 'owner' }] }), 'utf8'),
            { contentType: 'application/json' }
        );

        const described = await describeClaim({ store, tables: store, token, key: KEY, now: NOW });
        assert.equal(described.status, 'owned');

        const result = await redeemClaim({
            store, tables: store, token, key: KEY, principal: REQUESTER, now: NOW, log: silent
        });
        assert.equal(result.status, 'owned');
    });

    test('the link that asked is not the link that grants', async () => {
        // Both are signed with the same key. Only the purpose and the stored
        // hash keep the one anybody can trigger from being the one that hands
        // over an archive.
        const store = memoryStore();
        const mailer = recorder();
        await ask(store, mailer);

        const described = await describeClaim({
            store,
            tables: store,
            token: relayToken(),
            key: KEY,
            now: NOW
        });

        assert.equal(described.status, 'invalid');
    });
});
