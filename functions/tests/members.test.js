// Membership tests: who may change an archive's audience, and who may not.
//
// The policy in `members.js` is four rules that only make sense together, and
// most of what follows is about the combinations rather than the rules -- the
// interesting failures are an owner locking themselves out, an archive
// reaching zero owners, and a squatter evicting the missionary who took their
// own archive back.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { ROLE, resolveRole } from '../src/lib/acl.js';
import { listMembers, removeMember, setMemberRole, validEmail } from '../src/lib/members.js';
import { acceptInvite, describeInvite, inviteMember, INVITES_PER_DAY, listInvites, revokeInvite } from '../src/lib/invite.js';
import { membershipsFor, recordMembership } from '../src/lib/memberships.js';
import { recordDelivery } from '../src/lib/delivery.js';
import { issueClaimToken, PURPOSE, verifyClaimToken } from '../src/lib/claimtoken.js';

const silent = { info() {}, warn() {}, error() {} };
const NOW = () => new Date('2026-08-05T12:00:00Z');
const KEY = 'a-signing-key-from-key-vault';
const SLUG = 'elder.example';
const BASE = 'https://pdayletters.com';

const OWNER = 'parent@example.com';
const OTHER = 'aunt@example.com';
const READER = 'grandma@example.com';
const MISSIONARY = 'elder.example@missionary.org';

const member = (email, role, extra = {}) => ({
    email,
    role,
    verifiedMissionary: false,
    addedAt: '2026-08-01T00:00:00Z',
    ...extra
});

/** A site whose ACL is exactly what the test asked for. */
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

const aclOf = (store) => store.json('config', `${SLUG}/acl.json`).members;

// --- removal --------------------------------------------------------------

describe('taking someone off an archive', () => {
    test('an owner can remove a reader', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);

        const result = await removeMember({
            store, tables: store, slug: SLUG, actor: OWNER, email: READER, now: NOW, log: silent
        });

        assert.equal(result.ok, true);
        assert.deepEqual(aclOf(store).map((m) => m.email), [OWNER]);
        // The ACL is the authority, but a stale index sends a removed reader
        // back to a site that then refuses them, so it is repaired too.
        assert.deepEqual(await membershipsFor({ tables: store, email: READER }), []);
    });

    test('and the removal actually takes effect, not just on paper', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);
        await removeMember({ store, tables: store, slug: SLUG, actor: OWNER, email: READER, now: NOW, log: silent });

        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: READER } }), null);
    });

    test('an owner can remove another owner', async () => {
        // Asked for explicitly. Ownership is not a rank, and a family that
        // gave it to the wrong person must be able to take it back without
        // asking anyone.
        const store = await site([member(OWNER, ROLE.owner), member(OTHER, ROLE.owner)]);

        const result = await removeMember({
            store, tables: store, slug: SLUG, actor: OWNER, email: OTHER, now: NOW, log: silent
        });

        assert.equal(result.ok, true);
        assert.deepEqual(aclOf(store).map((m) => m.email), [OWNER]);
    });

    test('nobody can remove themselves', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(OTHER, ROLE.owner)]);

        const result = await removeMember({
            store, tables: store, slug: SLUG, actor: OWNER, email: OWNER, now: NOW, log: silent
        });

        assert.equal(result.error, 'you cannot change your own membership');
        assert.equal(aclOf(store).length, 2);
    });

    test('so the last owner cannot be removed, without a rule that says so', async () => {
        // The invariant this file exists to protect. There is no "last owner"
        // check anywhere in members.js; it falls out of the self rule, and
        // this test is what would notice if somebody relaxed that rule for
        // some other good reason.
        const store = await site([member(OWNER, ROLE.owner)]);

        await removeMember({ store, tables: store, slug: SLUG, actor: OWNER, email: OWNER, now: NOW, log: silent });

        assert.equal(aclOf(store).filter((m) => m.role === ROLE.owner).length, 1);
    });

    test('a reader cannot remove anyone', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);

        const result = await removeMember({
            store, tables: store, slug: SLUG, actor: READER, email: OWNER, now: NOW, log: silent
        });

        assert.equal(result.error, 'owners only');
        assert.equal(aclOf(store).length, 2);
    });

    test('a stranger cannot remove anyone', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);

        const result = await removeMember({
            store, tables: store, slug: SLUG, actor: 'nobody@example.com', email: READER, now: NOW, log: silent
        });

        assert.equal(result.error, 'owners only');
    });

    test('removing somebody who is not there says so, and changes nothing', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);

        const result = await removeMember({
            store, tables: store, slug: SLUG, actor: OWNER, email: 'ghost@example.com', now: NOW, log: silent
        });

        assert.equal(result.error, 'not a member');
    });

    test('addresses are matched case-insensitively, as they are everywhere else', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);

        const result = await removeMember({
            store, tables: store, slug: SLUG, actor: 'Parent@Example.COM', email: 'GRANDMA@example.com', now: NOW, log: silent
        });

        assert.equal(result.ok, true);
        assert.deepEqual(aclOf(store).map((m) => m.email), [OWNER]);
    });
});

