// Making it stop, and proving it stopped.
//
// An invitation is the only message this service sends that its recipient did
// not ask for. Everything below is about the one promise that fact obliges:
// that a person who says no can make it so, without an account, without a
// reply from us, and without having to say it once per family.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { ROLE } from '../src/lib/acl.js';
import { inviteMember } from '../src/lib/invite.js';
import {
    issueOptOut,
    optedOut,
    optOutKey,
    readOptOut,
    recordOptOut,
    unsubscribeHeaders
} from '../src/lib/optout.js';
import { issueClaimToken, PURPOSE, verifyClaimToken } from '../src/lib/claimtoken.js';
import { TABLES } from '../src/lib/tables.js';

const KEY = 'a-signing-key-for-tests';
const BASE = 'https://pdayletters.com';
const SLUG = 'elder.example';
const OWNER = 'mum@example.com';
const THEM = 'grandma@example.com';
const NOW = () => new Date('2026-08-05T12:00:00Z');

const silent = { info() {}, warn() {}, error() {} };

const recorder = () => {
    const sent = [];
    return { sent, async send(message) { sent.push(message); return { status: 'sent' }; } };
};

async function site(members) {
    const store = memoryStore();
    await store.writeBlob(
        'config',
        `${SLUG}/acl.json`,
        Buffer.from(JSON.stringify({ slug: SLUG, members }), 'utf8'),
        { contentType: 'application/json' }
    );
    await store.upsertEntity(TABLES.sites, {
        partitionKey: 'site',
        rowKey: SLUG,
        missionaryDisplayName: 'Elder Example'
    });
    return store;
}

const member = (email, role) => ({ email, role, addedAt: NOW().toISOString() });

describe('a link that makes the mail stop', () => {
    test('names the address inside the signature, not in the request', async () => {
        // The whole reason it is signed. An endpoint that took the address
        // from the form would be a way to stop a grandmother ever receiving
        // the invitation her family is about to send her.
        const token = issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW });
        assert.deepEqual(readOptOut({ token, key: KEY, now: NOW }), { email: THEM, slug: SLUG });
    });

    test('a token edited to name somebody else is refused arithmetically', async () => {
        const token = issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW });
        const [payload, signature] = token.split('.');
        const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        forged.s = 'someone.else@example.com';
        const tampered = `${Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url')}.${signature}`;

        assert.equal(readOptOut({ token: tampered, key: KEY, now: NOW }), null);
    });

    test('an invitation link cannot be spent as an opt-out', async () => {
        // The signed purpose, doing the job it was added for. Otherwise the
        // separation between kinds of link would rest on which table their
        // hash happens to be looked up in.
        const invite = issueClaimToken({
            slug: SLUG, key: KEY, expiresAt: '2026-09-01T00:00:00Z', purpose: PURPOSE.invite
        }).token;

        assert.equal(readOptOut({ token: invite, key: KEY, now: NOW }), null);
    });

    test('an opt-out link cannot be spent as an invitation', async () => {
        const token = issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW });
        const asInvite = verifyClaimToken({ token, key: KEY, purpose: PURPOSE.invite, now: NOW });

        assert.equal(asInvite.valid, false);
        assert.equal(asInvite.reason, 'wrong-purpose');
    });

    test('it still works years later, because that is when people find it', async () => {
        // The usual argument for a short life is inverted here: an expired
        // opt-out is a promise withdrawn.
        const token = issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW });
        const muchLater = () => new Date('2034-08-05T12:00:00Z');

        assert.equal(readOptOut({ token, key: KEY, now: muchLater })?.email, THEM);
    });

    test('pressing it twice is not an error', async () => {
        const store = memoryStore();
        const token = issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW });

        assert.equal((await recordOptOut({ tables: store, token, key: KEY, now: NOW, log: silent })).status, 'ok');
        assert.equal((await recordOptOut({ tables: store, token, key: KEY, now: NOW, log: silent })).status, 'ok');
        assert.equal(await optedOut({ tables: store, email: THEM }), true);
    });

    test('an address with characters a row key forbids is still recordable', async () => {
        // Real addresses may contain `/`, `#` and `?`, none of which a table
        // row key admits. The hash is not for secrecy; it is what makes the
        // key legal at all.
        const awkward = 'a/b#c?d@example.com';
        const store = memoryStore();
        const token = issueOptOut({ email: awkward, slug: SLUG, key: KEY, now: NOW });

        await recordOptOut({ tables: store, token, key: KEY, now: NOW, log: silent });

        assert.equal(await optedOut({ tables: store, email: awkward }), true);
        assert.match(optOutKey(awkward), /^[0-9a-f]{64}$/);
    });

    test('case and stray spacing do not create a second person', async () => {
        const store = memoryStore();
        const token = issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW });
        await recordOptOut({ tables: store, token, key: KEY, now: NOW, log: silent });

        assert.equal(await optedOut({ tables: store, email: '  GRANDMA@Example.COM ' }), true);
    });

    test('somebody who never opted out is not suppressed', async () => {
        const store = memoryStore();
        assert.equal(await optedOut({ tables: store, email: THEM }), false);
        assert.equal(await optedOut({ tables: store, email: '' }), false);
    });
});

