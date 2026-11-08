// Short-lived, in-person invitations.
//
// Showing a QR code in a room is a way to add readers without typing email
// addresses or waiting for messages to arrive. A single short random code
// represents the open Quick Join window in `qrInvites`: it works while the
// owner keeps the window open (plus a short grace period after closing so
// anyone halfway through provider sign-in can finish), and reopening Quick
// Join replaces the active code immediately.
//
// The QR code is intentionally reader-only. Broadcasting ownership in a room
// would turn one accidental scan into permission to edit letters and invite
// others; an owner can promote a known reader afterwards from the People page.

import { randomBytes } from 'node:crypto';
import { ROLE, isOwner, requireOwner } from './acl.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { recordMembership } from './memberships.js';
import { validSlug } from './paths.js';
import { sitesBySlug } from './sites.js';
import { TABLES } from './tables.js';
import { userNameFor } from './userprofile.js';

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
const lower = (value) => String(value ?? '').trim().toLowerCase();
const newCode = () => randomBytes(12).toString('base64url');
const activeRow = (tables, slug) => tables.getEntity(TABLES.qrInvites, slug, 'active');
const codeRow = (tables, code) => tables.getEntity(TABLES.qrInvites, 'code', code);

export const QR_SESSION_MINUTES = 15;
export const QR_CLOSE_GRACE_SECONDS = 120;

const after = (at, milliseconds) => new Date(at.getTime() + milliseconds).toISOString();

function live(row, id, at) {
    return Boolean(
        row &&
        row.sessionId === id &&
        !row.closedAt &&
        Date.parse(row.expiresAt) > at.getTime()
    );
}

// Closing stops new scans immediately, but somebody who already scanned may
// be halfway through provider sign-in. Give that in-flight sign-in a short
// landing window rather than making the owner reopen the dialog and start them
// over.
function accepting(row, id, at) {
    if (live(row, id, at)) return true;
    if (!row || row.sessionId !== id || !row.closedAt) return false;
    return Date.parse(row.closedAt) + QR_CLOSE_GRACE_SECONDS * 1000 > at.getTime();
}

export async function startQrInvite({ store, tables, slug, actor, baseUrl, now = () => new Date() }) {
    const safe = validSlug(slug);
    if (!safe) return { error: 'no such site' };

    const mine = await requireOwner({ store, slug: safe, actor });
    if (mine.error) return mine;

    const at = now();
    const token = newCode();
    const createdAt = at.toISOString();
    const expiresAt = after(at, QR_SESSION_MINUTES * 60 * 1000);

    await Promise.all([
        tables.upsertEntity(TABLES.qrInvites, {
            partitionKey: 'code',
            rowKey: token,
            slug: safe,
            invitedBy: mine.email,
            createdAt,
            expiresAt
        }),
        tables.upsertEntity(TABLES.qrInvites, {
            partitionKey: safe,
            rowKey: 'active',
            sessionId: token,
            invitedBy: mine.email,
            createdAt,
            expiresAt,
            closedAt: ''
        })
    ]);

    return {
        ok: true,
        id: token,
        token,
        url: `${String(baseUrl).replace(/\/+$/, '')}/join#${token}`,
        expiresAt
    };
}

export async function closeQrInvite({ store, tables, slug, actor, id, now = () => new Date() }) {
    const safe = validSlug(slug);
    if (!safe) return { error: 'no such session' };

    const mine = await requireOwner({ store, slug: safe, actor });
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

export async function exchangeQrInvite({ tables, token, now = () => new Date() }) {
    const code = String(token ?? '').trim();
    if (!code) return { status: 'invalid' };

    const lookup = await codeRow(tables, code);
    const slug = validSlug(lookup?.slug);
    if (!slug) return { status: 'invalid' };

    const at = now();
    const row = await activeRow(tables, slug);
    if (!row || row.sessionId !== code || row.closedAt) return { status: 'closed' };
    if (Date.parse(row.expiresAt) <= at.getTime()) return { status: 'expired' };

    const [sites, inviterName] = await Promise.all([
        sitesBySlug({ tables, slugs: [slug] }),
        userNameFor({ tables, email: row.invitedBy })
    ]);

    return {
        status: 'ready',
        token: code,
        ticket: code,
        invitedBy: row.invitedBy ?? '',
        invitedByName: inviterName,
        missionary: sites.get(slug)?.missionaryDisplayName ?? '',
        expiresAt: row.expiresAt
    };
}

export async function acceptQrInvite({
    store,
    tables,
    token,
    ticket,
    principal,
    now = () => new Date(),
    log = console
}) {
    const email = lower(principal?.email ?? principal);
    if (!email) return { status: 'unauthenticated' };

    const code = String(token || ticket || '').trim();
    if (!code) return { status: 'invalid' };

    const lookup = await codeRow(tables, code);
    const slug = validSlug(lookup?.slug);
    if (!slug) return { status: 'invalid' };

    const at = now();
    const session = await activeRow(tables, slug);
    if (!session || session.sessionId !== code) return { status: 'closed' };
    if (!session.closedAt && Date.parse(session.expiresAt) <= at.getTime()) {
        return { status: 'expired' };
    }
    if (!accepting(session, code, at)) return { status: 'closed' };

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const current = await store.readBlob('config', `${slug}/acl.json`);
        if (!current) return { status: 'gone', slug };

        const acl = JSON.parse(Buffer.from(current.bytes).toString('utf8'));
        const currentMembers = Array.isArray(acl.members) ? acl.members : [];
        if (!isOwner(currentMembers, session.invitedBy)) {
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
    log.info?.('qr-invite: accepted', { slug, invitedBy: session.invitedBy });
    return { status: 'ok', slug, role: ROLE.reader };
}