// --- the verified missionary ----------------------------------------------

describe('the missionary cannot be evicted from their own archive', () => {
    test('not removed, even by an owner', async () => {
        // The squatting scenario the bootstrap path opened: anyone who
        // received a letter can start an archive. Being able to take it back
        // is worth nothing if they can simply be removed again.
        const store = await site([
            member(OWNER, ROLE.owner),
            member(MISSIONARY, ROLE.owner, { verifiedMissionary: true })
        ]);

        const result = await removeMember({
            store, tables: store, slug: SLUG, actor: OWNER, email: MISSIONARY, now: NOW, log: silent
        });

        assert.equal(result.error, 'the verified missionary cannot be changed');
        assert.equal(aclOf(store).length, 2);
    });

    test('and not demoted either, which would be removal with extra steps', async () => {
        const store = await site([
            member(OWNER, ROLE.owner),
            member(MISSIONARY, ROLE.owner, { verifiedMissionary: true })
        ]);

        const result = await setMemberRole({
            store, tables: store, slug: SLUG, actor: OWNER, email: MISSIONARY, role: ROLE.reader, now: NOW, log: silent
        });

        assert.equal(result.error, 'the verified missionary cannot be changed');
        assert.equal(aclOf(store).find((m) => m.email === MISSIONARY).role, ROLE.owner);
    });

    test('but the missionary can remove the person who set it up', async () => {
        const store = await site([
            member(OWNER, ROLE.owner),
            member(MISSIONARY, ROLE.owner, { verifiedMissionary: true })
        ]);

        const result = await removeMember({
            store, tables: store, slug: SLUG, actor: MISSIONARY, email: OWNER, now: NOW, log: silent
        });

        assert.equal(result.ok, true);
        assert.deepEqual(aclOf(store).map((m) => m.email), [MISSIONARY]);
    });

    test('the list says which rows have a button, so the page cannot guess', async () => {
        const store = await site([
            member(OWNER, ROLE.owner),
            member(MISSIONARY, ROLE.owner, { verifiedMissionary: true }),
            member(READER, ROLE.reader)
        ]);

        const listed = await listMembers({ store, slug: SLUG, actor: OWNER });
        const by = Object.fromEntries(listed.map((m) => [m.email, m]));

        assert.equal(by[OWNER].you, true);
        assert.equal(by[OWNER].removable, false, 'your own row');
        assert.equal(by[MISSIONARY].removable, false, 'the verified missionary');
        assert.equal(by[READER].removable, true);
    });
});

// --- whose mail is not arriving -------------------------------------------

