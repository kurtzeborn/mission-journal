// Who else may read this archive, and who may say so.
//
// `acl.json` has been written by exactly two paths until now, both of them
// creating it: a claim link redeemed, and a missionary proving control of
// their mission mailbox. Neither has ever had to modify one that already
// exists, which is why an archive has had an audience of one.
//
// This is the module that changes it, and the whole of the policy lives here
// rather than in the endpoints, because the rules are about the *shape of the
// resulting ACL* rather than about any one request:
//
//   **Owners act; readers do not.** Enforced by the endpoint, because it is
//   the same question every other write endpoint asks.
//
//   **Nobody may act on their own membership.** Not removal, not a change of
//   role. Two reasons, and the second is the load-bearing one: an owner who
//   demotes themselves by accident cannot undo it, and -- because every other
//   removal is somebody removing *someone else* -- this single rule is also
//   what guarantees an archive can never reach zero owners. There is no
//   separate "last owner" check anywhere in this file; there does not need to
//   be one.
//
//   **A verified missionary owner cannot be removed or demoted.** By anyone,
//   including another owner. This is the flag `claim.js` describes as
//   conferring removal protection, and this is the file that finally confers
//   it. It is the answer to the squatting problem the bootstrap path opened:
//   anyone who received a letter can start an archive, so the missionary must
//   be able to take it back, and "take it back" is worth nothing if the
//   squatter can simply remove them again.
//
// The ACL is read, modified and written under an ETag, and the actor's own
// right to act is re-checked *inside* the retry loop rather than before it.
// That is not ceremony: two owners removing each other at the same moment is
// a real sequence, and on the retry the loser may no longer be an owner.

import { readAcl, ROLE } from './acl.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { deliveryTrouble } from './delivery.js';
import { forgetMembership, recordMembership } from './memberships.js';
import { validSlug } from './paths.js';

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
const lower = (email) => String(email ?? '').trim().toLowerCase();

const ACL = (slug) => `${slug}/acl.json`;

/**
 * Not validation of a person -- validation of a string we are about to put in
 * an ACL and mail to. Deliberately loose about what an address may contain
 * and strict about what it may not: no spaces, exactly one `@`, something on
 * both sides, and a length a header can carry.
 */
export const validEmail = (value) => {
    const email = lower(value);
    if (!email || email.length > 254) return null;
    if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
    return email;
};

/**
 * Everyone currently on the ACL.
 *
 * `you` is marked rather than filtered out, because the page has to render the
 * actor's own row -- with its controls disabled -- instead of leaving them
 * wondering why they are missing from a list they are looking at.
 *
 * `tables` is optional and the delivery annotation is simply absent without
 * it. This list is how an owner sees who can read the archive, and that has to
 * keep working when the side table telling them whose mail is bouncing does
 * not.
 */
export async function listMembers({ store, tables = null, slug, actor, log = console }) {
    const safe = validSlug(slug);
    if (!safe) return null;

    const members = await readAcl(store, safe);
    if (!members) return null;

    const trouble = await deliveryTrouble({ tables, emails: members.map((m) => m.email), log });

    const me = lower(actor);
    return members.map((m) => ({
        email: lower(m.email),
        role: m.role,
        verifiedMissionary: Boolean(m.verifiedMissionary),
        addedAt: m.addedAt ?? '',
        // Only when it differs from the address they ended up signing in with.
        // Echoing the same string twice tells the owner nothing and makes the
        // row harder to read, and the row's job is to be checkable at a glance
        // before somebody presses Remove.
        invitedEmail: lower(m.invitedEmail) === lower(m.email) ? '' : lower(m.invitedEmail),
        you: lower(m.email) === me,
        // Empty when the last thing we sent them arrived, which is almost
        // always. See delivery.js.
        delivery: trouble.get(lower(m.email))?.status ?? '',
        deliveryAt: trouble.get(lower(m.email))?.at ?? '',
        // Precomputed rather than left to the client. The client may not
        // reimplement the policy -- it would drift, and it would drift in the
        // direction of showing a button that then fails.
        removable: lower(m.email) !== me && !m.verifiedMissionary
    }));
}

