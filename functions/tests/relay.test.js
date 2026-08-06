// The relay: asking a missionary to send the first letter.
//
// Two things are being checked here, and only one of them is about mail.
//
// The obvious one is that the right person gets the right message once. The
// other is the redirect on the ingest side: a letter a missionary sent because
// we asked them to must hand the archive to the family member who asked, not
// to the missionary who was doing them a favour. That is a credential changing
// destination on the strength of a table row, so the row is fenced -- signed
// intent, first writer wins, and an expiry checked on read.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { issueClaimToken, PURPOSE } from '../src/lib/claimtoken.js';
import { runIngest } from '../src/lib/ingest.js';
import { readRelay, relayEmail, relayRequestFor, requestRelay, RELAY_TTL_DAYS } from '../src/lib/relay.js';
import { TABLES } from '../src/lib/tables.js';
import { memoryStore } from './memory-store.js';

const KEY = 'a-signing-key-for-tests';
const AUTHOR = 'elder.example@missionary.org';
const REQUESTER = 'parent@example.com';
const NOW = () => new Date('2026-03-01T12:00:00Z');
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const recorder = () => {
    const sent = [];
    return { sent, send: async (message) => (sent.push(message), { status: 'sent' }) };
};

const relayToken = (overrides = {}) =>
    issueClaimToken({
        slug: 'elder.example',
        key: KEY,
        expiresAt: new Date(NOW().getTime() + RELAY_TTL_DAYS * 86400_000).toISOString(),
        purpose: PURPOSE.relay,
        subject: AUTHOR,
        recipient: REQUESTER,
        ...overrides
    }).token;

