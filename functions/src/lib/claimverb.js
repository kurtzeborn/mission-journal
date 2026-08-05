// `claim@pdayletters.com` — "I am this missionary; give me control of my site."
//
// This is the exact inverse of `post@`, and the contrast is the reason the two
// must not share an ingest prologue.
//
// On the `post@` path, extraction has to run before classification: a forward's
// slug lives inside an attached original, so the parser is unavoidably exposed
// to a stranger's MIME before anything has been decided. Here nothing of the
// sort is needed. The entire decision — is this a DMARC-authenticated sender on
// a missionary domain? — is answerable from the top-level header block, which
// our own provider stamped. So the body is never parsed, the attachments are
// never enumerated, and `extractOriginal` is never called. A message that fails
// the test is dropped having been read only as far as its headers.
//
// **Failure is silent, always.** Mail to `claim@` from any other domain, or
// failing DMARC, is ignored without reply. There is exactly one rule and no
// exceptions, because every alternative — a bounce, an explanation, an error —
// tells an unauthenticated stranger something about who exists here.

import { selectAuthResults, dmarcAligned, domainOf } from './authresults.js';
import { localPartOf } from './classify.js';
import { parseAddress } from './extract.js';
import { validSlug } from './paths.js';
import { issueClaimToken } from './claimtoken.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { missionaryClaimEmail } from './claimemail.js';

export const CLAIM_ADDRESS = 'claim@pdayletters.com';

// Where the grant lives. Deliberately *not* `pending/{slug}/claim.json`:
//
//   - a pending record is purged with the letters it belongs to, and a
//     missionary may well be claiming a site that has been live for months
//     with nothing pending at all;
//   - a pending record is spent permanently on first claim, and this grant has
//     to work on a site somebody else has already claimed — that is its whole
//     purpose;
//   - and reusing it would mean one blob with two meanings, where the
//     difference between them decides whether `verifiedMissionary` is set.
//
// Two records, two paths, one flag each.
export const MISSIONARY_CLAIM = 'missionary-claim.json';

// The pending claim token inherits the pending site's own rolling expiry,
// because a link that outlives the letters it points at leads to an empty page.
// Nothing equivalent exists here — a live site has no expiry — so this carries
// its own, short. The missionary is reading the reply to a message they sent
// moments ago, and a week is generous for that.
export const MISSIONARY_CLAIM_TTL_DAYS = 7;

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
const lower = (email) => String(email ?? '').trim().toLowerCase();

/**
 * The envelope recipients, as local-parts.
 *
 * Cloudflare hands one recipient per event, but the metadata is a header value
 * and a header can carry a list, so this reads a list and copes with one — the
 * same shape as `recipientDomains`.
 */
export const recipientVerbs = (to) =>
    String(to ?? '')
        .split(',')
        .map((address) => localPartOf(address.trim()))
        .filter(Boolean);

/**
 * Is this message addressed to `claim@`?
 *
 * True if *any* recipient is, which is the safe direction: a message carrying
 * both verbs must take the path that publishes nothing.
 */
export const isClaimVerb = (to) => recipientVerbs(to).includes('claim');

/**
 * Does this message ask for a claim, whichever copy of it we are holding?
 *
 * Cloudflare Email Routing does not deliver one message with two recipients.
 * It **fans out**: one Worker invocation per matching rule, each carrying a
 * single address in `envelope.to`. So a message addressed to `claim@` and
 * copied to `post@` arrives as two separate ingests, and the `post@` copy's
 * envelope says nothing whatsoever about the claim.
 *
 * `isClaimVerb(envelope.to)` therefore could not ever fire on the copy that
 * needed stopping, and the guarantee above was worth nothing. The first real
 * message to do this was published to the sender's own archive with our own
 * access link quoted in the body -- a token that grants `verifiedMissionary`
 * ownership, rendered as a clickable link, visible to every reader of the
 * site.
 *
 * The header block is the only place both recipients survive the fan-out, so
 * that is what decides. `Bcc` is deliberately absent: it does not appear in
 * delivered headers, and the envelope covers it.
 */
