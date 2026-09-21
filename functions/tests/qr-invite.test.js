// In-person QR invitations: short-lived display credentials, longer sign-in
// tickets, and reader-only membership at the end.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { ROLE, resolveRole } from '../src/lib/acl.js';
import {
    acceptQrInvite,
    closeQrInvite,
    exchangeQrInvite,
    QR_SESSION_MAX_JOINS,
    rotateQrInvite,
    startQrInvite
} from '../src/lib/qrinvite.js';
import { recordMembership } from '../src/lib/memberships.js';
import { claimTokenHash } from '../src/lib/claimtoken.js';
import { TABLES } from '../src/lib/tables.js';

const KEY = 'a-signing-key-from-key-vault';
const SLUG = 'elder.example';
const OWNER = 'parent@example.com';
const READER = 'grandma@example.com';
const BASE = 'https://pdayletters.com';
const silent = { info() {}, warn() {}, error() {} };

const clock = (iso) => {
    let current = new Date(iso);
    return {
        now: () => new Date(current),
        advance: (milliseconds) => {
            current = new Date(current.getTime() + milliseconds);
        }
    };
};

async function site(members = [{ email: OWNER, role: ROLE.owner }]) {
    const store = memoryStore();
    await store.writeBlob(
        'config',
        `${SLUG}/acl.json`,
        Buffer.from(JSON.stringify({ slug: SLUG, members }), 'utf8'),
        { contentType: 'application/json' }
    );
    for (const member of members) {
        await recordMembership({
            tables: store,
            email: member.email,
            slug: SLUG,
            role: member.role,
            now: () => new Date('2026-09-21T12:00:00Z')
        });
    }
    return store;
}

describe('opening and rotating an in-person invitation', () => {
    test('only an owner can start one', async () => {
        const store = await site([
            { email: OWNER, role: ROLE.owner },
            { email: READER, role: ROLE.reader }
        ]);

        const result = await startQrInvite({
            store,
            tables: store,
            slug: SLUG,
            actor: READER,
            key: KEY,
            baseUrl: BASE
        });

        assert.equal(result.error, 'owners only');
        assert.equal(await store.getEntity(TABLES.qrInvites, SLUG, 'active'), null);
    });

    test('the displayed credential changes without changing the gathering session', async () => {
        const store = await site();
        const time = clock('2026-09-21T12:00:00Z');
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER,
            key: KEY, baseUrl: BASE, now: time.now
        });

        time.advance(25_000);
        const rotated = await rotateQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, id: started.id,
            key: KEY, baseUrl: BASE, now: time.now
        });

        assert.equal(rotated.id, started.id);
        assert.notEqual(rotated.token, started.token);
        assert.match(rotated.url, /^https:\/\/pdayletters\.com\/join#/);
    });

    test('reopening replaces the old session immediately', async () => {
        const store = await site();
        const first = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, key: KEY, baseUrl: BASE
        });
        const second = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, key: KEY, baseUrl: BASE
        });

        assert.notEqual(first.id, second.id);
        assert.equal((await exchangeQrInvite({ tables: store, token: first.token, key: KEY })).status, 'closed');
        assert.equal((await exchangeQrInvite({ tables: store, token: second.token, key: KEY })).status, 'ready');
    });

    test('closing the dialog invalidates codes and exchanged tickets', async () => {
        const store = await site();
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, key: KEY, baseUrl: BASE
        });
        const ready = await exchangeQrInvite({ tables: store, token: started.token, key: KEY });

        await closeQrInvite({ store, tables: store, slug: SLUG, actor: OWNER, id: started.id });

        assert.equal((await exchangeQrInvite({ tables: store, token: started.token, key: KEY })).status, 'closed');
        assert.equal(
            (await acceptQrInvite({
                store, tables: store, ticket: ready.ticket, key: KEY,
                principal: READER, log: silent
            })).status,
            'closed'
        );
    });
});

