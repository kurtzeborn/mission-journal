// Sending an invitation again.
//
// The reason this exists is dull -- the first email went to spam, or
// grandmother cannot find it -- and the reason it needs its own file is not:
// a resend is a way to make the service send mail, and every guard that
// applies to issuing an invitation has to apply here too or the guards were
// pointless. Most of what follows is about that.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { ROLE } from '../src/lib/acl.js';
import {
    acceptInvite,
    describeInvite,
    inviteMember,
    INVITES_PER_DAY,
    listInvites,
    resendInvite,
    revokeInvite
} from '../src/lib/invite.js';
import { issueOptOut, recordOptOut } from '../src/lib/optout.js';
import { recordMembership } from '../src/lib/memberships.js';
import { TABLES } from '../src/lib/tables.js';

const silent = { info() {}, warn() {}, error() {} };
const NOW = () => new Date('2026-08-05T12:00:00Z');
const KEY = 'a-signing-key-from-key-vault';
const SLUG = 'elder.example';
const BASE = 'https://pdayletters.com';

const OWNER = 'parent@example.com';
const OTHER = 'aunt@example.com';
const THEM = 'grandma@example.com';

const member = (email, role) => ({
    email,
    role,
    verifiedMissionary: false,
    addedAt: '2026-08-01T00:00:00Z'
});

async function site(members) {
    const store = memoryStore();
    await store.writeBlob(
        'config',
        `${SLUG}/acl.json`,
        Buffer.from(JSON.stringify({ slug: SLUG, members }, null, 2), 'utf8'),
        { contentType: 'application/json' }
    );
    for (const m of members) {
        await recordMembership({ tables: store, email: m.email, slug: SLUG, role: m.role, now: NOW });
    }
    return store;
}

const recorder = () => {
    const sent = [];
    return {
        sent,
        send: async (message) => {
            sent.push(message);
            return { status: 'sent' };
        }
    };
};

/** An archive with one owner and one invitation waiting to be accepted. */
async function pending({ role = ROLE.reader, at = NOW } = {}) {
    const store = await site([member(OWNER, ROLE.owner)]);
    const mailer = recorder();

    await inviteMember({
        store, tables: store, mailer, slug: SLUG, actor: OWNER,
        email: THEM, role, key: KEY, baseUrl: BASE, now: at, log: silent
    });

    const [invitation] = await listInvites({ tables: store, slug: SLUG, now: at });
    return { store, mailer, invitation };
}

const resend = (store, mailer, id, extra = {}) =>
    resendInvite({
        store, tables: store, mailer, slug: SLUG, actor: OWNER,
        id, key: KEY, baseUrl: BASE, now: NOW, log: silent, ...extra
    });

