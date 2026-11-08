// In-person QR invitations: short session codes and reader-only membership.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { ROLE, resolveRole } from '../src/lib/acl.js';
import {
    acceptQrInvite,
    closeQrInvite,
    exchangeQrInvite,
    QR_CLOSE_GRACE_SECONDS,
    QR_SESSION_MINUTES,
    startQrInvite
} from '../src/lib/qrinvite.js';
import { recordMembership } from '../src/lib/memberships.js';
import { TABLES } from '../src/lib/tables.js';
import { setUserProfile } from '../src/lib/userprofile.js';

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

describe('opening and closing an in-person invitation', () => {
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
            baseUrl: BASE
        });

        assert.equal(result.error, 'owners only');
        assert.equal(await store.getEntity(TABLES.qrInvites, SLUG, 'active'), null);
    });

    test('mints a compact 16-character URL-safe code', async () => {
        const store = await site();
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, baseUrl: BASE
        });

        assert.match(started.token, /^[A-Za-z0-9_-]{16}$/);
        assert.equal(started.url, `https://pdayletters.com/join#${started.token}`);
    });

    test('reopening replaces the old session immediately', async () => {
        const store = await site();
        const first = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, baseUrl: BASE
        });
        const second = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, baseUrl: BASE
        });

        assert.notEqual(first.id, second.id);
        assert.equal((await exchangeQrInvite({ tables: store, token: first.token })).status, 'closed');
        assert.equal((await exchangeQrInvite({ tables: store, token: second.token })).status, 'ready');
    });

    test('closing rejects new scans but gives someone already signing in time to finish', async () => {
        const store = await site();
        const time = clock('2026-09-21T12:00:00Z');
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, baseUrl: BASE, now: time.now
        });
        const ready = await exchangeQrInvite({
            tables: store, token: started.token, now: time.now
        });

        await closeQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, id: started.id, now: time.now
        });

        assert.equal(
            (await exchangeQrInvite({
                tables: store, token: started.token, now: time.now
            })).status,
            'closed'
        );
        time.advance((QR_CLOSE_GRACE_SECONDS - 1) * 1000);
        assert.equal(
            (await acceptQrInvite({
                store, tables: store, token: ready.token,
                principal: READER, now: time.now, log: silent
            })).status,
            'ok'
        );
    });

    test('stops working when the close grace period ends', async () => {
        const store = await site();
        const time = clock('2026-09-21T12:00:00Z');
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, baseUrl: BASE, now: time.now
        });
        await closeQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, id: started.id, now: time.now
        });

        time.advance((QR_CLOSE_GRACE_SECONDS + 1) * 1000);
        const result = await acceptQrInvite({
            store, tables: store, token: started.token,
            principal: READER, now: time.now, log: silent
        });

        assert.equal(result.status, 'closed');
    });
});

describe('joining through a QR invitation', () => {
    test('an expired session code cannot be used', async () => {
        const store = await site();
        const time = clock('2026-09-21T12:00:00Z');
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, baseUrl: BASE, now: time.now
        });

        time.advance(QR_SESSION_MINUTES * 60 * 1000 + 1000);
        assert.equal(
            (await exchangeQrInvite({ tables: store, token: started.token, now: time.now })).status,
            'expired'
        );
        assert.equal(
            (await acceptQrInvite({
                store, tables: store, token: started.token,
                principal: READER, now: time.now, log: silent
            })).status,
            'expired'
        );
    });

    test('describes the inviter and adds the signed-in identity as a reader', async () => {
        const store = await site();
        await setUserProfile({
            tables: store,
            email: OWNER,
            displayName: 'Ana Example',
            provider: 'google'
        });
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, baseUrl: BASE
        });
        const ready = await exchangeQrInvite({ tables: store, token: started.token });
        assert.equal(ready.invitedByName, 'Ana Example');

        const accepted = await acceptQrInvite({
            store,
            tables: store,
            token: ready.token,
            principal: { email: READER, provider: 'google', userId: '123' },
            log: silent
        });

        assert.equal(accepted.status, 'ok');
        assert.equal(accepted.role, ROLE.reader);
        const added = store.json('config', `${SLUG}/acl.json`).members.find((member) => member.email === READER);
        assert.equal(added.role, ROLE.reader);
        assert.equal(added.verifiedMissionary, false);
        assert.equal(added.invitedBy, OWNER);
    });

    test('multiple people scanning the same displayed code can join independently', async () => {
        const store = await site();
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, baseUrl: BASE
        });

        const results = await Promise.all([
            acceptQrInvite({
                store, tables: store, token: started.token,
                principal: READER, log: silent
            }),
            acceptQrInvite({
                store, tables: store, token: started.token,
                principal: 'grandpa@example.com', log: silent
            })
        ]);

        assert.deepEqual(results.map((result) => result.status), ['ok', 'ok']);
        assert.equal(
            await resolveRole({ store, slug: SLUG, principal: { email: READER } }),
            ROLE.reader
        );
        assert.equal(
            await resolveRole({
                store,
                slug: SLUG,
                principal: { email: 'grandpa@example.com' }
            }),
            ROLE.reader
        );
    });

    test('removing the owner who opened it closes the session', async () => {
        const store = await site([
            { email: OWNER, role: ROLE.owner },
            { email: 'other-owner@example.com', role: ROLE.owner }
        ]);
        const started = await startQrInvite({
            store, tables: store, slug: SLUG, actor: OWNER, baseUrl: BASE
        });

        const acl = store.json('config', `${SLUG}/acl.json`);
        acl.members = acl.members.filter((member) => member.email !== OWNER);
        await store.writeBlob(
            'config',
            `${SLUG}/acl.json`,
            Buffer.from(JSON.stringify(acl), 'utf8'),
            { contentType: 'application/json' }
        );

        const result = await acceptQrInvite({
            store, tables: store, token: started.token, principal: READER, log: silent
        });

        assert.equal(result.status, 'closed');
    });
});
