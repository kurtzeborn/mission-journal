// The ingest pipeline: one raw message in the inbox becomes one post.
//
// Nothing in this file talks to Azure. Every side effect goes through the
// `store` it is handed, so the whole pipeline — including the concurrency
// retry, which is the part most likely to be wrong — can be exercised against
// an in-memory fake and real fixture mail.

import { extractOriginal } from './extract.js';
import { classify, aclSlugFor, CLASS, DISPOSITION } from './classify.js';
import { dedupeKey, findDuplicate, bodyHead100, normalizeSubject } from './dedupe.js';
import { rfc3339InOwnOffset, dayInOwnOffset } from './dates.js';
import { attachmentPath, msgIdSegment, validSlug } from './paths.js';

// Cloudflare refuses messages over 25 MiB at SMTP time, so anything larger
// than that in the inbox did not come from the mail path and is not a letter.
// The cap is applied before the parse call, not after: a MIME parser fed
// untrusted input is an attack surface, and the cheapest defence is not
// running it.
export const MAX_RAW_BYTES = 26 * 1024 * 1024;

const CONFLICT_RETRIES = 8;

const isConflict = (err) =>
    err?.statusCode === 412 ||
    err?.statusCode === 409 ||
    err?.code === 'ConditionNotMet' ||
    err?.code === 'BlobAlreadyExists';

const KEPT_HEADERS = new Set([
    'authentication-results',
    'received-spf',
    'dkim-signature',
    'arc-authentication-results',
    'from',
    'to',
    'cc',
    'date',
    'subject',
    'message-id',
    'in-reply-to',
    'references'
]);

const headerSubset = (headers) =>
    (headers ?? [])
        .filter((h) => KEPT_HEADERS.has(h.key))
        .map((h) => ({ key: h.key, value: h.value }));

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');

// The identifier a reader sees in a URL. The date makes it legible and sorts
// naturally; the hash suffix keeps two letters written the same day apart.
const postIdFor = (day, msgId) => `${day ?? 'undated'}-${msgId.slice(-4)}`;

/**
 * @param {object} input
 * @param {string} input.ulid          the inbox blob the queue message named
 * @param {object} input.store         see store.js for the required shape
 * @param {object} input.config        { authservId, missionaryDomains, maxRawBytes? }
 * @param {object} [input.log]         { info, warn, error }
 * @param {function} [input.now]       injectable clock
 * @param {function} [input.verifyDkim] async (extracted) => boolean
 */