/**
 * The rules, in one place, evaluated against one snapshot of the ACL.
 *
 * Returns an error string or null. Separated from the write loop so that the
 * same decision can be re-made on every retry against whatever the ACL turned
 * out to be that time.
 */
function refuse({ members, actor, subject, role }) {
    const me = lower(actor);
    const them = lower(subject);

    const mine = members.find((m) => lower(m.email) === me);
    if (!mine || mine.role !== ROLE.owner) return 'owners only';

    if (me === them) return 'you cannot change your own membership';

    const target = members.find((m) => lower(m.email) === them);
    if (!target) return 'not a member';

    if (target.verifiedMissionary) return 'the verified missionary cannot be changed';

    if (role !== undefined && role !== ROLE.owner && role !== ROLE.reader) return 'unknown role';

    return null;
}

/**
 * Apply one change to the ACL and mirror it into the membership index.
 *
 * `mutate` returns the next members array, or an error. Everything that makes
 * this correct rather than merely working is here: the read is inside the
 * loop, the policy is re-evaluated against what was read, and the write is
 * conditional on the ETag that read produced.
 */
async function commitAcl({ store, tables, slug, actor, subject, role, mutate, now, log }) {
    const safe = validSlug(slug);
    const them = validEmail(subject);
    if (!safe) return { error: 'no such site' };
    if (!them) return { error: 'not an email address' };

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const existing = await store.readBlob('config', ACL(safe));
        if (!existing) return { error: 'no such site' };

        const acl = JSON.parse(Buffer.from(existing.bytes).toString('utf8'));
        const members = Array.isArray(acl.members) ? acl.members : [];

        const refusal = refuse({ members, actor, subject: them, role });
        if (refusal) return { error: refusal };

        const next = mutate(members, them);
        if (next.error) return next;

        try {
            await store.writeBlob('config', ACL(safe), utf8({ ...acl, slug: safe, members: next.members }), {
                contentType: 'application/json',
                ifMatch: existing.etag
            });
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
            continue;
        }

        // The ACL is the authority and it has already changed hands. The index
        // is repaired afterwards and never before -- if this half fails, the
        // person's access is correct and only their site list is stale, which
        // is the direction `memberships.js` is written to fail in.
        try {
            if (next.forget) {
                await forgetMembership({ tables, email: them, slug: safe });
            } else {
                await recordMembership({ tables, email: them, slug: safe, role: next.role, now });
            }
        } catch (error) {
            log?.error?.('members: acl changed but the index did not', {
                slug: safe,
                error: error.message
            });
        }

        return { ok: true, slug: safe, email: them };
    }

    return { error: 'too much happening at once, try again' };
}

/**
 * Take someone off an archive.
 *
 * Their letters are untouched: this removes access, not history. Nothing is
 * emailed to them either, and that is deliberate -- being told you have been
 * removed from a family's archive is a message the family should get to write
 * themselves, if they write one at all.
 */
export async function removeMember({ store, tables, slug, actor, email, now, log }) {
    return commitAcl({
        store, tables, slug, actor, subject: email, now, log,
        mutate: (members, them) => ({
            members: members.filter((m) => lower(m.email) !== them),
            forget: true
        })
    });
}

/**
 * Promote a reader to owner, or demote an owner to reader.
 *
 * One function rather than two, because they are the same write with a
 * different value and every rule that governs one governs the other.
 */
export async function setMemberRole({ store, tables, slug, actor, email, role, now, log }) {
    return commitAcl({
        store, tables, slug, actor, subject: email, role, now, log,
        mutate: (members, them) => ({
            members: members.map((m) =>
                lower(m.email) === them ? { ...m, role } : m
            ),
            role
        })
    });
}