describe('an owner cannot overrule it', () => {
    test('the invitation is refused and no mail leaves', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();
        await recordOptOut({
            tables: store,
            token: issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW }),
            key: KEY, now: NOW, log: silent
        });

        const result = await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.equal(result.error, 'has asked us not to email them');
        assert.equal(mailer.sent.length, 0);
    });

    test('the owner is told, rather than left chasing a message that never went', async () => {
        // Silently pretending to send is the tempting alternative, and it is
        // worse: the owner tries again tomorrow, and a fortnight later asks
        // why grandmother never replied.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();
        await recordOptOut({
            tables: store,
            token: issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW }),
            key: KEY, now: NOW, log: silent
        });

        const result = await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.equal(result.ok, undefined);
        assert.match(result.error, /asked us not to email/);
    });

    test('it holds across archives, not just the one that caused it', async () => {
        // Saying "stop emailing me" is not saying "stop emailing me about
        // Elder Example". A per-archive opt-out would be a way of honouring
        // the request technically while defeating it.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();
        await recordOptOut({
            tables: store,
            token: issueOptOut({ email: THEM, slug: 'some.other.missionary', key: KEY, now: NOW }),
            key: KEY, now: NOW, log: silent
        });

        const result = await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.match(result.error, /asked us not to email/);
    });

    test('a refusal costs nobody a slot of the daily allowance', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();
        await recordOptOut({
            tables: store,
            token: issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW }),
            key: KEY, now: NOW, log: silent
        });

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        const rows = await store.listEntities(TABLES.invites, { partitionKey: SLUG });
        assert.equal(rows.length, 0);
    });
});

describe('every invitation carries the way out', () => {
    test('a visible link, in both the text and the HTML', async () => {
        // Not left to the mail client's Unsubscribe button, which not every
        // client shows and which grandparents do not look for.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        const [message] = mailer.sent;
        assert.match(message.text, /\/optout#\S+/);
        assert.match(message.html, /href="https:\/\/pdayletters\.com\/optout#/);
    });

    test('and the headers a provider acts on without a human', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        const headers = mailer.sent[0].headers;
        assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
        assert.match(headers['List-Unsubscribe'], /^<mailto:hello@pdayletters\.com\?subject=unsubscribe>, </);
        assert.match(headers['List-Unsubscribe'], /<https:\/\/pdayletters\.com\/api\/optout\?t=[^>]+>$/);
    });

    test('the link in the mail actually stops that address', async () => {
        // The end-to-end assertion, and the only one that proves the token in
        // the message is the token the endpoint will accept.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        const token = mailer.sent[0].text.match(/\/optout#(\S+)/)[1];
        await recordOptOut({ tables: store, token, key: KEY, now: NOW, log: silent });

        assert.equal(await optedOut({ tables: store, email: THEM }), true);

        const again = await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        assert.match(again.error, /asked us not to email/);
        assert.equal(mailer.sent.length, 1);
    });

    test('the header token is the same one, so both routes agree', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        const inBody = mailer.sent[0].text.match(/\/optout#(\S+)/)[1];
        const inHeader = decodeURIComponent(
            mailer.sent[0].headers['List-Unsubscribe'].match(/api\/optout\?t=([^>]+)>/)[1]
        );
        assert.equal(inHeader, inBody);
    });

    test('the opt-out token is not the invitation token', async () => {
        // They travel in the same message. If they were the same string, a
        // provider's one-click unsubscribe would spend the invitation.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        const invite = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];
        const out = mailer.sent[0].text.match(/\/optout#(\S+)/)[1];
        assert.notEqual(invite, out);
    });

    test('the headers name a mailbox as well as a URL', async () => {
        // The two fail differently: the URL is what a provider posts to, and
        // the mailbox is what still works when we are down.
        const headers = unsubscribeHeaders({
            baseUrl: 'https://pdayletters.com/',
            token: 'abc',
            humanAddress: 'hello@pdayletters.com'
        });

        assert.match(headers['List-Unsubscribe'], /mailto:/);
        assert.match(headers['List-Unsubscribe'], /https:/);
        // The trailing slash on baseUrl must not produce a double slash.
        assert.doesNotMatch(headers['List-Unsubscribe'], /com\/\/api/);
    });
});