export async function runIngest({
    ulid,
    store,
    config,
    log = console,
    now = () => new Date(),
    verifyDkim = async () => false
}) {
    const rawName = `${ulid}.raw`;
    const blob = await store.readBlob('inbox', rawName);

    // The inbox has a 30-day lifecycle rule, so a queue message that outlives
    // its blob is expected rather than exceptional. There is nothing to
    // recover, and failing would only send it to the poison queue.
    if (!blob) {
        log.warn?.('ingest: raw blob absent', { ulid });
        return { status: 'missing', ulid };
    }

    const raw = blob.bytes;
    const maxBytes = config.maxRawBytes ?? MAX_RAW_BYTES;
    if (raw.length > maxBytes) {
        log.warn?.('ingest: rejected', { ulid, reason: 'oversize', bytes: raw.length });
        return { status: 'rejected', ulid, reason: 'oversize' };
    }

    const envelope = {
        to: decodeMeta(blob.metadata?.envelopeto),
        from: decodeMeta(blob.metadata?.envelopefrom)
    };

    const extracted = await extractOriginal(raw);

    const aclSlug = aclSlugFor({ extracted, config });
    const acl = aclSlug ? await readAcl(store, aclSlug) : null;

    const verdict = classify({
        extracted,
        headers: extracted.headers,
        config,
        lookupAcl: () => acl,
        dkimVerified: extracted.source === 'rfc822' ? await verifyDkim(extracted) : false
    });

    if (verdict.class === CLASS.rejected) {
        logRejection({ log, config, ulid, extracted, verdict, now });
        return { status: 'rejected', ulid, reason: verdict.reason };
    }

    // The slug reaches a blob path, so it is validated rather than trusted
    // even though it was derived from a DMARC-authenticated address.
    const slug = validSlug(verdict.slug);
    if (!slug) {
        log.warn?.('ingest: rejected', { ulid, reason: 'invalid-slug', slug: verdict.slug });
        return { status: 'rejected', ulid, reason: 'invalid-slug' };
    }

    const original = extracted.original ?? {};
    const msgId = msgIdSegment(original.messageId, ulid);

    // An inline forward has only what the client rendered — no offset, often
    // no seconds — so its date is a floating local time. An extracted or
    // direct message has the real header, offset intact.
    const dateSource = original.dateHeader ?? original.dateText ?? null;
    const originalDate = rfc3339InOwnOffset(dateSource);
    const day = dayInOwnOffset(dateSource);

    const candidate = dedupeKey({
        messageId: original.messageId,
        from: original.from,
        dateHeader: dateSource,
        subject: original.subject ?? extracted.outerSubject,
        text: original.text
    });

    const receivedAt = now().toISOString();
    const post = {
        id: postIdFor(day, msgId),
        extractionSource: extracted.source,
        originalDate,
        receivedAt,
        subject: original.subject ?? extracted.outerSubject ?? '',
        bodyHtml: original.html ?? null,
        bodyText: original.html ? null : (original.text ?? null),
        bodyHead100: candidate.head,
        hidden: verdict.disposition === DISPOSITION.hold,
        heldReason: verdict.reason ?? null,
        editedBy: null,
        editedAt: null,
        originalMessageId: original.messageId ?? null,
        originalFrom: original.from ?? null,
        forwardedBy: verdict.forwarder ?? null,
        photos: [],
        sourceRawPath: `raw/${slug}/${msgId}/message.eml`
    };

    const committed = await commitPost({ store, slug, post, candidate, log, ulid });
    if (committed.status !== 'stored') return { ...committed, ulid, slug };

    await writeRaw({ store, slug, msgId, raw, extracted, envelope, ulid, receivedAt, verdict });

    // Render is enqueued only after the archive exists, so a render can never
    // reference bytes that were never written.
    await store.enqueue('render', JSON.stringify({ slug, msgId, postId: post.id }));

    log.info?.('ingest: stored', {
        ulid,
        slug,
        msgId,
        postId: post.id,
        class: verdict.class,
        disposition: verdict.disposition,
        extractionSource: extracted.source,
        attachments: extracted.attachments.length
    });

    return { status: 'stored', ulid, slug, msgId, postId: post.id, post, verdict };
}

// Read-modify-write against posts.json under an ETag. The dedupe check happens
// inside the loop, not before it: two forwards of the same letter arriving at
// once would both pass a check made outside, and only one of them would lose
// the write race.
async function commitPost({ store, slug, post, candidate, log, ulid }) {
    const name = `${slug}/posts.json`;

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const current = await store.readBlob('rendered', name);
        const posts = current ? JSON.parse(Buffer.from(current.bytes).toString('utf8')) : [];

        const duplicate = findDuplicate(candidate, posts);
        if (duplicate) {
            log.info?.('ingest: duplicate', {
                ulid,
                slug,
                reason: duplicate.reason,
                existingPostId: duplicate.post.id
            });
            return { status: 'duplicate', reason: duplicate.reason, postId: duplicate.post.id };
        }

        // Two letters written the same day can collide on the legible part of
        // the id; the suffix is what actually distinguishes them, so a
        // collision means only that the id needs another character.
        if (posts.some((p) => p.id === post.id)) post.id = `${post.id}-${posts.length}`;

        posts.push(post);

        try {
            await store.writeBlob('rendered', name, utf8(posts), {
                contentType: 'application/json',
                // On the very first message the blob does not exist yet, and
                // If-None-Match: * is what makes that first write safe against
                // a second message racing it.
                ...(current ? { ifMatch: current.etag } : { ifNoneMatch: '*' })
            });
            return { status: 'stored' };
        } catch (err) {
            if (!isConflict(err)) throw err;
            log.info?.('ingest: posts.json conflict, retrying', { ulid, slug, attempt });
        }
    }

    // Losing eight races in a row is not contention, it is a bug or a stuck
    // writer. Throwing sends the message back to the queue and eventually to
    // the poison queue, where it is visible, rather than dropping a letter.
    throw new Error(`posts.json contention for ${slug} after ${CONFLICT_RETRIES} attempts`);
}