describe('telling an owner that somebody is not hearing from us', () => {
    // Undeliverable mail is the only failure here whose symptom is silence.
    // Nobody complains about an archive they cannot tell exists, so unless the
    // owner is shown it on the page they will never learn it.
    test('a member whose mail bounced is marked, and the rest are not', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);
        await recordDelivery({ tables: store, email: READER, status: 'suppressed', slug: SLUG, now: NOW, log: silent });

        const listed = await listMembers({ store, tables: store, slug: SLUG, actor: OWNER });
        const by = Object.fromEntries(listed.map((m) => [m.email, m]));

        assert.equal(by[READER].delivery, 'suppressed');
        assert.equal(by[READER].deliveryAt, '2026-08-05T12:00:00.000Z');
        assert.equal(by[OWNER].delivery, '', 'nothing was ever wrong with this one');
    });

    test('an archive still lists without the table that says so', async () => {
        // The annotation is worth having and is not worth the page. An owner
        // locked out of seeing who has access, because a side table is down,
        // would be a much worse day than a missing warning.
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);

        const listed = await listMembers({ store, slug: SLUG, actor: OWNER });

        assert.equal(listed.length, 2);
        assert.equal(listed[0].delivery, '');
    });

    test('an invitation that never arrived is marked too', async () => {
        // The sharpest case the annotation exists for: the owner is looking at
        // a row that says "invited" and waiting for somebody who was never
        // written to.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = { sent: [], send: async (m) => (mailer.sent.push(m), { status: 'bounced' }) };

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const [pending] = await listInvites({ tables: store, slug: SLUG, now: NOW, log: silent });

        assert.equal(pending.email, READER);
        assert.equal(pending.delivery, 'bounced');
        assert.ok(pending.deliveryAt);
    });

    test('an invitation that went through says nothing at all', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const [pending] = await listInvites({ tables: store, slug: SLUG, now: NOW, log: silent });

        assert.equal(pending.delivery, '');
        assert.equal(pending.deliveryAt, '');
    });
});

// --- promotion ------------------------------------------------------------

describe('changing what somebody may do', () => {
    test('an owner can promote a reader', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);

        const result = await setMemberRole({
            store, tables: store, slug: SLUG, actor: OWNER, email: READER, role: ROLE.owner, now: NOW, log: silent
        });

        assert.equal(result.ok, true);
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: READER } }), ROLE.owner);
        assert.equal((await membershipsFor({ tables: store, email: READER }))[0].role, ROLE.owner);
    });

    test('and demote one', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(OTHER, ROLE.owner)]);

        await setMemberRole({
            store, tables: store, slug: SLUG, actor: OWNER, email: OTHER, role: ROLE.reader, now: NOW, log: silent
        });

        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: OTHER } }), ROLE.reader);
    });

    test('but not their own role, so an archive cannot lose its last owner', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);

        const result = await setMemberRole({
            store, tables: store, slug: SLUG, actor: OWNER, email: OWNER, role: ROLE.reader, now: NOW, log: silent
        });

        assert.equal(result.error, 'you cannot change your own membership');
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: OWNER } }), ROLE.owner);
    });

    test('an invented role is refused rather than written', async () => {
        // resolveRole refuses to read an unrecognised role, so writing one
        // would silently revoke access rather than grant something odd. Both
        // ends have to refuse.
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);

        const result = await setMemberRole({
            store, tables: store, slug: SLUG, actor: OWNER, email: READER, role: 'admin', now: NOW, log: silent
        });

        assert.equal(result.error, 'unknown role');
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: READER } }), ROLE.reader);
    });
});

// --- invitations ----------------------------------------------------------

