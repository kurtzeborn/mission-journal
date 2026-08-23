// Offering a pending site to the person whose letters are sitting in it.
//
// This is the step Phase 7 could not take. Letters have been accumulating in
// `pending/` since that phase shipped, the claim page and the redemption path
// both work, and none of it was reachable by anyone, because nothing had ever
// told a single person that any of it existed. Everything else in the claim
// flow was machinery waiting on one email.
//
// The order here is the whole design:
//
//   1. mint the token and store its hash  -- the link must work when it lands
//   2. send                               -- the only step that can be seen
//   3. record that we sent                -- the evidence the purge job trusts
//
// Steps 1 and 3 used to be one write, which made the manifest claim an offer
// had been made whenever minting succeeded and sending did not. The purge
// timer reads exactly that field to decide whether letters are being deleted
// from somebody who was never told, so the failure mode was: send breaks,
// nobody hears, nothing complains, letters are destroyed on schedule.

import { attachClaimToken, recordClaimEmailSent, claimManifest } from './claim.js';
import { verifyClaimToken } from './claimtoken.js';
import { claimEmail } from './claimemail.js';
import { HUMAN_ADDRESS, mailFrom } from './mail.js';

// Replies to inbound mail come from the address that was written to, to
// preserve the recipient's prior-correspondence signal -- see the Domains
// section of the plan. A pending site can only ever have been created by a
// direct send to `post@`; `claim@` is a different verb with its own path, so
// there is nothing to choose between here and no setting to get wrong.
export const POST_ADDRESS = 'post@pdayletters.com';

/**
 * Mint a claim link and email it to the person the letters came from.
 *
 * @param {object} input
 * @param {object} input.store
 * @param {object} input.mailer     from `createMailer`
 * @param {string} input.slug
 * @param {string} input.key        claim-token signing key
 * @param {string} input.baseUrl    e.g. https://pdayletters.com
 * @param {string} [input.to]       defaults to the manifest's sender
 * @param {boolean} [input.forwarded] was the site bootstrapped by a forward?
 * @param {function} [input.now]
 * @param {object} [input.log]
 * @returns {Promise<{status: string, sent?: boolean}>}
 */
export async function offerClaim({ store, mailer, slug, key, baseUrl, to = '', forwarded = false, now = () => new Date(), log = console }) {
    const issued = await attachClaimToken({ store, slug, key, now });

    if (!issued) return { status: 'missing' };
    if (issued.status === 'claimed') return { status: 'claimed' };

    const manifest = issued.manifest;
    const recipient = to || manifest.sender;

    if (!recipient) {
        // Held letters with no usable return address. Nothing to do about it
        // here, but it is the one shape of pending site that can never be
        // offered by any amount of retrying, so it is worth saying so plainly
        // rather than leaving it to the purge job to notice in sixty days.
        log.error?.('offer: pending site has no sender to write to', { slug });
        return { status: 'no-recipient' };
    }

    const body = claimEmail({
        baseUrl,
        token: issued.token,
        messageCount: manifest.messageCount,
        sender: manifest.sender,
        expiresAt: manifest.expiresAt,
        forwarded
    });

    // Threading is header-driven, which is what makes sending this from a
    // Function rather than a Worker cost nothing: `In-Reply-To` and
    // `References` are ours to write either way. Omitted entirely when the
    // sender's client wrote no `Message-ID`, because an empty reference
    // header is worse than none.
    const threading = manifest.lastMessageId
        ? { 'In-Reply-To': manifest.lastMessageId, References: manifest.lastMessageId }
        : {};

    const result = await mailer.send({
        from: mailFrom(POST_ADDRESS),
        to: recipient,
        // Somewhere a person reads, because `from` is an ingest address.
        replyTo: HUMAN_ADDRESS,
        subject: body.subject,
        text: body.text,
        html: body.html,
        headers: {
            ...threading,
            // RFC 3834. `auto-replied` rather than `auto-generated` because
            // this goes out in direct response to a specific message; the
            // latter is for mail nothing triggered, like a periodic digest.
            // The distinction matters to the receiving side's own loop
            // suppression, and we reply to essentially every inbound message
            // -- to a missionary account, which is exactly where an
            // out-of-office responder lives.
            'Auto-Submitted': 'auto-replied'
        },
        log
    });

    if (result.status !== 'sent') return { status: result.status, sent: false };

    // Bookkeeping, and deliberately not fatal. The email is already in the
    // recipient's hands; failing here would send a second one on the next
    // letter, and duplicate claim links are worse than an undercount.
    try {
        await recordClaimEmailSent({ store, slug, emailTo: recipient, now });
    } catch (error) {
        log.error?.('offer: sent but could not record it', { slug, error: error.message });
    }

    return { status: 'sent', sent: true };
}