async function writeRaw({ store, slug, msgId, raw, extracted, envelope, ulid, receivedAt, verdict }) {
    const prefix = `${slug}/${msgId}`;

    await store.writeBlob('raw', `${prefix}/message.eml`, raw, {
        contentType: 'message/rfc822'
    });

    const record = [];
    for (const [i, part] of [...extracted.attachments, ...extracted.inlineImages].entries()) {
        const bytes = Buffer.from(part.content);
        const path = attachmentPath(i, part.filename);
        await store.writeBlob('raw', `${prefix}/attachments/${path}`, bytes, {
            contentType: part.mimeType ?? 'application/octet-stream'
        });
        record.push({
            index: i,
            path: `attachments/${path}`,
            // The filename exactly as it arrived, kept for display. It has not
            // been sanitized and must be treated as untrusted wherever it is
            // rendered.
            filename: part.filename ?? null,
            mimeType: part.mimeType ?? null,
            bytes: bytes.length,
            inline: Boolean(part.contentId) && extracted.inlineImages.includes(part)
        });
    }

    await store.writeBlob('raw', `${prefix}/metadata.json`, utf8({
        ulid,
        ingestedAt: receivedAt,
        envelope,
        extractionSource: extracted.source,
        embeddedPartType: extracted.embeddedPartType,
        sender: extracted.sender,
        forwarder: extracted.forwarder,
        class: verdict.class,
        disposition: verdict.disposition,
        original: {
            from: extracted.original?.from ?? null,
            subject: extracted.original?.subject ?? null,
            dateHeader: extracted.original?.dateHeader ?? null,
            dateText: extracted.original?.dateText ?? null,
            datePrecision: extracted.original?.datePrecision ?? null,
            messageId: extracted.original?.messageId ?? null
        },
        outerSubject: extracted.outerSubject,
        attachments: record,
        headers: headerSubset(extracted.headers)
    }), { contentType: 'application/json' });
}

// acl.json is an object with a `members` array, not a bare array — that is
// what infra/seed-config.ps1 writes and what the Phase 7 claim flow will
// write. Read it in exactly one shape: a forgiving parser that also accepted a
// bare array would let the two formats drift apart silently, and a
// mis-parsed ACL fails closed as `unknown-slug`, which is indistinguishable
// from spam in the logs.
async function readAcl(store, slug) {
    const safe = validSlug(slug);
    if (!safe) return null;
    const blob = await store.readBlob('config', `${safe}/acl.json`);
    if (!blob) return null;
    const parsed = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
    return Array.isArray(parsed?.members) ? parsed.members : null;
}

// Rejections are logged without any body text: the whole point of rejecting a
// message is that we have no permission to keep it. A message whose From:
// domain is a missionary domain logs at warning level with the provider's
// verdict verbatim, because that is a letter we failed to deliver and someone
// has to be able to find out why.
function logRejection({ log, config, ulid, extracted, verdict, now }) {
    const domains = (config.missionaryDomains ?? []).map((d) => d.toLowerCase());
    const from = extracted.sender ?? extracted.original?.from ?? '';
    const domain = from.slice(from.lastIndexOf('@') + 1).toLowerCase();

    const entry = {
        ulid,
        at: now().toISOString(),
        sender: extracted.sender ?? null,
        subject: extracted.outerSubject ?? null,
        reason: verdict.reason
    };

    if (domains.includes(domain)) {
        const auth = (extracted.headers ?? [])
            .filter((h) => h.key === 'authentication-results')
            .map((h) => h.value);
        log.warn?.('ingest: rejected message from a missionary domain', { ...entry, auth });
        return;
    }

    log.info?.('ingest: rejected', entry);
}

// The Worker percent-encodes envelope addresses, because blob metadata values
// must be ASCII and an address can carry anything SMTP allowed through.
function decodeMeta(value) {
    if (!value) return null;
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export { normalizeSubject, bodyHead100 };