describe('inviting somebody who has never signed in', () => {
    test('mails a link and changes nothing until it is followed', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        const result = await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.equal(result.ok, true);
        assert.equal(mailer.sent.length, 1);
        assert.equal(mailer.sent[0].to, READER);
        assert.equal(mailer.sent[0].from, 'P-Day Letters <hello@pdayletters.com>');
        // Nothing yet. An invitation is an offer, and an offer that granted
        // access before it was accepted would be an ACL entry with extra
        // steps.
        assert.deepEqual(aclOf(store).map((m) => m.email), [OWNER]);
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: READER } }), null);
    });

    test('the link binds to whoever signs in, not to the address it was sent to', async () => {
        // The whole reason invitations are links. The address a family knows
        // for someone is very often not the account they sign in with, and an
        // ACL entry for the address the family typed would never match.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: 'grandma@aol.com', key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];
        const accepted = await acceptInvite({
            store, tables: store, token, key: KEY,
            principal: 'g.example@gmail.com', now: NOW, log: silent
        });

        assert.equal(accepted.status, 'ok');
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: 'g.example@gmail.com' } }), ROLE.reader);
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: 'grandma@aol.com' } }), null);
    });

    test('the owner can still tell who the unfamiliar address is', async () => {
        // The cost of binding to the identity rather than the address: the
        // owner invited one address and a different one appeared. Without the
        // address they typed being kept, the confusion invitations exist to
        // absorb is simply moved onto the person deciding who to remove.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: 'grandma@aol.com', key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];
        await acceptInvite({
            store, tables: store, token, key: KEY,
            principal: 'g.example@gmail.com', now: NOW, log: silent
        });

        const listed = await listMembers({ store, slug: SLUG, actor: OWNER });
        const grandma = listed.find((m) => m.email === 'g.example@gmail.com');
        assert.equal(grandma.invitedEmail, 'grandma@aol.com');
    });

    test('an address that did not change is not echoed back twice', async () => {
        // Said once is a fact; said twice is noise on a row whose job is to be
        // checkable at a glance before somebody presses Remove.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];
        await acceptInvite({ store, tables: store, token, key: KEY, principal: READER, now: NOW, log: silent });

        const listed = await listMembers({ store, slug: SLUG, actor: OWNER });
        assert.equal(listed.find((m) => m.email === READER).invitedEmail, '');
        // And somebody who was never invited has nothing to show at all.
        assert.equal(listed.find((m) => m.email === OWNER).invitedEmail, '');
    });

    test('accepting as an owner grants ownership, not a reader seat', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER, email: OTHER,
            role: ROLE.owner, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];
        await acceptInvite({ store, tables: store, token, key: KEY, principal: OTHER, now: NOW, log: silent });

        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: OTHER } }), ROLE.owner);
    });

    test('an accepted invitation cannot be used by a second person', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];

        await acceptInvite({ store, tables: store, token, key: KEY, principal: READER, now: NOW, log: silent });
        const second = await acceptInvite({
            store, tables: store, token, key: KEY, principal: 'stranger@example.com', now: NOW, log: silent
        });

        assert.equal(second.status, 'accepted');
        assert.equal(await resolveRole({ store, slug: SLUG, principal: { email: 'stranger@example.com' } }), null);
    });

    test("but the invitee's own retry is not a refusal", async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];

        await acceptInvite({ store, tables: store, token, key: KEY, principal: READER, now: NOW, log: silent });
        const again = await acceptInvite({ store, tables: store, token, key: KEY, principal: READER, now: NOW, log: silent });

        assert.equal(again.status, 'ok');
        assert.equal(aclOf(store).filter((m) => m.email === READER).length, 1, 'and does not add them twice');
    });

    test('a revoked invitation is indistinguishable from one that never existed', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];
        const [pending] = await listInvites({ tables: store, slug: SLUG, now: NOW });

        await revokeInvite({ tables: store, slug: SLUG, id: pending.id });

        assert.deepEqual(await describeInvite({ tables: store, token, key: KEY, now: NOW }), { status: 'invalid' });
        assert.equal(
            (await acceptInvite({ store, tables: store, token, key: KEY, principal: READER, now: NOW, log: silent })).status,
            'invalid'
        );
    });

    test('an expired invitation says so, rather than pretending to be broken', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];

        const later = () => new Date('2026-09-30T12:00:00Z');
        const described = await describeInvite({ tables: store, token, key: KEY, now: later });

        assert.equal(described.status, 'expired');
        assert.equal(
            (await acceptInvite({ store, tables: store, token, key: KEY, principal: READER, now: later, log: silent })).status,
            'expired'
        );
    });

    test('and drops out of the owner\'s list once it has lapsed', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.equal((await listInvites({ tables: store, slug: SLUG, now: NOW })).length, 1);
        assert.equal(
            (await listInvites({ tables: store, slug: SLUG, now: () => new Date('2026-09-30T12:00:00Z') })).length,
            0
        );
    });

    test('a reader cannot invite anyone', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);
        const mailer = recorder();

        const result = await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: READER,
            email: 'friend@example.com', key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.equal(result.error, 'owners only');
        assert.equal(mailer.sent.length, 0, 'and no mail was sent to find out');
    });

    test('inviting somebody who is already there is refused, not duplicated', async () => {
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);
        const mailer = recorder();

        const result = await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.equal(result.error, 'already a member');
        assert.equal(mailer.sent.length, 0);
    });

    test('the invitation names who sent it, because otherwise it is phishing', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.match(mailer.sent[0].subject, /parent@example\.com/);
        assert.match(mailer.sent[0].text, /personal account/i);
    });

    test('and says nothing about the letters, which the holder is not yet entitled to', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email: READER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        // The slug is the missionary's own email local-part. Neither it nor
        // the address may appear in a message to somebody who has not
        // accepted.
        assert.doesNotMatch(mailer.sent[0].text, new RegExp(SLUG));
        assert.doesNotMatch(mailer.sent[0].subject, new RegExp(SLUG));
    });

    test('an invitation cannot create an archive that does not exist', async () => {
        const store = memoryStore();
        const { token } = issueClaimToken({
            slug: 'nobody.here', key: KEY, expiresAt: '2026-12-01T00:00:00Z', purpose: PURPOSE.invite
        });
        await store.upsertEntity('invites', {
            partitionKey: 'nobody.here',
            rowKey: (await import('../src/lib/claimtoken.js')).claimTokenHash(token),
            email: READER,
            role: ROLE.reader,
            invitedBy: OWNER,
            expiresAt: '2026-12-01T00:00:00Z'
        });

        const result = await acceptInvite({ store, tables: store, token, key: KEY, principal: READER, now: NOW, log: silent });

        assert.equal(result.status, 'gone');
        assert.equal(store.json('config', 'nobody.here/acl.json'), null);
    });

    test('nothing an invitation writes can make somebody a verified missionary', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER, email: OTHER,
            role: ROLE.owner, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });
        const token = mailer.sent[0].text.match(/\/invite#(\S+)/)[1];
        await acceptInvite({ store, tables: store, token, key: KEY, principal: OTHER, now: NOW, log: silent });

        assert.equal(aclOf(store).find((m) => m.email === OTHER).verifiedMissionary, false);
    });
});