// How long a resend has to wait behind the last claim email that went out.
//
// A cap on the count was the obvious alternative and is the wrong shape: the
// same counter records the ordinary offers, so a site that had legitimately
// been offered to its three forwarders would arrive at this page already
// forbidden -- refusing the one person actually asking, on the strength of
// mail they never received. A window refuses nobody permanently.
const RESEND_QUIET_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Days that must pass after the *n*th invitation before the next one may go.
// The last entry repeats for every invitation beyond it.
//
// A single invitation is too few. A missionary who adds `post@` to his BCC
// line, skims the reply on a busy P-day and never acts on it loses nothing --
// the rolling window keeps every letter -- but six months later there are
// twenty-six letters nobody can read, his family has seen none of them, and
// his only contact from us was one message half a year ago.
//
// Widening rather than periodic, so this catches the person who missed the
// first without becoming the recurring interruption the whole design works to
// avoid. Across a two-year mission it is five or six messages in total.
const INVITATION_GAP_DAYS = [30, 90, 180];

/**
 * May the missionary be invited again on the strength of this letter?
 *
 * **Never on a timer, which is the property that matters most.** The caller is
 * ingest, so an invitation is only ever sent in response to a letter that just
 * arrived. That keeps it a reply to solicited correspondence -- see the
 * deliverability argument in the plan -- and guarantees we never write to
 * somebody who has stopped using the service. If the letters stop, so does
 * this.
 *
 * Read from the pending manifest rather than the missionary's `users` row.
 * The row would let the schedule survive a purge and recreation; the manifest
 * needs no new state and no new write, and a purge has by then deleted the
 * letters the invitation was about, so starting over is the honest behaviour
 * rather than a shortcoming.
 */
export function invitationDue(manifest, now = new Date()) {
    const count = manifest?.claimEmailCount ?? 0;
    if (count === 0) return true;

    const last = Date.parse(manifest?.claimEmailSentAt ?? '');
    // Counted but never stamped, which a manifest written before this existed
    // can be. Inviting once more is the safe direction: the alternative is a
    // site that can never be chased again.
    if (!Number.isFinite(last)) return true;

    const gap = INVITATION_GAP_DAYS[Math.min(count, INVITATION_GAP_DAYS.length) - 1];
    return now.getTime() - last >= gap * DAY_MS;
}

/**
 * "Email me a new link", from the claim page.
 *
 * The offer exists because a claim token and the letters it points at expire
 * on *different* clocks. The pending site's window rolls forward with every
 * letter that arrives; the token minted alongside letter one does not. So the
 * ordinary shape of this is somebody who was written to in March, went looking
 * for the email in June, and holds a dead link to letters that are very much
 * still there. Telling them to wait for the next one is a real answer -- the
 * next letter does bring a fresh link -- but it is a week of waiting for
 * something we can do now.
 *
 * **The dead token is the credential, and that is the point.** It is signed by
 * us, so holding one proves the holder was sent a claim email; verifying it
 * without the expiry check is the whole mechanism. Nothing is disclosed to the
 * caller either way -- the new link goes to an address already in the
 * manifest and the response never names it, so this cannot be used to find out
 * who was written to, only to ask that they be written to again.
 *
 * Only pending sites. A `claim@` or relay grant has `claim@pdayletters.com`
 * itself as its resend path, which is a better one: it proves control of the
 * mailbox rather than possession of a link.
 *
 * @returns {Promise<{status: string}>} `sent`, or why not.
 */