describe('joining through a QR invitation', () => {
    test('an expired display code cannot be exchanged', async () => {
        const store = await site();
        const time = clock('2026-09-21T12:00:00Z');
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER,
            key: KEY, baseUrl: BASE, now: time.now
        });

        time.advance(31_000);
        assert.equal(
            (await exchangeQrInvite({ tables: store, token: started.token, key: KEY, now: time.now })).status,
            'expired'
        );
    });

    test('a scanned code becomes a ticket that survives the QR refresh', async () => {
        const store = await site();
        const time = clock('2026-09-21T12:00:00Z');
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER,
            key: KEY, baseUrl: BASE, now: time.now
        });
        const ready = await exchangeQrInvite({ tables: store, token: started.token, key: KEY, now: time.now });

        time.advance(45_000);
        const accepted = await acceptQrInvite({
            store, tables: store, ticket: ready.ticket, key: KEY,
            principal: READER, now: time.now, log: silent
        });

        assert.equal(accepted.status, 'ok');
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: READER } }), ROLE.reader);
    });

    test('the ticket can only add the signed-in identity as a reader', async () => {
        const store = await site();
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, key: KEY, baseUrl: BASE
        });
        const ready = await exchangeQrInvite({ tables: store, token: started.token, key: KEY });

        const accepted = await acceptQrInvite({
            store,
            tables: store,
            ticket: ready.ticket,
            key: KEY,
            principal: { email: READER, provider: 'google', userId: '123' },
            log: silent
        });

        assert.equal(accepted.role, ROLE.reader);
        const added = store.json('config', `${SLUG}/acl.json`).members.find((member) => member.email === READER);
        assert.equal(added.role, ROLE.reader);
        assert.equal(added.verifiedMissionary, false);
        assert.equal(added.invitedBy, OWNER);
    });

    test('the same account may safely retry but another account cannot replay the ticket', async () => {
        const store = await site();
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, key: KEY, baseUrl: BASE
        });
        const ready = await exchangeQrInvite({ tables: store, token: started.token, key: KEY });

        await acceptQrInvite({
            store, tables: store, ticket: ready.ticket, key: KEY, principal: READER, log: silent
        });
        const again = await acceptQrInvite({
            store, tables: store, ticket: ready.ticket, key: KEY, principal: READER, log: silent
        });
        const replay = await acceptQrInvite({
            store, tables: store, ticket: ready.ticket, key: KEY,
            principal: 'stranger@example.com', log: silent
        });

        assert.equal(again.status, 'ok');
        assert.equal(replay.status, 'accepted');
        assert.equal(
            await resolveRole({ store, slug: SLUG, principal: { email: 'stranger@example.com' } }),
            null
        );
    });

    test('a completed ticket cannot restore access after an owner removes the reader', async () => {
        const store = await site();
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, key: KEY, baseUrl: BASE
        });
        const ready = await exchangeQrInvite({ tables: store, token: started.token, key: KEY });
        await acceptQrInvite({
            store, tables: store, ticket: ready.ticket, key: KEY, principal: READER, log: silent
        });

        const acl = store.json('config', `${SLUG}/acl.json`);
        acl.members = acl.members.filter((member) => member.email !== READER);
        await store.writeBlob(
            'config',
            `${SLUG}/acl.json`,
            Buffer.from(JSON.stringify(acl), 'utf8'),
            { contentType: 'application/json' }
        );

        const replay = await acceptQrInvite({
            store, tables: store, ticket: ready.ticket, key: KEY, principal: READER, log: silent
        });

        assert.equal(replay.status, 'accepted');
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: READER } }), null);
    });

    test('removing the owner who opened it closes the remaining tickets', async () => {
        const store = await site([
            { email: OWNER, role: ROLE.owner },
            { email: 'other-owner@example.com', role: ROLE.owner }
        ]);
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, key: KEY, baseUrl: BASE
        });
        const ready = await exchangeQrInvite({ tables: store, token: started.token, key: KEY });

        const acl = store.json('config', `${SLUG}/acl.json`);
        acl.members = acl.members.filter((member) => member.email !== OWNER);
        await store.writeBlob(
            'config',
            `${SLUG}/acl.json`,
            Buffer.from(JSON.stringify(acl), 'utf8'),
            { contentType: 'application/json' }
        );

        const result = await acceptQrInvite({
            store, tables: store, ticket: ready.ticket, key: KEY, principal: READER, log: silent
        });

        assert.equal(result.status, 'closed');
    });

    test('a gathering is capped even though fresh codes can keep rotating', async () => {
        const store = await site();
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, key: KEY, baseUrl: BASE
        });
        const partitionKey = `${SLUG}:${started.id}`;
        for (let i = 0; i < QR_SESSION_MAX_JOINS; i++) {
            await store.insertEntity(TABLES.qrRedemptions, {
                partitionKey,
                rowKey: `slot-${String(i).padStart(2, '0')}`,
                acceptedBy: `reader-${i}@example.com`
            });
        }
        const ready = await exchangeQrInvite({ tables: store, token: started.token, key: KEY });

        const result = await acceptQrInvite({
            store, tables: store, ticket: ready.ticket, key: KEY, principal: READER, log: silent
        });

        assert.equal(result.status, 'full');
        assert.equal(await store.getEntity(
            TABLES.qrRedemptions,
            partitionKey,
            `ticket-${claimTokenHash(ready.ticket)}`
        ), null);
    });

    test('capacity reservation is atomic under concurrent joins', async () => {
        const store = await site();
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, key: KEY, baseUrl: BASE
        });
        const tickets = [];
        for (let i = 0; i < QR_SESSION_MAX_JOINS + 5; i++) {
            tickets.push((await exchangeQrInvite({ tables: store, token: started.token, key: KEY })).ticket);
        }

        const results = await Promise.all(
            tickets.map((ticket, index) =>
                acceptQrInvite({
                    store,
                    tables: store,
                    ticket,
                    key: KEY,
                    principal: `reader-${index}@example.com`,
                    log: silent
                })
            )
        );

        assert.equal(results.filter((result) => result.status === 'ok').length, QR_SESSION_MAX_JOINS);
        assert.equal(results.filter((result) => result.status === 'full').length, 5);
        assert.equal(store.json('config', `${SLUG}/acl.json`).members.length, QR_SESSION_MAX_JOINS + 1);
    });
});