// --- the daily cap --------------------------------------------------------

// An owner can already mail these people themselves, so this is not about
// access. It is about what an owner's session -- borrowed, scripted, or just
// pasted into with a list far longer than intended -- can do to the sending
// domain's reputation before anybody notices.
describe('one site cannot mail the world in an afternoon', () => {
    const invite = (store, mailer, email, now = NOW) =>
        inviteMember({
            store, tables: store, mailer, slug: SLUG, actor: OWNER,
            email, key: KEY, baseUrl: BASE, now, log: silent
        });

    const fill = async (store, mailer, count, now = NOW) => {
        for (let i = 0; i < count; i++) await invite(store, mailer, `relative${i}@example.com`, now);
    };

    test('a real family fits inside the cap', async () => {
        // The failure worth caring about is not the attacker; it is the person
        // with a genuinely large family being told no. Twenty has to clear one
        // sitting, so the cap is asserted from below as well as above.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await fill(store, mailer, INVITES_PER_DAY);

        assert.equal(mailer.sent.length, INVITES_PER_DAY);
    });

    test('the next one is refused, and no mail leaves', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await fill(store, mailer, INVITES_PER_DAY);
        const over = await invite(store, mailer, 'one.too.many@example.com');

        assert.equal(over.error, 'too many invitations today, try again tomorrow');
        assert.equal(mailer.sent.length, INVITES_PER_DAY, 'the refusal is before the send, not after');
    });

    test('revoking does not buy another send', async () => {
        // The reason `revokeInvite` leaves a tombstone. If the cap counted
        // only surviving rows, invite/revoke/invite would be a loop with no
        // upper bound and the revoke button would be the exploit.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await fill(store, mailer, INVITES_PER_DAY);
        for (const pending of await listInvites({ tables: store, slug: SLUG, now: NOW })) {
            await revokeInvite({ tables: store, slug: SLUG, id: pending.id, now: NOW });
        }

        assert.deepEqual(await listInvites({ tables: store, slug: SLUG, now: NOW }), [], 'the owner sees them gone');

        const after = await invite(store, mailer, 'again@example.com');
        assert.equal(after.error, 'too many invitations today, try again tomorrow');
        assert.equal(mailer.sent.length, INVITES_PER_DAY);
    });

    test('tomorrow the allowance is back', async () => {
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();

        await fill(store, mailer, INVITES_PER_DAY);
        const tomorrow = () => new Date('2026-08-06T09:00:00Z');
        const next = await invite(store, mailer, 'tomorrow@example.com', tomorrow);

        assert.equal(next.ok, true);
        assert.equal(mailer.sent.length, INVITES_PER_DAY + 1);
    });

    test('a refusal that costs nothing does not spend the allowance', async () => {
        // Checked after the cheap refusals on purpose: a typo, or inviting
        // somebody who is already on the list, sends no mail and so has no
        // reputation cost to charge for.
        const store = await site([member(OWNER, ROLE.owner), member(READER, ROLE.reader)]);
        const mailer = recorder();

        for (let i = 0; i < 30; i++) {
            assert.equal((await invite(store, mailer, READER)).error, 'already a member');
            assert.equal((await invite(store, mailer, 'not-an-address')).error, 'not an email address');
        }

        assert.equal(mailer.sent.length, 0);
        assert.equal((await invite(store, mailer, OTHER)).ok, true);
    });

    test('the cap is per site, not per service', async () => {
        // Two families sharing one number would mean the quietest archive
        // being switched off by the busiest, which is a shared-fate failure
        // nobody could see the cause of.
        const store = await site([member(OWNER, ROLE.owner)]);
        const mailer = recorder();
        await store.writeBlob(
            'config',
            'sister.other/acl.json',
            Buffer.from(JSON.stringify({ slug: 'sister.other', members: [member(OWNER, ROLE.owner)] }), 'utf8'),
            { contentType: 'application/json' }
        );

        await fill(store, mailer, INVITES_PER_DAY);
        const elsewhere = await inviteMember({
            store, tables: store, mailer, slug: 'sister.other', actor: OWNER,
            email: OTHER, key: KEY, baseUrl: BASE, now: NOW, log: silent
        });

        assert.equal(elsewhere.ok, true);
    });
});

