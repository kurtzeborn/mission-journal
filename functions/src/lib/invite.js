// Inviting somebody onto an archive.
//
// The obvious implementation is to type an address and put it straight on the
// ACL. It is rejected here for a reason the claim flow already learned: the
// address a family *knows* for someone is very often not the address that
// person signs in with. A grandmother who has written from the same AOL
// address for twenty years may well have a Google account under something
// else entirely, and an ACL entry for the address the family typed would
// simply never match, silently, forever. The failure looks identical to "the
// service is broken".
//
// So an invitation is a link, exactly like a claim: it is mailed to the
// address the family knows, and it binds to whatever identity actually walks
// through it. The address is where the letter goes, not who the invitation is
// for.
//
// The cost is honest and worth stating: possession of the link is the
// credential, so anyone who reads that mailbox -- or is forwarded the mail --
// can take the seat. That is the same trade the claim link makes, mitigated
// the same three ways: it is single-use, it expires, and an owner can revoke
// it before it is used or remove the person after.
//
// Invitations live in a table rather than in `acl.json`, because a pending
// invitation is not access and must never be somewhere `resolveRole` can see
// it. The ACL is only written when somebody accepts.

import { ROLE, readAcl } from './acl.js';
import { claimTokenHash, issueClaimToken, PURPOSE, verifyClaimToken } from './claimtoken.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { inviteEmail } from './invitemail.js';
import { HUMAN_ADDRESS, mailFrom } from './mail.js';
import { recordMembership } from './memberships.js';
import { validSlug } from './paths.js';
import { sitesBySlug } from './sites.js';
import { TABLES } from './tables.js';
import { validEmail } from './members.js';

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
const lower = (value) => String(value ?? '').trim().toLowerCase();

// Shorter than a claim's sixty days, and deliberately. A claim link is the
// only route to letters that would otherwise be deleted, so it is generous.
// An invitation can be reissued in ten seconds by somebody who is already
// signed in, so the cheap thing is to let it lapse.
export const INVITE_DAYS = 14;

// Invitations one site may issue in a UTC day.
//
// This is a reputation control, not an access control -- the person hitting it
// is already an owner and could mail these people themselves. What it stops is
// an owner's session, borrowed or scripted, turning our sending domain into an
// open relay pointed at strangers. The arithmetic is the reason for the number:
// the sending plan includes 3,000 messages a month, so one site sustaining
// twenty a day would consume a fifth of it and be visible in the logs long
// before it was expensive. A hundred a day from one site would eat the lot.
//
// Twenty also has to clear a real family in one sitting, which is the failure
// worth caring about. The largest plausible list is a few dozen relatives, and
// somebody who genuinely has more can finish tomorrow.
export const INVITES_PER_DAY = 20;

