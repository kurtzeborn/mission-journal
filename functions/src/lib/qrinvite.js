// Short-lived, in-person invitations.
//
// A QR code shown at a family gathering is a bearer credential by design, but
// it must not become a photograph that grants access next week. The displayed
// token therefore lives for thirty seconds and can only be exchanged while an
// owner-controlled session is active. Exchange produces a per-browser,
// single-use ticket long enough to survive an OAuth round trip.
//
// The QR code is intentionally reader-only. Broadcasting ownership in a room
// would turn one accidental scan into permission to edit letters and invite
// others; an owner can promote a known reader afterwards from the People page.

import { randomBytes } from 'node:crypto';
import { ROLE, readAcl } from './acl.js';
import { claimTokenHash, issueClaimToken, PURPOSE, verifyClaimToken } from './claimtoken.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { recordMembership } from './memberships.js';
import { validSlug } from './paths.js';
import { sitesBySlug } from './sites.js';
import { TABLES } from './tables.js';

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
const lower = (value) => String(value ?? '').trim().toLowerCase();
const sessionId = () => randomBytes(24).toString('base64url');
const activeRow = (tables, slug) => tables.getEntity(TABLES.qrInvites, slug, 'active');
const redemptionPartition = (slug, id) => `${slug}:${id}`;

export const QR_CODE_SECONDS = 30;
export const QR_SESSION_IDLE_SECONDS = 90;
export const QR_TICKET_MINUTES = 10;
export const QR_SESSION_MAX_JOINS = 50;

const after = (at, milliseconds) => new Date(at.getTime() + milliseconds).toISOString();

async function owner({ store, slug, actor }) {
    const members = await readAcl(store, slug);
    if (!members) return { error: 'no such site' };

    const email = lower(actor);
    const member = members.find((candidate) => lower(candidate.email) === email);
    return member?.role === ROLE.owner ? { email } : { error: 'owners only' };
}

function live(row, id, at) {
    return Boolean(
        row &&
        row.sessionId === id &&
        !row.closedAt &&
        Date.parse(row.expiresAt) > at.getTime()
    );
}

function codeFor({ slug, id, key, baseUrl, now }) {
    const expiresAt = after(now, QR_CODE_SECONDS * 1000);
    const { token } = issueClaimToken({
        slug,
        key,
        expiresAt,
        purpose: PURPOSE.qrCode,
        subject: id
    });
    return {
        token,
        url: `${String(baseUrl).replace(/\/+$/, '')}/join#${token}`,
        expiresAt
    };
}

export async function startQrInvite({ store, tables, slug, actor, key, baseUrl, now = () => new Date() }) {
    const safe = validSlug(slug);
    if (!safe) return { error: 'no such site' };

    const mine = await owner({ store, slug: safe, actor });
    if (mine.error) return mine;

    const at = now();
    const id = sessionId();
    await tables.upsertEntity(TABLES.qrInvites, {
        partitionKey: safe,
        rowKey: 'active',
        sessionId: id,
        invitedBy: mine.email,
        createdAt: at.toISOString(),
        expiresAt: after(at, QR_SESSION_IDLE_SECONDS * 1000),
        closedAt: ''
    });

    return { ok: true, id, ...codeFor({ slug: safe, id, key, baseUrl, now: at }) };
}

export async function rotateQrInvite({
    store,
    tables,
    slug,
    actor,
    id,
    key,
    baseUrl,
    now = () => new Date()
}) {
    const safe = validSlug(slug);
    if (!safe) return { error: 'no such session' };

    const mine = await owner({ store, slug: safe, actor });
    if (mine.error) return mine;

    const at = now();
    const row = await activeRow(tables, safe);
    if (!live(row, String(id), at) || lower(row.invitedBy) !== mine.email) {
        return { error: 'no such session' };
    }

    await tables.upsertEntity(TABLES.qrInvites, {
        partitionKey: safe,
        rowKey: 'active',
        expiresAt: after(at, QR_SESSION_IDLE_SECONDS * 1000)
    });

    return { ok: true, id: String(id), ...codeFor({ slug: safe, id: String(id), key, baseUrl, now: at }) };
}

export async function closeQrInvite({ store, tables, slug, actor, id, now = () => new Date() }) {
    const safe = validSlug(slug);
    if (!safe) return { error: 'no such session' };

    const mine = await owner({ store, slug: safe, actor });
    if (mine.error) return mine;

    const row = await activeRow(tables, safe);
    if (!row || row.sessionId !== String(id) || lower(row.invitedBy) !== mine.email) {
        return { error: 'no such session' };
    }

    const at = now().toISOString();
    await tables.upsertEntity(TABLES.qrInvites, {
        partitionKey: safe,
        rowKey: 'active',
        closedAt: at,
        expiresAt: at
    });
    return { ok: true };
}

