// Asking the missionary to vouch, as a last resort.
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
// **What the missionary is asked for is a vouch, not a letter.** They receive
// one message containing a link and are asked to pass it to the person who
// asked. Nothing to attach, nothing to sign in to -- missionary accounts
// cannot sign in here at all. Forwarding a link is the one thing every mail
// client on earth does correctly, because a link is text; the clients that
// mangle a forwarded *letter* leave a forwarded *link* alone.
//
// That also puts the decision where it always belonged. Cryptography was never
// really the question being asked at bootstrap -- the question was "should
// this person be allowed to start an archive of your letters", and a signature
// only ever answered it by proxy, on the assumption that anyone holding a
// genuine letter was already trusted with them. Here the person whose letters
// they are answers it directly.
//
// It is fenced:
//
//   **They ask for it.** Nothing here fires on ingest. It fires when somebody
//   opens a link we sent them and presses a button, and the nudge that carries
//   that link offers it second, after the route that costs nobody anything.
//
//   **The link that triggers it is signed and specific.** It names the
//   missionary and the person who asked, both inside the HMAC. The endpoint
//   never takes the caller's word for either, because that would make us a
//   machine for sending a stranger's mail.
//
//   **It happens once.** One outstanding grant per missionary, written before
//   the send. Pressing the button twice does not write twice, and neither does
//   forwarding the nudge to a friend.
//
//   **The grant is spent by the first person to open it**, and confers
//   ownership without the verified-missionary flag. Following a forwarded link
//   proves you were sent it. It does not prove who you are.

import { POST_ADDRESS } from './offer.js';
import { CLAIM_ADDRESS } from './claimverb.js';
import { escapeHtml as escape, mailFrom } from './mail.js';
import { PURPOSE, verifyClaimToken, issueClaimToken } from './claimtoken.js';
import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { validSlug } from './paths.js';

const SIGNATURE = 'Pday Letters';

/**
 * The grant record, alongside `missionary-claim.json` and for the same reason:
 * the hash lives server-side, so which privilege a token carries is never an
 * assertion travelling through a stranger's mailbox.
 */
export const RELAY_CLAIM = 'relay-claim.json';

// Two P-days. The missionary grant is seven days because it answers a request
// its recipient made minutes earlier; this one has to survive a hop through
// somebody who writes home once a week and may open our message the day after
// they last did. Not longer, because it is a live credential sitting in two
// mailboxes.
export const RELAY_TTL_DAYS = 14;

const utf8 = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
const lower = (email) => String(email ?? '').trim().toLowerCase();


/**
 * The note to the missionary. Exported so its wording is testable.
 *
 * DRAFT COPY, on the same terms as the claim emails.
 *
 * Short on purpose, and the shortness is the feature: one sentence of why, one
 * instruction, one link. It names the person who asked twice -- once to act
 * on, once to refuse on -- because a missionary who does not recognize the
 * name should be able to stop here, and they can only do that if we say who it
 * is before we say what to do.
 *
 * It also says plainly what forwarding the link does. This is the one message
 * in the system whose recipient is not the beneficiary, so "pass this on" has
 * to arrive with "and here is what you are handing over"; a favour nobody
 * understood is not consent.
 *
 * @param {object} input
 * @param {string} input.requester the family member who asked, an address
 * @param {string} input.link      the grant link, to be forwarded
 * @param {string} input.baseUrl
 */