const expiryFrom = (now) =>
    new Date(now().getTime() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString();

const utcDay = (value) => String(value ?? '').slice(0, 10);

// Counted across every row the day produced, including the revoked ones.
//
// That is the whole reason `revokeInvite` leaves a tombstone instead of
// deleting: a cap that counted only surviving rows would be reset by the
// revoke button, and invite/revoke/invite is a loop with no upper bound. The
// accepted and expired ones count too, for the same reason -- every row here
// represents a message that was already handed to the mail provider, and the
// provider does not care what happened to it afterwards.
const issuedToday = (rows, now) => {
    const today = utcDay(now().toISOString());
    return rows.filter((row) => utcDay(row.createdAt) === today).length;
};

/**
 * Mint an invitation and mail it.
 *
 * Returns before the ACL is touched, because it is not touched: nothing about
 * the archive changes until the link is followed.
 */
export async function inviteMember({
    store,
    tables,
    mailer,
    slug,
    actor,
    email,
    role = ROLE.reader,
    key,
    baseUrl,
    now = () => new Date(),
    log = console
}) {
    const safe = validSlug(slug);
    const them = validEmail(email);
    if (!safe) return { error: 'no such site' };
    if (!them) return { error: 'not an email address' };
    if (role !== ROLE.owner && role !== ROLE.reader) return { error: 'unknown role' };

    const members = await readAcl(store, safe);
    if (!members) return { error: 'no such site' };

    const me = lower(actor);
    const mine = members.find((m) => lower(m.email) === me);
    if (!mine || mine.role !== ROLE.owner) return { error: 'owners only' };

    // Not a hard error dressed up as one: the person asking wanted this
    // address to have access, and it does. Saying so is more useful than
    // sending a link that would do nothing.
    if (members.some((m) => lower(m.email) === them)) return { error: 'already a member' };

    // Checked after the cheap refusals, so a typo or a duplicate does not
    // spend somebody's daily allowance.
    //
    // Two requests in flight at once can each read the same count and both
    // pass, so the cap is an upper bound plus the concurrency, not an exact
    // one. Making it exact needs an atomic counter, and the thing being
    // defended -- a sending domain's reputation over a day -- is not sensitive
    // to being off by the handful of requests one person's browser can have
    // open. Stated rather than left for someone to discover.
    const issued = await tables.listEntities(TABLES.invites, { partitionKey: safe });
    if (issuedToday(issued, now) >= INVITES_PER_DAY) {
        log.warn?.('invite: daily cap reached', { slug: safe, cap: INVITES_PER_DAY });
        return { error: 'too many invitations today, try again tomorrow' };
    }

    const expiresAt = expiryFrom(now);
    const { token, hash } = issueClaimToken({
        slug: safe,
        key,
        expiresAt,
        purpose: PURPOSE.invite
    });

    await tables.upsertEntity(TABLES.invites, {
        partitionKey: safe,
        rowKey: hash,
        email: them,
        role,
        invitedBy: me,
        createdAt: now().toISOString(),
        expiresAt
    });

    const sites = await sitesBySlug({ tables, slugs: [safe] });
    const body = inviteEmail({
        baseUrl,
        token,
        invitedBy: me,
        missionary: sites.get(safe)?.missionaryDisplayName ?? '',
        role,
        expiresAt
    });

    const result = await mailer.send({
        from: mailFrom(HUMAN_ADDRESS),
        to: them,
        subject: body.subject,
        text: body.text,
        html: body.html,
        headers: { 'Auto-Submitted': 'auto-generated' },
        log
    });

    // The row stays whatever happened. An invitation that failed to send is
    // still an invitation somebody issued, it shows in the list as pending,
    // and the remedy -- revoke it and try another address -- is the same one
    // they would want if the mail simply went to spam.
    if (result.status !== 'sent') {
        log.error?.('invite: could not deliver', { slug: safe, status: result.status });
    }

    return { ok: true, slug: safe, email: them, role, expiresAt, delivery: result.status };
}

/**
 * Invitations issued for a site that nobody has accepted yet.
 *
 * The token hash is returned, because it is the only handle an owner has on a
 * specific invitation and it is not a credential: it is the SHA-256 of a
 * secret they do not hold, which is exactly why the table stores that rather
 * than the token.
 */
export async function listInvites({ tables, slug, now = () => new Date() }) {
    const safe = validSlug(slug);
    if (!safe) return [];

    const at = now().getTime();
    const rows = await tables.listEntities(TABLES.invites, { partitionKey: safe });

    return rows
        .filter((row) => !row.acceptedAt && !row.revokedAt && Date.parse(row.expiresAt) > at)
        .map((row) => ({
            id: row.rowKey,
            email: row.email,
            role: row.role,
            invitedBy: row.invitedBy ?? '',
            createdAt: row.createdAt ?? '',
            expiresAt: row.expiresAt ?? ''
        }))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Withdraw an invitation before anybody uses it.
 *
 * A tombstone rather than a delete. Two things rest on the row surviving: the
 * daily cap counts it, so revoking cannot buy another send; and the token stays
 * explicitly refused rather than merely unrecognised, which closes the gap
 * where a later row at the same hash could make a withdrawn link work again.
 *
 * The owner still sees it vanish -- `listInvites` filters tombstones out -- and
 * its holder still gets the same answer as for a link that never existed.
 */
export async function revokeInvite({ tables, slug, id, now = () => new Date() }) {
    const safe = validSlug(slug);
    if (!safe || !id) return { error: 'no such invitation' };

    const row = await tables.getEntity(TABLES.invites, safe, String(id));
    if (!row) return { error: 'no such invitation' };

    await tables.upsertEntity(TABLES.invites, {
        partitionKey: safe,
        rowKey: String(id),
        revokedAt: now().toISOString()
    });
    return { ok: true };
}

/**
 * What the landing page needs before anyone signs in.
 *
 * Deliberately thin. The holder of this link may be a stranger who was
 * forwarded it by mistake, so it says who invited them and whose archive it
 * is -- both of which they need in order to decide whether to accept -- and
 * nothing whatever about the letters.
 */
export async function describeInvite({ tables, token, key, now = () => new Date() }) {
    const verified = verifyClaimToken({ token, key, purpose: PURPOSE.invite, now });
    if (!verified.valid && verified.reason !== 'expired') {
        return { status: 'invalid' };
    }

    const slug = validSlug(verified.slug);
    if (!slug) return { status: 'invalid' };

    const row = await tables.getEntity(TABLES.invites, slug, claimTokenHash(token));
    // Revoked and never-existed are the same answer on purpose: an owner who
    // withdraws an invitation should not thereby confirm to its holder that it
    // was ever real. Checked before expiry for the same reason -- `expired`
    // offers the holder a reason to ask for another one.
    if (!row || row.revokedAt) return { status: 'invalid' };

    if (row.acceptedAt) return { status: 'accepted', slug };
    if (verified.reason === 'expired') return { status: 'expired', slug };

    const sites = await sitesBySlug({ tables, slugs: [slug] });

    return {
        status: 'ready',
        slug,
        role: row.role,
        invitedBy: row.invitedBy ?? '',
        missionary: sites.get(slug)?.missionaryDisplayName ?? '',
        expiresAt: row.expiresAt ?? ''
    };
}

/**
 * Spend the invitation and put the signed-in identity on the ACL.
 *
 * The order is the one `claim.js` argues for and for the same reason: mark the
 * invitation spent first, then grant. A crash between the two leaves an
 * invitation that cannot be replayed and a person who is not on the ACL --
 * recoverable by an owner in one click. The other order leaves a link that
 * grants access every time it is opened.
 */
export async function acceptInvite({
    store,
    tables,
    token,
    key,
    principal,
    now = () => new Date(),
    log = console
}) {
    const email = lower(principal);
    if (!email) return { status: 'unauthenticated' };

    const described = await describeInvite({ tables, token, key, now });
    if (described.status !== 'ready') {
        // Our own retry, by the same person, is not a refusal. Anyone else
        // presenting a spent invitation is.
        if (described.status !== 'accepted') return described;
    }

    const slug = validSlug(described.slug);
    if (!slug) return { status: 'invalid' };

    const hash = claimTokenHash(token);
    const at = now().toISOString();

    // --- 1. spend --------------------------------------------------------
    const row = await tables.getEntity(TABLES.invites, slug, hash);
    // Re-read rather than trusting the describe above, because the two are
    // separate round trips and an owner may have revoked it in between.
    if (!row || row.revokedAt) return { status: 'invalid' };
    if (row.acceptedAt && lower(row.acceptedBy) !== email) return { status: 'accepted', slug };

    if (!row.acceptedAt) {
        await tables.upsertEntity(TABLES.invites, {
            partitionKey: slug,
            rowKey: hash,
            acceptedAt: at,
            acceptedBy: email
        });
    }

    const role = row.role === ROLE.owner ? ROLE.owner : ROLE.reader;

    // --- 2. grant --------------------------------------------------------
    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const existing = await store.readBlob('config', `${slug}/acl.json`);
        // No ACL means no site to join. An invitation cannot create one --
        // only a claim can, and the difference is that a claim proves
        // something about the letters while this proves only that somebody
        // sent you a link.
        if (!existing) return { status: 'gone', slug };

        const acl = JSON.parse(Buffer.from(existing.bytes).toString('utf8'));
        const members = Array.isArray(acl.members) ? acl.members : [];

        // Already there. Either their own retry, or an owner added them by
        // some other route while this was in flight; either way the desired
        // state has arrived and rewriting it would only move `addedAt`.
        if (members.some((m) => lower(m.email) === email)) break;

        const next = [
            ...members,
            {
                email,
                role,
                // Never true here, and it is worth saying so where somebody
                // might be tempted to plumb it through: this flag is set by
                // control of the mission mailbox and by nothing else.
                verifiedMissionary: false,
                addedAt: at,
                invitedBy: row.invitedBy ?? ''
            }
        ];

        try {
            await store.writeBlob('config', `${slug}/acl.json`, utf8({ ...acl, slug, members: next }), {
                contentType: 'application/json',
                ifMatch: existing.etag
            });
            break;
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }

    // --- 3. index --------------------------------------------------------
    await recordMembership({ tables, email, slug, role, now });

    log.info?.('invite: accepted', { slug, role });
    return { status: 'ok', slug, role };
}