export async function resendClaim({ store, mailer, token, key, baseUrl, now = () => new Date(), log = console }) {
    // Deliberately not `verified.valid`. An expired token is the case this
    // function exists for; anything else wrong with it is a refusal.
    const verified = verifyClaimToken({ token, key, now });
    if (!verified.valid && verified.reason !== 'expired') return { status: 'invalid' };

    const manifest = await claimManifest(store, verified.slug);
    if (!manifest || manifest.claimedAt) return { status: 'gone' };

    // The site's own window has run out too, so there is no later date to mint
    // against and the letters are on the purge job's list. A fresh link would
    // be born expired.
    if (Date.parse(manifest.expiresAt) <= now().getTime()) return { status: 'gone' };

    const sentAt = Date.parse(manifest.claimEmailSentAt ?? '');
    if (Number.isFinite(sentAt) && now().getTime() - sentAt < RESEND_QUIET_MS) {
        return { status: 'recent' };
    }

    // Where the link that is being replaced was sent. There is only ever one
    // live token per pending site -- minting supersedes -- so the last address
    // offered is by definition the one holding the link this call invalidates,
    // and sending the replacement anywhere else would strand them.
    const emailed = manifest.emailedAddresses ?? [];
    const to = emailed[emailed.length - 1] || manifest.sender;

    const result = await offerClaim({
        store,
        mailer,
        slug: verified.slug,
        key,
        baseUrl,
        to,
        forwarded: !manifest.hasDirect,
        now,
        log
    });

    return { status: result.status === 'sent' ? 'sent' : 'failed' };
}

// How long a forwarder waits before being chased once.
export const REMINDER_DAYS = 7;

/**
 * The one reminder a forward-only pending site gets.
 *
 * Somebody forwarded a stack of letters, was sent a link, and did nothing with
 * it. They are not ignoring us the way an unclaimed missionary site is being
 * ignored -- they asked for this, and a fortnight later the whole thing has
 * fallen out of their head. So: one nudge, a week after the first offer, and
 * then silence.
 *
 * **Keyed to the site, not to each claim email.** Three forwarders on one
 * pending site must not produce three reminders on three clocks, and the
 * condition below is the site's own counter rather than anything per-address.
 *
 * There is no new state behind "already reminded": sending increments
 * `claimEmailCount` past one, which is the condition. That also draws the line
 * between this and the missionary's tapering series cleanly -- `hasDirect`
 * sites are chased by ingest, in reply to letters they are still writing, and
 * are skipped here. A site that becomes direct after a forward stops being
 * this job's business and becomes ingest's, which is the right hand-off:
 * there is now somebody to reply *to*.
 *
 * The reminder re-mints, so the earlier link stops working. That is the
 * correct trade for a message going to the same address: the newest mail from
 * us carries the newest link, which is where anyone looks anyway.
 */
export async function remindPending({ store, mailer, key, baseUrl, now = () => new Date(), log = console }) {
    const at = now().getTime();
    const names = await store.listBlobs('pending', '');
    const reminded = [];

    for (const name of names.filter((entry) => entry.endsWith('/claim.json'))) {
        const slug = name.slice(0, -'/claim.json'.length);

        let manifest;
        try {
            manifest = await claimManifest(store, slug);
        } catch (error) {
            // Same bias as the purge sweep: unreadable means unjudgeable, and
            // this one only ever declines to send an email.
            log.error?.('remind: unreadable manifest, skipping', { slug, error: error.message });
            continue;
        }

        if (!manifest || manifest.claimedAt) continue;
        if (manifest.hasDirect) continue;
        if ((manifest.claimEmailCount ?? 0) !== 1) continue;

        const sentAt = Date.parse(manifest.claimEmailSentAt ?? '');
        if (!Number.isFinite(sentAt) || at - sentAt < REMINDER_DAYS * DAY_MS) continue;

        // Nothing left to point at. The purge sweep is about to take these,
        // and a reminder about letters that are on their way out is worse
        // than no reminder.
        if (Date.parse(manifest.expiresAt) <= at) continue;

        const emailed = manifest.emailedAddresses ?? [];
        const result = await offerClaim({
            store,
            mailer,
            slug,
            key,
            baseUrl,
            to: emailed[emailed.length - 1] || manifest.sender,
            forwarded: true,
            now,
            log
        });

        if (result.status === 'sent') reminded.push(slug);
        else log.warn?.('remind: could not send', { slug, status: result.status });
    }

    return { scanned: names.length, reminded };
}
