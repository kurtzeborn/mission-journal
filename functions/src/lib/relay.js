// Asking the missionary, as a last resort.
//
// Everywhere else, this service works hard not to write to a missionary. They
// have a set number of minutes to write home and no reason to care about our
// plumbing, and a mail from us is a mail that is not from their family. So the
// rule has been: never interrupt them.
//
// This is the exception, and it exists because the alternative turned out to
// be worse. A family whose only mail client is the Outlook desktop app cannot
// produce a forward we are able to verify -- not through inattention, but
// because the client rebuilds every message it forwards, which erases the
// signature. Told to try again, they try again, and it fails again. Without a
// way out, those families simply do not get an archive.
//
// So there is a way out, and it is fenced:
//
//   **They ask for it.** Nothing here fires on ingest. It fires when somebody
//   opens a link we sent them and presses a button, and the nudge that carries
//   that link offers it second, after the route that costs nobody anything.
//
//   **The link is signed and specific.** It names the missionary and the
//   person who will receive the letter, both inside the HMAC. The endpoint
//   never takes the caller's word for either, because that would make us a
//   machine for sending a stranger's mail.
//
//   **It happens once.** One outstanding request per missionary, recorded
//   before the send. Pressing the button twice does not write twice, and
//   neither does forwarding the nudge to a friend.
//
// What the missionary is asked to do is deliberately not "reply to your
// family". It is "forward this to us". That looks colder and it is the only
// version that works: if they sent the letter to the family member instead,
// that person would still be holding the same Outlook client and would still
// be unable to forward it to us. Their mail is the one mail on this path that
// is guaranteed to verify, because it is theirs.

import { TABLES } from './tables.js';
import { POST_ADDRESS } from './offer.js';
import { mailFrom } from './mail.js';
import { PURPOSE, verifyClaimToken } from './claimtoken.js';

const SIGNATURE = 'P-Day Letters';

// Long enough that a link found in a mail folder a fortnight later still
// works, short enough that it is not a standing invitation to interrupt
// somebody. It also bounds how long ingest will redirect a claim, which is the
// part that would be uncomfortable if it lasted forever.
export const RELAY_TTL_DAYS = 30;

const escape = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * The note to the missionary. Exported so its wording is testable.
 *
 * DRAFT COPY, on the same terms as the claim emails.
 *
 * Short on purpose, and the shortness is the feature. One sentence of why, one
 * instruction, one address. It names the person who asked, because a missionary
 * who does not recognise the name should be able to ignore this, and they can
 * only do that if we tell them who it is.
 *
 * There is no link and nothing to sign in to. Missionary accounts cannot sign
 * in here at all, and a link would be one more thing to explain.
 *
 * @param {object} input
 * @param {string} input.requester the family member who asked, an address
 * @param {string} input.baseUrl
 */