describe('asking a missionary for the first letter', () => {
    test('a valid link names both parties', () => {
        const read = readRelay({ token: relayToken(), key: KEY, now: NOW });

        assert.equal(read.slug, 'elder.example');
        assert.equal(read.author, AUTHOR);
        assert.equal(read.requester, REQUESTER);
    });

    test('a claim link cannot be spent here', () => {
        // Purpose is inside the signature. Without the check, any token this
        // service has ever issued would double as a licence to mail a
        // missionary.
        const token = issueClaimToken({
            slug: 'elder.example',
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

    test('the note goes to the missionary and names who asked', async () => {
        const tables = memoryStore();
        const mailer = recorder();

        const result = await requestRelay({
            tables,
            mailer,
            token: relayToken(),
            key: KEY,
            baseUrl: 'https://pdayletters.com',
            now: NOW,
            log: silent
        });

        assert.equal(result.status, 'ok');
        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].to, AUTHOR);
        assert.match(mailer.sent[0].text, /parent@example\.com/);
        assert.match(mailer.sent[0].text, /post@pdayletters\.com/);
    });

    test('the note asks for one forward and offers nothing to click', async () => {
        // A missionary has a set number of minutes to write home. Every link
        // in this is a decision they would have to make, and there is only one
        // thing to do.
        const body = relayEmail({ requester: REQUESTER, baseUrl: 'https://pdayletters.com' });

        assert.doesNotMatch(body.text, /\/claim#|\/ask#|\/invite#/);
        assert.match(body.text, /ignore this message/);
        assert.doesNotMatch(body.subject, /elder\.example/);
    });

    test('both parts of the note say the same things', async () => {
        const body = relayEmail({ requester: REQUESTER, baseUrl: 'https://pdayletters.com' });
        const stripped = body.html.replace(/<[^>]+>/g, ' ');

        for (const phrase of [
            'post@pdayletters.com',
            'in one step',
            'ignore this message'
        ]) {
            assert.ok(body.text.includes(phrase), `text: ${phrase}`);
            assert.ok(stripped.includes(phrase), `html: ${phrase}`);
        }
    });

    test('pressing the button twice writes once', async () => {
        const tables = memoryStore();
        const mailer = recorder();
        const send = () =>
            requestRelay({
                tables,
                mailer,
                token: relayToken(),
                key: KEY,
                baseUrl: 'https://pdayletters.com',
                now: NOW,
                log: silent
            });

        await send();
        const second = await send();

        // Reported as done, not as a duplicate: somebody pressing again is
        // somebody unsure the first press worked.
        assert.equal(second.status, 'ok');
        assert.equal(mailer.sent.length, 1);
    });

    test('a second requester cannot take over an outstanding request', async () => {
        // First writer wins, and it has to: the row decides where a claim link
        // is sent, so last-writer-wins would turn "ask on my behalf" into
        // "take the archive from whoever asked first".
        const tables = memoryStore();
        const mailer = recorder();
        const common = { tables, mailer, key: KEY, baseUrl: '', now: NOW, log: silent };

        await requestRelay({ ...common, token: relayToken() });
        await requestRelay({ ...common, token: relayToken({ recipient: 'someone.else@example.com' }) });

        const row = await relayRequestFor({ tables, slug: 'elder.example', now: NOW });
        assert.equal(row.requester, REQUESTER);
    });

    test('an expired request is not read, even though the row is still there', async () => {
        // Checked on read rather than swept by a timer. A stale row must not
        // redirect a credential because a cleanup did not run.
        const tables = memoryStore();
        await tables.insertEntity(TABLES.relays, {
            partitionKey: 'elder.example',
            rowKey: 'request',
            requester: REQUESTER,
            requestedAt: '2026-01-01T00:00:00Z',
            expiresAt: '2026-02-01T00:00:00Z'
        });

        assert.equal(await relayRequestFor({ tables, slug: 'elder.example', now: NOW }), null);
    });

    test('no request means no row and no answer', async () => {
        const tables = memoryStore();
        assert.equal(await relayRequestFor({ tables, slug: 'elder.example', now: NOW }), null);
    });

    test('an invalid token sends nothing and records nothing', async () => {
        const tables = memoryStore();
        const mailer = recorder();

        const result = await requestRelay({
            tables,
            mailer,
            token: 'not-a-token',
            key: KEY,
            now: NOW,
            log: silent
        });

        assert.equal(result.status, 'invalid');
        assert.equal(mailer.sent.length, 0);
        assert.equal(await relayRequestFor({ tables, slug: 'elder.example', now: NOW }), null);
    });
});

// --- the other half: what ingest does with the row --------------------------

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');

describe('the letter that answers the request', () => {
    const config = {
        authservId: 'mx.cloudflare.net',
        missionaryDomains: ['missionary.org'],
        claimTokenKey: KEY,
        baseUrl: 'https://pdayletters.com'
    };

    const ingestDirect = async (store, mailer) => {
        const raw = await readFile(join(fixtures, 'direct-missionary.eml'));
        store.seed('01TEST', raw, { from: AUTHOR, to: 'post@pdayletters.com' });
        return runIngest({
            ulid: '01TEST',
            store,
            tables: store,
            mailer,
            config,
            now: NOW,
            log: silent,
            verifyDkim: async () => ({ verified: false, coverage: null, reason: 'n/a', signatures: [] })
        });
    };

    test('a direct send with no request is still offered to the missionary', async () => {
        const store = memoryStore();
        const mailer = recorder();
        await ingestDirect(store, mailer);

        const claim = mailer.sent.at(-1);
        assert.ok(claim, 'no claim was offered');
        assert.equal(claim.to, AUTHOR);
    });

    test('a direct send answering a request is offered to the family member', async () => {
        const store = memoryStore();
        const mailer = recorder();
        await store.insertEntity(TABLES.relays, {
            partitionKey: 'elder.example',
            rowKey: 'request',
            requester: REQUESTER,
            requestedAt: '2026-03-01T00:00:00Z',
            expiresAt: '2026-04-01T00:00:00Z'
        });

        await ingestDirect(store, mailer);

        const claim = mailer.sent.at(-1);
        assert.ok(claim, 'no claim was offered');
        assert.equal(claim.to, REQUESTER);
    });

    test('an expired request does not redirect the claim', async () => {
        const store = memoryStore();
        const mailer = recorder();
        await store.insertEntity(TABLES.relays, {
            partitionKey: 'elder.example',
            rowKey: 'request',
            requester: REQUESTER,
            requestedAt: '2026-01-01T00:00:00Z',
            expiresAt: '2026-02-01T00:00:00Z'
        });

        await ingestDirect(store, mailer);

        assert.equal(mailer.sent.at(-1).to, AUTHOR);
    });
});
