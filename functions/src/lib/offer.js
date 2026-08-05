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

import { attachClaimToken, recordClaimEmailSent } from './claim.js';
import { claimEmail } from './claimemail.js';

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
 * @param {function} [input.now]
 * @param {object} [input.log]
 * @returns {Promise<{status: string, sent?: boolean}>}
 */
export async function offerClaim({ store, mailer, slug, key, baseUrl, to = '', now = () => new Date(), log = console }) {
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
        expiresAt: manifest.expiresAt
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
        from: POST_ADDRESS,
        to: recipient,
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