export function relayEmail({ requester, baseUrl }) {
    const home = String(baseUrl ?? '').replace(/\/$/, '');
    const subject = 'A quick favour, on behalf of your family';

    const text = [
        `${requester} is trying to save your letters home in one place, so`,
        'nobody in the family misses one.',
        '',
        'They cannot do it from their end: their email program changes your',
        'letters when it forwards them, and we cannot accept a letter that',
        'has been changed.',
        '',
        'You can do it in one step.',
        '',
        `  Forward one of your letters home to ${POST_ADDRESS}`,
        '',
        `That is all. We will take it from there, and ${requester} will do the`,
        'rest. You do not need to sign in to anything or reply to us.',
        '',
        `If you do not know who ${requester} is, ignore this message. Nothing`,
        'happens unless you forward a letter.',
        '',
        `${SIGNATURE} \u2014 ${home}`
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p><strong>${escape(requester)}</strong> is trying to save your letters home in one place, so nobody in the family misses one.</p>`,
        '<p>They cannot do it from their end: their email program changes your letters when it forwards them, and we cannot accept a letter that has been changed.</p>',
        '<p><strong>You can do it in one step.</strong></p>',
        `<p>Forward one of your letters home to <strong>${POST_ADDRESS}</strong></p>`,
        `<p>That is all. We will take it from there, and ${escape(requester)} will do the rest. You do not need to sign in to anything or reply to us.</p>`,
        `<p>If you do not know who ${escape(requester)} is, ignore this message. Nothing happens unless you forward a letter.</p>`,
        `<p>${SIGNATURE} &mdash; <a href="${escape(home)}">${escape(home)}</a></p>`,
        '</div>'
    ].join('');

    return { subject, text, html };
}

/**
 * What a valid relay link says, without acting on it.
 *
 * The page behind the link shows both addresses before its button does
 * anything, so that somebody who was forwarded the mail by mistake can see
 * whose archive they are about to start. Not a disclosure: holding this token
 * means having been sent the message it travelled in.
 */
export function readRelay({ token, key, now = () => new Date() }) {
    const result = verifyClaimToken({ token, key, purpose: PURPOSE.relay, now });
    if (!result.valid || !result.subject || !result.recipient) return null;
    return { slug: result.slug, author: result.subject, requester: result.recipient };
}

/**
 * The outstanding request for a missionary, if there is one and it is current.
 *
 * Read on the ingest path, where a direct send from a missionary with no site
 * would otherwise offer the archive back to the missionary. That is the right
 * default -- they are the only authenticated party -- and it is the wrong
 * answer here, because on this path the missionary is doing somebody else a
 * favour and has no interest in owning anything.
 *
 * Expiry is checked on read rather than by deleting rows on a timer, so a
 * stale row cannot redirect a credential just because a cleanup did not run.
 */
export async function relayRequestFor({ tables, slug, now = () => new Date() }) {
    if (!tables || !slug) return null;

    const row = await tables.getEntity(TABLES.relays, slug, 'request');
    if (!row?.requester || !row?.expiresAt) return null;
    if (Date.parse(row.expiresAt) <= now().getTime()) return null;

    return { requester: row.requester, requestedAt: row.requestedAt ?? null };
}

/**
 * Record the request and write to the missionary.
 *
 * The row goes in before the send, and a row that already exists stops the
 * send rather than replacing it. Both directions of that matter. Before,
 * because a send that succeeded and a row that did not is how one button press
 * becomes several. First-wins rather than last-wins, because the row is what
 * ingest later reads to decide where a claim link goes, and letting a second
 * caller overwrite it would turn "ask on my behalf" into "take the archive
 * from whoever asked first".
 *
 * @param {object} input
 * @param {object} input.tables
 * @param {object} input.mailer
 * @param {string} input.token  from the link
 * @param {string} input.key    CLAIM_TOKEN_KEY
 * @param {string} input.baseUrl
 */
export async function requestRelay({
    tables,
    mailer,
    token,
    key,
    baseUrl = '',
    now = () => new Date(),
    log = console
}) {
    if (!tables || !mailer || !key) return { status: 'unavailable' };

    const read = readRelay({ token, key, now });
    if (!read) return { status: 'invalid' };

    const expiresAt = new Date(now().getTime() + RELAY_TTL_DAYS * 86400_000).toISOString();

    const first = await tables.insertEntity(TABLES.relays, {
        partitionKey: read.slug,
        rowKey: 'request',
        requester: read.requester,
        requestedAt: now().toISOString(),
        expiresAt
    });

    if (!first) {
        // Deliberately reported as done rather than as a duplicate. Somebody
        // pressing the button a second time is somebody who is not sure the
        // first one worked, and "already asked" is the answer to their
        // question. It also declines to say whether the earlier request was
        // theirs, which would answer a question they did not ask.
        log.info?.('relay: already asked, staying quiet', { slug: read.slug });
        return { status: 'ok', duplicate: true };
    }

    const body = relayEmail({ requester: read.requester, baseUrl });
    const result = await mailer.send({
        from: mailFrom(POST_ADDRESS),
        to: read.author,
        subject: body.subject,
        text: body.text,
        html: body.html,
        // RFC 3834. This is generated, and it is going to an address that may
        // well have a "P-Day is Monday" auto-reply behind it.
        headers: { 'Auto-Submitted': 'auto-generated' },
        log
    });

    log.info?.('relay: asked the missionary', { slug: read.slug, status: result.status });
    return { status: result.status === 'sent' ? 'ok' : result.status };
}