export async function exchangeQrInvite({ tables, token, key, now = () => new Date() }) {
    const at = now();
    const verified = verifyClaimToken({ token, key, purpose: PURPOSE.qrCode, now: () => at });
    if (!verified.valid) {
        return { status: verified.reason === 'expired' ? 'expired' : 'invalid' };
    }

    const slug = validSlug(verified.slug);
    const id = String(verified.subject ?? '');
    if (!slug || !id) return { status: 'invalid' };

    const row = await activeRow(tables, slug);
    if (!live(row, id, at)) return { status: 'closed' };

    const ticketExpiresAt = after(at, QR_TICKET_MINUTES * 60 * 1000);
    const { token: ticket } = issueClaimToken({
        slug,
        key,
        expiresAt: ticketExpiresAt,
        purpose: PURPOSE.qrTicket,
        subject: id
    });
    const sites = await sitesBySlug({ tables, slugs: [slug] });

    return {
        status: 'ready',
        ticket,
        invitedBy: row.invitedBy ?? '',
        missionary: sites.get(slug)?.missionaryDisplayName ?? '',
        expiresAt: ticketExpiresAt
    };
}

export async function acceptQrInvite({
    store,
    tables,
    ticket,
    key,
    principal,
    now = () => new Date(),
    log = console
}) {
    const email = lower(principal?.email ?? principal);
    if (!email) return { status: 'unauthenticated' };

    const at = now();
    const verified = verifyClaimToken({ token: ticket, key, purpose: PURPOSE.qrTicket, now: () => at });
    if (!verified.valid) {
        return { status: verified.reason === 'expired' ? 'expired' : 'invalid' };
    }

    const slug = validSlug(verified.slug);
    const id = String(verified.subject ?? '');
    if (!slug || !id) return { status: 'invalid' };

    const session = await activeRow(tables, slug);
    if (!live(session, id, at)) return { status: 'closed' };

    const redemptionKey = `ticket-${claimTokenHash(ticket)}`;
    const partitionKey = redemptionPartition(slug, id);
    const previous = await tables.getEntity(TABLES.qrRedemptions, partitionKey, redemptionKey);
    if (previous && lower(previous.acceptedBy) !== email) return { status: 'accepted', slug };

    if (previous?.completedAt) {
        const members = await readAcl(store, slug);
        return members?.some((member) => lower(member.email) === email)
            ? { status: 'ok', slug, role: ROLE.reader }
            : { status: 'accepted', slug };
    }

    if (!previous) {
        let reserved = false;
        for (let slot = 0; slot < QR_SESSION_MAX_JOINS; slot++) {
            const slotKey = `slot-${String(slot).padStart(2, '0')}`;
            reserved = await tables.insertEntities(TABLES.qrRedemptions, [
                {
                    partitionKey,
                    rowKey: slotKey,
                    ticketHash: redemptionKey,
                    acceptedBy: email,
                    reservedAt: at.toISOString()
                },
                {
                    partitionKey,
                    rowKey: redemptionKey,
                    slot: slotKey,
                    acceptedBy: email,
                    acceptedAt: at.toISOString(),
                    completedAt: ''
                }
            ]);
            if (reserved) break;

            const winner = await tables.getEntity(TABLES.qrRedemptions, partitionKey, redemptionKey);
            if (winner) {
                if (lower(winner.acceptedBy) !== email) return { status: 'accepted', slug };
                reserved = true;
                break;
            }
        }
        if (!reserved) return { status: 'full' };
    }

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const current = await store.readBlob('config', `${slug}/acl.json`);
        if (!current) return { status: 'gone', slug };

        const acl = JSON.parse(Buffer.from(current.bytes).toString('utf8'));
        const currentMembers = Array.isArray(acl.members) ? acl.members : [];
        if (!currentMembers.some(
            (member) => lower(member.email) === lower(session.invitedBy) && member.role === ROLE.owner
        )) {
            return { status: 'closed' };
        }
        if (currentMembers.some((member) => lower(member.email) === email)) break;

        const next = [
            ...currentMembers,
            {
                email,
                role: ROLE.reader,
                verifiedMissionary: false,
                addedAt: at.toISOString(),
                invitedBy: session.invitedBy ?? ''
            }
        ];

        try {
            await store.writeBlob('config', `${slug}/acl.json`, utf8({ ...acl, slug, members: next }), {
                contentType: 'application/json',
                ifMatch: current.etag
            });
            break;
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }

    await recordMembership({ tables, email, slug, role: ROLE.reader, now });
    await tables.upsertEntity(TABLES.qrRedemptions, {
        partitionKey,
        rowKey: redemptionKey,
        completedAt: at.toISOString()
    });
    log.info?.('qr-invite: accepted', { slug, invitedBy: session.invitedBy });
    return { status: 'ok', slug, role: ROLE.reader };
}
