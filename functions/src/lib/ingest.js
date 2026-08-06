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
import { redactAccessLinks, sanitizeBody } from './sanitize.js';
import { linkedPhotoServices } from './photolinks.js';
import { verifyEmbeddedDkim } from './dkim.js';
import { readAcl } from './acl.js';
import { holdPending } from './pending.js';
import { offerClaim } from './offer.js';
import { nudgeOnce, NUDGE } from './nudge.js';
import { RELAY_TTL_DAYS } from './relay.js';
import { issueClaimToken, PURPOSE } from './claimtoken.js';
import { addressedToClaim, isClaimVerb, recipientVerbs, runClaimVerb } from './claimverb.js';
import { touchSiteActivity } from './sites.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { domainOf } from './authresults.js';

// Cloudflare refuses messages over 25 MiB at SMTP time, so anything larger
// than that in the inbox did not come from the mail path and is not a letter.
// The cap is applied before the parse call, not after: a MIME parser fed
// untrusted input is an attack surface, and the cheapest defence is not
// running it.
export const MAX_RAW_BYTES = 26 * 1024 * 1024;

/**
 * The envelope recipients, as domains.
 *
 * Cloudflare hands one recipient per event, but the metadata is a header value
 * and a header can carry a list, so this reads a list and happens to cope with
 * one.
 */
export const recipientDomains = (to) =>
    String(to ?? '')
        .split(',')
        .map((address) => domainOf(address.trim()))
        .filter(Boolean);

/**
 * Whether a message was addressed to a domain this service ingests for.
 *
 * Defence in depth, not the primary control: what actually reaches the Worker
 * is decided by Cloudflare's routing rules, and today exactly one zone points
 * at it. This exists so that pointing a second domain at the same Worker — by
 * accident, or by someone else — is a rejection rather than a publication.
 *
 * **Fails open in both directions**, deliberately. An unset list accepts
 * everything, so the check cannot switch itself on through a missing app
 * setting. An unreadable recipient also accepts, because the alternative is
 * dropping a real letter over a metadata field that has never been load-bearing
 * before, and the cost of those two failures is not remotely symmetrical: a
 * letter published from an unexpected domain is visible and reversible, and a
 * letter silently discarded is gone.
 */
export const acceptedRecipient = (to, accepted) => {
    if (!accepted?.length) return true;

    const domains = recipientDomains(to);
    if (!domains.length) return true;

    return domains.some((domain) => accepted.includes(domain));
};

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

const headerValue = (headers, key) => (headers ?? []).find((h) => h.key === key)?.value ?? '';

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');

// The identifier a reader sees in a URL. The date makes it legible and sorts
// naturally; the hash suffix keeps two letters written the same day apart.
const postIdFor = (day, msgId) => `${day ?? 'undated'}-${msgId.slice(-4)}`;

/**
 * The link that offers to ask the missionary, signed so the endpoint behind it
 * never has to take a caller's word for who is being written to or for whom.
 *
 * Returns an empty string rather than throwing when there is no signing key.
 * A misconfigured key must cost the second route in a piece of advice, not the
 * advice itself -- the first route works without us.
 */
function relayUrl({ slug, verdict, config, now }) {
    if (!config.claimTokenKey || !verdict.author || !verdict.sender) return '';
    try {
        const expiresAt = new Date(now().getTime() + RELAY_TTL_DAYS * 86400_000).toISOString();
        const { token } = issueClaimToken({
            slug,
            key: config.claimTokenKey,
            expiresAt,
            purpose: PURPOSE.relay,
            subject: verdict.author,
            recipient: verdict.sender
        });
        // In the fragment, like every other link this service sends: a token in
        // a query string is in a server log before anybody has decided it
        // should be.
        return `${String(config.baseUrl ?? '').replace(/\/$/, '')}/ask#${token}`;
    } catch {
        return '';
    }
}