describe('sending an invitation again', () => {
    test('a second email goes to the same person', async () => {
        const { store, mailer, invitation } = await pending();

        const result = await resend(store, mailer, invitation.id);

        assert.equal(result.ok, true);
        assert.equal(mailer.sent.length, 2);
        assert.equal(mailer.sent[1].to, THEM);
    });

    test('the address comes from the stored row, never from the caller', async () => {
        // The property that keeps this from being a second, quieter way to
        // mail strangers. The caller names an invitation, not a recipient.
        const { store, mailer, invitation } = await pending();

        await resend(store, mailer, invitation.id, { email: 'somebody.else@example.com' });

        assert.equal(mailer.sent[1].to, THEM);
    });

    test('the earlier link stops working', async () => {
        const { store, mailer, invitation } = await pending();
        const firstToken = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];

        await resend(store, mailer, invitation.id);

        const described = await describeInvite({ tables: store, token: firstToken, key: KEY, now: NOW });
        assert.equal(described.status, 'invalid');
    });

    test('and the new one does', async () => {
        const { store, mailer, invitation } = await pending();

        await resend(store, mailer, invitation.id);
        const secondToken = mailer.sent[1].text.match(/\/invite#(\S+)/)[1];

        const described = await describeInvite({ tables: store, token: secondToken, key: KEY, now: NOW });
        assert.equal(described.status, 'ready');
        assert.equal(described.invitedBy, OWNER);
    });

    test('the owner still sees exactly one invitation', async () => {
        // The whole point over re-inviting by hand: one person, one row.
        const { store, mailer, invitation } = await pending();

        await resend(store, mailer, invitation.id);

        const list = await listInvites({ tables: store, slug: SLUG, now: NOW });
        assert.equal(list.length, 1);
        assert.equal(list[0].email, THEM);
        assert.notEqual(list[0].id, invitation.id);
    });

    test('the clock restarts, which is why the token is new', async () => {
        // Reissuing the same token would leave an invitation resent on day
        // thirteen expiring tomorrow, which does not solve what it was asked
        // to solve.
        const later = () => new Date('2026-08-18T12:00:00Z');
        const { store, mailer, invitation } = await pending();

        const result = await resendInvite({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            id: invitation.id, key: KEY, baseUrl: BASE, now: later, log: silent
        });

        assert.ok(Date.parse(result.expiresAt) > Date.parse(invitation.expiresAt));
    });

    test('the role is carried over rather than reset to reader', async () => {
        const { store, mailer, invitation } = await pending({ role: ROLE.owner });

        const result = await resend(store, mailer, invitation.id);

        assert.equal(result.role, ROLE.owner);
        const [now] = await listInvites({ tables: store, slug: SLUG, now: NOW });
        assert.equal(now.role, ROLE.owner);
    });

    test('accepting the new link works end to end', async () => {
        const { store, mailer, invitation } = await pending();
        await resend(store, mailer, invitation.id);
        const token = mailer.sent[1].text.match(/\/invite#(\S+)/)[1];

        const accepted = await acceptInvite({
            store, tables: store, token, key: KEY, principal: 'g.example@gmail.com', now: NOW, log: silent
        });

        assert.equal(accepted.status, 'ok');
        const acl = store.json('config', `${SLUG}/acl.json`).members;
        assert.ok(acl.some((m) => m.email === 'g.example@gmail.com'));
    });
});

describe('the guards that apply to any send apply here', () => {
    test('it spends one of the day\'s twenty', async () => {
        // The one that matters most. A resend that did not count would turn a
        // single invitation into an unbounded send loop pointed at one
        // address -- a worse shape than the revoke loop the tombstone closes.
        const { store, mailer, invitation } = await pending();

        await resend(store, mailer, invitation.id);

        const rows = await store.listEntities(TABLES.invites, { partitionKey: SLUG });
        assert.equal(rows.length, 2);
    });

    test('and is refused once the day is spent', async () => {
        const { store, mailer, invitation } = await pending();

        for (let n = 0; n < INVITES_PER_DAY - 1; n++) {
            await inviteMember({
                store, tables: store, mailer, slug: SLUG, actor: OWNER,
                email: `relative${n}@example.com`, key: KEY, baseUrl: BASE, now: NOW, log: silent
            });
        }
        const before = mailer.sent.length;

        const result = await resend(store, mailer, invitation.id);

        assert.equal(result.error, 'too many invitations today, try again tomorrow');
        assert.equal(mailer.sent.length, before);
    });

    test('repeated resending cannot outrun the cap', async () => {
        // Stated as its own test because the loop is the attack: press the
        // button until the sending domain is in trouble.
        const { store, mailer, invitation } = await pending();

        let id = invitation.id;
        let sent = 1;
        for (let n = 0; n < INVITES_PER_DAY + 5; n++) {
            const result = await resend(store, mailer, id);
            if (result.error) break;
            id = result.id;
            sent++;
        }

        assert.equal(sent, INVITES_PER_DAY);
        assert.equal(mailer.sent.length, INVITES_PER_DAY);
    });

    test('somebody who opted out in the meantime is not mailed again', async () => {
        const { store, mailer, invitation } = await pending();
        await recordOptOut({
            tables: store,
            token: issueOptOut({ email: THEM, slug: SLUG, key: KEY, now: NOW }),
            key: KEY, now: NOW, log: silent
        });

        const result = await resend(store, mailer, invitation.id);

        assert.equal(result.error, 'has asked us not to email them');
        assert.equal(mailer.sent.length, 1);
    });

    test('a reader cannot resend', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(OTHER, ROLE.reader)]);
        const mailer = recorder();
        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: THEM, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const [invitation] = await listInvites({ tables: store, slug: SLUG, now: NOW });

        const result = await resendInvite({
            store, tables: store, mailer, slug: SLUG, actor: OTHER,
            id: invitation.id, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.equal(result.error, 'owners only');
        assert.equal(mailer.sent.length, 1);
    });

    test('a stranger cannot resend', async () => {
        const { store, mailer, invitation } = await pending();

        const result = await resendInvite({
            store, tables: store, mailer, slug: SLUG, actor: 'nobody@example.com',
            id: invitation.id, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.equal(result.error, 'owners only');
        assert.equal(mailer.sent.length, 1);
    });

    test('an invitation belonging to another archive is not reachable', async () => {
        const { store, mailer, invitation } = await pending();

        const result = await resendInvite({
            store, tables: store, mailer, slug: 'someone.else', actor: OWNER,
            id: invitation.id, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.ok(result.error);
        assert.equal(mailer.sent.length, 1);
    });
});

describe('there is nothing to resend', () => {
    test('an invitation already accepted', async () => {
        const { store, mailer, invitation } = await pending();
        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];
        await acceptInvite({
            store, tables: store, token, key: KEY, principal: THEM, now: NOW, log: silent
        });

        const result = await resend(store, mailer, invitation.id);

        assert.equal(result.error, 'no such invitation');
        assert.equal(mailer.sent.length, 1);
    });

    test('an invitation already withdrawn', async () => {
        const { store, mailer, invitation } = await pending();
        await revokeInvite({ tables: store, slug: SLUG, id: invitation.id, now: NOW });

        const result = await resend(store, mailer, invitation.id);

        assert.equal(result.error, 'no such invitation');
        assert.equal(mailer.sent.length, 1);
    });

    test('an invitation that has expired, because the owner cannot see it', async () => {
        // Not an oversight. `listInvites` hides expired rows, so there is no
        // button to press, and the remedy is to invite the address again.
        const { store, mailer, invitation } = await pending();
        const afterwards = () => new Date('2026-09-05T12:00:00Z');

        const result = await resendInvite({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            id: invitation.id, key: KEY, baseUrl: BASE, now: afterwards, log: silent
        });

        assert.equal(result.error, 'no such invitation');
        assert.equal(mailer.sent.length, 1);
    });

    test('an id that was never real', async () => {
        const { store, mailer } = await pending();

        const result = await resend(store, mailer, 'f'.repeat(64));

        assert.equal(result.error, 'no such invitation');
        assert.equal(mailer.sent.length, 1);
    });

    test('no id at all', async () => {
        const { store, mailer } = await pending();

        assert.equal((await resend(store, mailer, '')).error, 'no such invitation');
        assert.equal(mailer.sent.length, 1);
    });
});

describe('what the second email says', () => {
    test('it admits it is a repeat, in the subject', async () => {
        // A near-identical email arriving twice reads as a machine that will
        // not stop. This service promises never to repeat an invitation on
        // its own, and the way to keep that promise visible is to be plain
        // about the one case where a person asked us to.
        const { store, mailer, invitation } = await pending();

        await resend(store, mailer, invitation.id);

        assert.match(mailer.sent[1].subject, /sent you this again/i);
        assert.doesNotMatch(mailer.sent[0].subject, /again/i);
    });

    test('and warns that the older link is dead', async () => {
        // Without this, somebody who kept both emails tries the first link,
        // is told it cannot be used, and concludes the service is broken.
        const { store, mailer, invitation } = await pending();

        await resend(store, mailer, invitation.id);

        assert.match(mailer.sent[1].text, /the older one has\s+stopped working/);
        assert.match(mailer.sent[1].html, /the older link has stopped working/);
    });

    test('the first email says none of that', async () => {
        const { store, mailer } = await pending();

        assert.doesNotMatch(mailer.sent[0].text, /stopped working/);
        assert.doesNotMatch(mailer.sent[0].html, /asked us to send this again/);
    });

    test('it still carries the way out', async () => {
        const { store, mailer, invitation } = await pending();

        await resend(store, mailer, invitation.id);

        assert.match(mailer.sent[1].text, /\/optout#\S+/);
        assert.equal(mailer.sent[1].headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    });

    test('it names the inviting owner, like any invitation', async () => {
        const { store, mailer, invitation } = await pending();

        await resend(store, mailer, invitation.id);

        assert.match(mailer.sent[1].subject, new RegExp(OWNER));
        assert.match(mailer.sent[1].text, new RegExp(OWNER));
    });
});