export function relayEmail({ requester, link, baseUrl }) {
    const home = String(baseUrl ?? '').replace(/\/$/, '');
    const subject = 'A quick favour, on behalf of your family';

    const text = [
        `${requester} is trying to save your letters home in one place, so`,
        'nobody in the family misses one.',
        '',
        'We cannot let them start without asking you first, and you are the',
        'only person who can say whether they should. So we are asking.',
        '',
        `If you know ${requester}, forward this message to them.`,
        '',
        `  ${link}`,
        '',
        'Whoever opens that link sets up the archive and looks after it. It',
        `works once and stops working in ${RELAY_TTL_DAYS} days, so please send it to them`,
        'rather than posting it anywhere.',
        '',
        `If you do not know ${requester}, delete this message. Nothing happens`,
        'unless somebody opens the link. Nothing has been saved yet on our',
        'servers and nothing will be saved if you delete this message.',
        '',
        'You do not need to sign in or reply to us. If you would like your own',
        `access to the archive later, email ${CLAIM_ADDRESS} from this address`,
        'and we will send you a link of your own.',
        '',
        `${SIGNATURE} \u2014 ${home}`
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p><strong>${escape(requester)}</strong> is trying to save your letters home in one place, so nobody in the family misses one.</p>`,
        '<p>We cannot let them start without asking you first, and you are the only person who can say whether they should. So we are asking.</p>',
        `<p><strong>If you know ${escape(requester)}, forward this message to them.</strong></p>`,
        `<p><a href="${escape(link)}">${escape(link)}</a></p>`,
        `<p>Whoever opens that link sets up the archive and looks after it. It works once and stops working in ${RELAY_TTL_DAYS} days, so please send it to them rather than posting it anywhere.</p>`,
        `<p>If you do not know ${escape(requester)}, delete this message. Nothing happens unless somebody opens the link. Nothing has been saved yet on our servers and nothing will be saved if you delete this message.</p>`,
        `<p>You do not need to sign in or reply to us. If you would like your own access to the archive later, email <strong>${CLAIM_ADDRESS}</strong> from this address and we will send you a link of your own.</p>`,
        `<p>${SIGNATURE} &mdash; <a href="${escape(home)}">${escape(home)}</a></p>`,
        '</div>'
    ].join('');

    return { subject, text, html };
}

/**
 * What a valid relay link says, without acting on it.
 *
 * The page behind the link shows both addresses before its button does
 * anything, so that somebody who was forwarded the nudge by mistake can see
 * whose missionary they are about to interrupt. Not a disclosure: holding this
 * token means having been sent the message it travelled in.
 */
export function readRelay({ token, key, now = () => new Date() }) {
    const result = verifyClaimToken({ token, key, purpose: PURPOSE.relay, now });
    if (!result.valid || !result.subject || !result.recipient) return null;
    return { slug: result.slug, author: result.subject, requester: result.recipient };
}

/**
 * Mint the grant the missionary will forward, and record its hash.
 *
 * First-wins rather than last-wins, and that direction is the point. A second
 * caller must not be able to replace the requester named on an outstanding
 * grant, because the missionary is being told a name and asked to decide about
 * it -- rewriting the record after they were told would turn "ask on my
 * behalf" into "take the archive from whoever asked first". So a live grant
 * stops the send rather than reissuing.
 *
 * A grant that expired unredeemed is replaced. Nothing was handed over, and
 * refusing forever would mean one message left unread locks a family out for
 * good. A grant that was claimed is not replaced: the archive exists, and the
 * way into an archive that exists is an invitation from whoever owns it.
 */
export async function attachRelayGrant({
    store,
    slug,
    key,
    requester,
    author,
    now = () => new Date()
}) {
    const safe = validSlug(slug);
    if (!safe) return { status: 'invalid' };

    const at = now();
    const expiresAt = new Date(at.getTime() + RELAY_TTL_DAYS * 86_400_000).toISOString();

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const existing = await store.readBlob('config', `${safe}/${RELAY_CLAIM}`);
        const prior = existing ? JSON.parse(Buffer.from(existing.bytes).toString('utf8')) : null;

        if (prior?.claimedAt) return { status: 'claimed' };
        if (prior?.claimTokenHash && Date.parse(prior.expiresAt ?? '') > at.getTime()) {
            return { status: 'exists' };
        }

        // Minted inside the loop. A token whose hash lost the race must not be
        // the one we then put in an email.
        const issued = issueClaimToken({ slug: safe, key, expiresAt });

        const record = {
            slug: safe,
            requester: lower(requester),
            author: lower(author),
            claimTokenHash: issued.hash,
            issuedAt: at.toISOString(),
            expiresAt,
            issueCount: (prior?.issueCount ?? 0) + 1
        };

        try {
            await store.writeBlob('config', `${safe}/${RELAY_CLAIM}`, utf8(record), {
                contentType: 'application/json',
                ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' })
            });
            return { status: 'issued', token: issued.token, expiresAt, record };
        } catch (error) {
            if (!isConflict(error) || attempt === CONFLICT_RETRIES - 1) throw error;
        }
    }

    throw new Error(`relay: could not attach a grant for ${slug}`);
}

/**
 * Record the grant and write to the missionary.
 *
 * The grant goes in before the send, on the same reasoning the claim path
 * uses: a send that succeeded over a record that did not is how one button
 * press becomes several, and a link nobody can redeem is a better failure than
 * a credential nobody expected.
 *
 * @param {object} input
 * @param {object} input.store
 * @param {object} input.mailer
 * @param {string} input.token  from the link in the nudge
 * @param {string} input.key    CLAIM_TOKEN_KEY
 * @param {string} input.baseUrl
 */
export async function requestRelay({
    store,
    mailer,
    token,
    key,
    baseUrl = '',
    now = () => new Date(),
    log = console
}) {
    if (!store || !mailer || !key) return { status: 'unavailable' };

    const read = readRelay({ token, key, now });
    if (!read) return { status: 'invalid' };

    const grant = await attachRelayGrant({
        store,
        slug: read.slug,
        key,
        requester: read.requester,
        author: read.author,
        now
    });

    if (grant.status !== 'issued') {
        // Deliberately reported as done rather than as a duplicate. Somebody
        // pressing the button a second time is somebody who is not sure the
        // first one worked, and "already asked" is the answer to their
        // question. It also declines to say whether the earlier request was
        // theirs, or whether the archive now exists, neither of which they
        // asked.
        log.info?.('relay: nothing to send', { slug: read.slug, reason: grant.status });
        return { status: 'ok', duplicate: true };
    }

    const home = String(baseUrl ?? '').replace(/\/$/, '');
    const body = relayEmail({
        requester: read.requester,
        link: `${home}/claim#${grant.token}`,
        baseUrl
    });

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

    log.info?.('relay: asked the missionary to vouch', { slug: read.slug, status: result.status });
    return { status: result.status === 'sent' ? 'ok' : result.status };
}