// --- the two kinds of link ------------------------------------------------

describe('a claim link and an invitation link are not interchangeable', () => {
    test('an invitation presented as a claim is refused by arithmetic', async () => {
        const { token } = issueClaimToken({
            slug: SLUG, key: KEY, expiresAt: '2026-12-01T00:00:00Z', purpose: PURPOSE.invite
        });

        const asClaim = verifyClaimToken({ token, key: KEY, now: NOW });

        assert.equal(asClaim.valid, false);
        assert.equal(asClaim.reason, 'wrong-purpose');
    });

    test('and a claim presented as an invitation, likewise', async () => {
        const { token } = issueClaimToken({ slug: SLUG, key: KEY, expiresAt: '2026-12-01T00:00:00Z' });

        const asInvite = verifyClaimToken({ token, key: KEY, purpose: PURPOSE.invite, now: NOW });

        assert.equal(asInvite.valid, false);
        assert.equal(asInvite.reason, 'wrong-purpose');
    });

    test('a token minted before purposes existed is still a claim', async () => {
        // Real links are in real mailboxes. Defaulting on the way out of
        // verification rather than requiring the field is what keeps them
        // working.
        const legacy = issueClaimToken({ slug: SLUG, key: KEY, expiresAt: '2026-12-01T00:00:00Z', purpose: undefined });

        assert.equal(verifyClaimToken({ token: legacy.token, key: KEY, now: NOW }).valid, true);
    });
});

// --- the address check ----------------------------------------------------

describe('what counts as an address', () => {
    test('ordinary ones pass, and are lowercased', () => {
        assert.equal(validEmail('  Grandma@Example.COM '), 'grandma@example.com');
    });

    test('the shapes that would break a header are refused', () => {
        for (const bad of ['', 'nobody', 'no@dots', 'two@@at.com', 'a b@c.com', 'a@b.com\nBcc: x@y.com']) {
            assert.equal(validEmail(bad), null, `${JSON.stringify(bad)} should not pass`);
        }
    });
});