export function addressedToClaim({ envelopeTo, raw }) {
    if (isClaimVerb(envelopeTo)) return true;

    const headers = readHeaderBlock(raw);
    return headers.some((h) => (h.key === 'to' || h.key === 'cc') && isClaimVerb(h.value));
}

// A generous ceiling on the header block alone. ARC seals and DKIM signatures
// push `From:` a long way down — as far as byte 12,103 in the Gmail captures
// behind `extract.js` — but a header block larger than this is not a header
// block, and scanning further would be doing an attacker's work for them.
const MAX_HEADER_BYTES = 128 * 1024;

/**
 * Read the top-level header block, and nothing else.
 *
 * Returns the same `[{ key, value }]` shape postal-mime produces, with keys
 * lowercased, because `selectAuthResults` consumes both and must not be able
 * to tell which one it was handed.
 *
 * This exists so the claim path can reach `Authentication-Results` without
 * running a MIME parser over an unauthenticated stranger's message. It is not
 * a general-purpose parser and should never grow into one: it stops at the
 * first blank line, decodes as latin1 so no byte sequence can throw, and does
 * not attempt RFC 2047 decoding — every field it is used for is ASCII by
 * specification.
 */
export function readHeaderBlock(raw) {
    const head = Buffer.from(raw.subarray(0, MAX_HEADER_BYTES)).toString('latin1');

    // The block ends at the first empty line. If there is none the message is
    // all headers and no body, which is unusual but not malformed.
    const end = head.search(/\r?\n\r?\n/);
    const block = end < 0 ? head : head.slice(0, end);

    const headers = [];
    for (const line of block.split(/\r?\n/)) {
        // A leading space or tab continues the previous field. Folding is
        // removed by joining with a single space, which is what every consumer
        // here expects and what postal-mime does.
        if (/^[ \t]/.test(line)) {
            if (headers.length) {
                headers[headers.length - 1].value =
                    `${headers[headers.length - 1].value} ${line.trim()}`.trim();
            }
            continue;
        }
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        headers.push({ key: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
    }
    return headers;
}

const headerValue = (headers, key) => headers.find((h) => h.key === key)?.value ?? null;

/**
 * Decide whether a message to `claim@` is from who it says it is.
 *
 * Mirrors the front half of `classify` deliberately — same `authservId`
 * selection, same `dmarcAligned` re-check — because these are the same trust
 * decision made about the same header, and a second implementation of it would
 * be a second thing to get wrong.
 *
 * @returns {{ ok: boolean, slug?: string, sender?: string, reason?: string }}
 */
export function authenticateClaim({ headers, config }) {
    const missionaryDomains = (config.missionaryDomains ?? []).map((d) => d.toLowerCase());

    const auth = selectAuthResults(headers, config.authservId);
    if (!auth) return { ok: false, reason: 'no-auth-results' };

    const sender = parseAddress(headerValue(headers, 'from'));
    if (!sender) return { ok: false, reason: 'no-sender' };

    const senderDomain = domainOf(sender);
    const dmarc = dmarcAligned(auth, senderDomain);
    if (!dmarc.pass) return { ok: false, reason: dmarc.reason };

    // The one rule. Note it is checked *after* DMARC: a forged `From:` on a
    // missionary domain must fail as a DMARC failure, not be evaluated against
    // the domain list at all.
    if (!missionaryDomains.includes(senderDomain)) {
        return { ok: false, reason: 'not-a-missionary-domain' };
    }

    // The slug reaches a blob path, so it is validated rather than trusted even
    // though it was derived from a DMARC-authenticated address.
    const slug = validSlug(localPartOf(sender));
    if (!slug) return { ok: false, reason: 'invalid-slug' };

    return { ok: true, slug, sender };
}

/**
 * Mint a verified-missionary grant and record its hash.
 *
 * Re-issuing replaces the previous hash, which invalidates the earlier link.
 * That is the same rule the pending claim follows and for the same reason: a
 * missionary who emails `claim@` twice must not end up with two live
 * credentials against their own archive.
 */
export async function attachMissionaryClaim({ store, slug, key, sender, now = () => new Date() }) {
    const at = now();
    const expiresAt = new Date(at.getTime() + MISSIONARY_CLAIM_TTL_DAYS * 86_400_000).toISOString();
    const issued = issueClaimToken({ slug, key, expiresAt });

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const existing = await store.readBlob('config', `${slug}/${MISSIONARY_CLAIM}`);
        const prior = existing ? JSON.parse(Buffer.from(existing.bytes).toString('utf8')) : {};

        const record = {
            ...prior,
            slug,
            verifiedMissionary: true,
            sender: lower(sender),
            claimTokenHash: issued.hash,
            issuedAt: at.toISOString(),
            expiresAt,
            // A grant that has already been redeemed is re-issuable: the
            // missionary may have claimed it on one account and want another,
            // or lost access to the first. Redemption is additive here, so a
            // second one costs nothing and refusing would be a support burden
            // with no security benefit.
            issueCount: (prior.issueCount ?? 0) + 1
        };

        try {
            await store.writeBlob('config', `${slug}/${MISSIONARY_CLAIM}`, utf8(record), {
                contentType: 'application/json',
                ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' })
            });
            return { status: 'issued', token: issued.token, expiresAt, record };
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }
    throw new Error(`claim: could not attach a missionary grant for ${slug}`);
}

/**
 * Handle one message addressed to `claim@`.
 *
 * Every refusal returns a status and sends nothing. The statuses exist for the
 * log, not for the sender, who learns only whether a link arrives.
 *
 * @param {object} input
 * @param {Buffer} input.raw          the whole message; only its headers are read
 * @param {object} input.store
 * @param {object} input.mailer
 * @param {object} input.config
 * @param {string} [input.messageId]  the inbound `Message-ID`, for threading
 */
export async function runClaimVerb({
    ulid,
    raw,
    store,
    mailer,
    config,
    now = () => new Date(),
    log = console
}) {
    const headers = readHeaderBlock(raw);
    const auth = authenticateClaim({ headers, config });

    if (!auth.ok) {
        // Logged with the reason but never the address: this is the one
        // endpoint anyone on the internet can reach without authenticating, and
        // a log of who tried is a log of missionary addresses.
        log.info?.('claim-verb: ignored', { ulid, reason: auth.reason });
        return { status: 'ignored', ulid, reason: auth.reason };
    }

    const { slug, sender } = auth;

    // A grant only means something against a site that exists. "Give me control
    // of my site" has no answer when there is no site, and minting one anyway
    // would let anyone with a missionary address create empty archives.
    const acl = await store.readBlob('config', `${slug}/acl.json`);
    const pending = await store.readBlob('pending', `${slug}/claim.json`);
    if (!acl && !pending) {
        log.info?.('claim-verb: no site', { ulid, slug });
        return { status: 'no-site', ulid, slug };
    }

    if (!config.claimTokenKey) {
        log.error?.('claim-verb: no signing key configured', { ulid, slug });
        return { status: 'unavailable', ulid, slug };
    }

    const issued = await attachMissionaryClaim({
        store,
        slug,
        key: config.claimTokenKey,
        sender,
        now
    });

    const body = missionaryClaimEmail({
        baseUrl: config.baseUrl,
        token: issued.token,
        slug,
        expiresAt: issued.expiresAt,
        alreadyOwned: Boolean(acl)
    });

    // Threading, and the `From:` address, are both the prior-correspondence
    // argument from the plan: the reply must come from the address they wrote
    // to and thread onto the message they sent, or Gmail sees an unrelated
    // stranger rather than an answer.
    const inboundId = headerValue(headers, 'message-id');
    const threading = inboundId ? { 'In-Reply-To': inboundId, References: inboundId } : {};

    const result = await mailer.send({
        from: CLAIM_ADDRESS,
        to: sender,
        subject: body.subject,
        text: body.text,
        html: body.html,
        headers: { ...threading, 'Auto-Submitted': 'auto-replied' },
        log
    });

    if (result.status !== 'sent') {
        log.error?.('claim-verb: could not send', { ulid, slug, status: result.status });
        return { status: result.status, ulid, slug, sent: false };
    }

    log.info?.('claim-verb: link sent', { ulid, slug, alreadyOwned: Boolean(acl) });
    return { status: 'sent', ulid, slug, sent: true };
}