/**
 * @param {object} input
 * @param {string} input.ulid          the inbox blob the queue message named
 * @param {object} input.store         see store.js for the required shape
 * @param {object} [input.mailer]      from mail.js; omitted means nothing is offered
 * @param {object} input.config        { authservId, missionaryDomains, maxRawBytes? }
 * @param {object} [input.log]         { info, warn, error }
 * @param {function} [input.now]       injectable clock
 * @param {function} [input.verifyDkim] async (extracted) => { verified, reason, signatures }
 */
export async function runIngest({
    ulid,
    store,
    tables = null,
    mailer = null,
    config,
    log = console,
    now = () => new Date(),
    verifyDkim = verifyEmbeddedDkim
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

    if (!acceptedRecipient(envelope.to, config.acceptedIngestDomains)) {
        log.warn?.('ingest: rejected', {
            ulid,
            reason: 'recipient-domain',
            domains: recipientDomains(envelope.to)
        });
        return { status: 'rejected', ulid, reason: 'recipient-domain' };
    }

    // The verb, read before anything is parsed.
    //
    // `claim@` and `post@` are routed to the same Worker and arrive through the
    // same queue, and until this branch existed the recipient's local-part was
    // never looked at: `acceptedRecipient` checks only the domain. So a
    // missionary emailing `claim@` to ask for control of their site had that
    // message classified `direct` and published to their own archive.
    //
    // This has to happen here rather than inside `classify`, which is the
    // natural-looking home for it. `classify` runs on the output of
    // `extractOriginal`, and the whole point of the claim path is that the
    // parser never runs. Deciding the verb after extraction would preserve the
    // exposure it exists to remove.
    //
    // The question is asked of the *headers*, not the envelope, because
    // Cloudflare fans a multi-recipient message out into one delivery per
    // rule -- see `addressedToClaim`. Only one of those copies replies: the
    // one whose own envelope is `claim@`. The others are dropped here, which
    // is what stops a `Cc: post@` from publishing an access link into the
    // archive it grants ownership of.
    if (addressedToClaim({ envelopeTo: envelope.to, raw })) {
        if (!isClaimVerb(envelope.to)) {
            log.info?.('claim-verb: suppressed a copy', { ulid, verbs: recipientVerbs(envelope.to) });
            return { status: 'suppressed', ulid, reason: 'claim-copy' };
        }
        return runClaimVerb({ ulid, raw, store, mailer, config, now, log });
    }

    const extracted = await extractOriginal(raw);

    const aclSlug = aclSlugFor({ extracted, config });
    const acl = aclSlug ? await readAcl(store, aclSlug) : null;

    // Only an embedded original has a signature of its own, and the lookup
    // costs a DNS round trip, so it is not attempted otherwise.
    const dkim =
        extracted.source === 'rfc822'
            ? await verifyDkim(extracted, { trustedSealers: config.trustedArcSealers })
            : { verified: false, coverage: null, reason: 'no-embedded-original', signatures: [] };

    // Reported every time it was attempted, pass or fail. A held letter is
    // indistinguishable from a lost one without this, and "held" is the
    // outcome that needs a human to understand why.
    //
    // `coverage` is logged separately from `verified` because they answer
    // different questions. `verified` is the decision. `coverage` is how much
    // of the letter the decision rests on, and a run of `headers` where there
    // used to be `body` is a mail provider having changed something.
    if (extracted.source === 'rfc822') {
        log.info?.('ingest: dkim', {
            ulid,
            verified: dkim.verified,
            coverage: dkim.coverage ?? null,
            reason: dkim.reason,
            authorDomain: dkim.authorDomain ?? null,
            sealer: dkim.arc?.sealer ?? null,
            signatures: dkim.signatures
        });
    }

    const verdict = classify({
        extracted,
        headers: extracted.headers,
        config,
        lookupAcl: () => acl,
        dkimVerified: dkim.verified
    });

    if (verdict.class === CLASS.rejected) {
        logRejection({ log, config, ulid, extracted, verdict, now });

        // The two rejections that get an answer, and they get different ones.
        // See nudge.js. Every other rejection stays silent, because its sender
        // is a stranger, a spammer or a loop.
        const kind =
            verdict.reason === 'bootstrap-not-attached'
                ? NUDGE.attach
                : verdict.reason === 'bootstrap-unverified'
                    ? NUDGE.rebuilt
                    : null;

        if (kind) {
            const slug = validSlug(verdict.slug);
            if (slug) {
                try {
                    await nudgeOnce({
                        tables,
                        mailer,
                        to: verdict.sender,
                        author: verdict.author,
                        slug,
                        baseUrl: config.baseUrl,
                        kind,
                        // Both replies carry it. The inline case looks like
                        // the safer one to withhold it from and is not: an
                        // author address typed into quoted text is no less
                        // forgeable than one written into an attached file.
                        // Withholding it only penalises whoever has the worse
                        // mail client, which is the person this exists for.
                        askUrl: relayUrl({ slug, verdict, config, now }),
                        now,
                        log
                    });
                } catch (error) {
                    // The letter is already refused and nothing is being kept.
                    // A failure here costs advice, not mail.
                    log.error?.('ingest: could not advise the forwarder', { slug, error: error.message });
                }
            }
        }

        return { status: 'rejected', ulid, reason: verdict.reason };
    }

    // The slug reaches a blob path, so it is validated rather than trusted
    // even though it was derived from a DMARC-authenticated address.
    const slug = validSlug(verdict.slug);
    if (!slug) {
        log.warn?.('ingest: rejected', { ulid, reason: 'invalid-slug', slug: verdict.slug });
        return { status: 'rejected', ulid, reason: 'invalid-slug' };
    }

    // A site that does not exist yet, reached two ways.
    //
    // A direct send resolves its slug from the missionary's own address and
    // consults no ACL, so it can name a site nobody has. A `bootstrap` forward
    // is a parent sending the first letter home before anyone has set anything
    // up -- the path the plan calls the one we advertise. Publishing either
    // would write a letter nobody is entitled to read and nobody knows is
    // there, so both are held until somebody claims the site.
    //
    // They differ in exactly one respect, and it is the important one: who is
    // offered the site. A direct send can only be offered back to the
    // missionary, because they are the only authenticated party. A bootstrap
    // forward must be offered to the *forwarder* -- offering it to the
    // missionary instead would mail a stranger's parent's request to a
    // missionary who never asked for anything, which is precisely the
    // interruption this flow exists to avoid.
    const bootstrapping = verdict.class === CLASS.bootstrap;
    if ((bootstrapping || verdict.class === CLASS.direct) && !(await readAcl(store, slug))) {
        const manifest = await holdPending({
            store,
            slug,
            ulid,
            raw,
            envelope,
            subject: extracted.original?.subject ?? extracted.outerSubject ?? '',
            // `verdict.author`, not `extracted.original.from`. On this path
            // they are meant to be the same address, and they diverge on a
            // letter whose *body* contains a line beginning `From:` --
            // ordinary enough, since a missionary quoting a message from home
            // writes one. `extractOriginal` reads that as the quoted header
            // block a client leaves behind when it flattens a forward and
            // reports the quoted address as the author.
            //
            // `classify` is unaffected, because the direct branch keys off the
            // authenticated envelope sender and never consults the
            // extraction. This did not. The address recorded here is the one
            // the claim link is emailed to, so the effect was a credential
            // for the site delivered to an address chosen by body text. The
            // allowlist happened to block it, which is the sort of luck that
            // stops being available the moment the allowlist opens.
            //
            // The rule this restores: on a direct send there is no forward to
            // see past, so nothing about who sent it may come from the
            // message body. `subject` above still can, and is left as it is --
            // a wrong subject is a cosmetic error on a held letter, not a
            // misdirected credential.
            sender: verdict.author ?? '',
            // Threading follows whoever is going to be written to. A direct
            // send is answered to the missionary, so the reply threads onto
            // the letter they sent. A bootstrap forward is answered to the
            // parent, and the message still open in *their* client is the
            // forward they just sent -- not the missionary's original, which
            // they may never have had as a thread at all.
            messageId: bootstrapping
                ? headerValue(extracted.headers, 'message-id')
                : (extracted.original?.messageId ?? ''),
            hasDirect: !bootstrapping,
            now,
            log
        });

        // Offered once, on the letter that created the site. Later letters do
        // not re-offer: a second link invalidates the first, so somebody
        // writing weekly would be handed a fresh credential every week and
        // find that the one they had finally got round to clicking had just
        // stopped working. Chasing an unclaimed site is the reminder series'
        // job, on its own schedule.
        //
        // The count is the condition rather than a flag, which makes a failed
        // send self-healing: nothing was recorded, so the next letter tries
        // again. Swallowed for the same reason the site-activity write is --
        // the letter is already held, and no mail failure justifies making
        // the sender's server redeliver it.
        if (mailer && (manifest.claimEmailCount ?? 0) === 0) {
            try {
                await offerClaim({
                    store,
                    mailer,
                    slug,
                    key: config.claimTokenKey,
                    baseUrl: config.baseUrl,
                    // Defaults to the manifest's sender, which is the
                    // missionary. Overridden here because a bootstrap forward
                    // was sent by somebody else, and they are the one waiting
                    // to hear back.
                    to: bootstrapping ? verdict.forwarder : '',
                    forwarded: bootstrapping,
                    now,
                    log
                });
            } catch (error) {
                log.error?.('ingest: could not offer the pending site', { slug, error: error.message });
            }
        }

        return { status: 'pending', ulid, slug };
    }

    return commitLetter({ store, tables, slug, ulid, raw, extracted, envelope, verdict, now, log });
}

/**
 * Turn a classified letter into a post, an archive entry and a render job.
 *
 * Split out of `runIngest` so that promoting a claimed site's backlog can
 * reuse it. Everything above this point decides *whether* a letter may be
 * published; everything below assumes that decision has been made and is
 * concerned only with writing it down consistently.
 *
 * It deliberately takes a verdict rather than computing one. A promoted
 * letter was classified when it arrived, possibly months earlier, and
 * re-classifying it then would mean re-verifying its DKIM signature against
 * whatever key the sending domain publishes *now*. Domains rotate keys. A
 * letter that verified on arrival can fail verification later through no
 * fault of anyone's, and the cost of that would be discarding the letter the
 * whole pending mechanism exists to preserve.
 */
export async function commitLetter({ store, tables = null, slug, ulid, raw, extracted, envelope, verdict, now, log }) {
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

    // Sanitized here as well as at render, so `rendered/` never holds raw
    // email HTML even for the seconds between the two. Photos do not exist
    // yet, so every cid: reference drops out of this pass; render rebuilds
    // the body from raw/ with the real photo URLs once they do. The quoted
    // header block is dropped in both passes — it carries the missionary's
    // whole distribution list, and that must never be published even
    // briefly.
    const bodyHtml = original.html
        ? sanitizeBody(original.html, { letterText: original.text })
        : null;
    // A text-only letter never reaches the sanitizer, so the access-link scrub
    // has to be applied here as well. `bodyText` is served to readers whenever
    // render has not run yet or never succeeded.
    const bodyText = original.html ? null : redactAccessLinks(original.text ?? null);

    const post = {
        id: postIdFor(day, msgId),
        extractionSource: extracted.source,
        originalDate,
        receivedAt,
        subject: original.subject ?? extracted.outerSubject ?? '',
        bodyHtml,
        bodyText,
        bodyHead100: candidate.head,
        // Detection only — see photolinks.js. Recorded from the first write so
        // a letter is never counted late, and recomputed at render because
        // that pass rebuilds the body.
        linkedPhotoServices: linkedPhotoServices(bodyHtml ?? bodyText),
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

    // The site's "last letter" stamp, used only to order somebody's archives
    // on the landing page. Deliberately swallowed on failure: this is a sort
    // key, the letter is already committed and archived, and there is no
    // version of "the index write failed" that justifies making the sender's
    // mail server retry and deliver the letter a second time.
    if (tables) {
        try {
            await touchSiteActivity({ tables, slug, lastPostAt: post.originalDate ?? receivedAt });
        } catch (error) {
            log.error?.('ingest: site activity write failed', { slug, error: error.message });
        }
    }

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
