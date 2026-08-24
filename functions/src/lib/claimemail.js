// The claim email.
//
// DRAFT COPY. The wording below is a placeholder written to be replaced --
// it is here so that the shape of the message, the link, and the constraints
// it has to satisfy are settled and testable before anyone argues about
// sentences.
//
// Nothing sends this yet. Phase 8 wires it to Cloudflare Email Service, where
// it will go out as a reply to an arriving letter so that it threads into a
// conversation the recipient already recognizes.
//
// The hard constraints, which survive any rewrite:
//
//   **The link carries the token in a fragment.** `/claim#<token>` is never
//   transmitted to a server, which keeps it out of access logs, out of
//   telemetry, and out of reach of the link scanner that `missionary.org`
//   runs over inbound mail before anyone reads it.
//
//   **It has to say "personal account".** The people receiving this are told
//   to sign in, and the account they reach for first is often a work one they
//   will lose access to. The archive outlives the job.
//
//   **It has to give the deadline as a date, not a duration.** "Expires in
//   60 days" in a message read three weeks late is not information.
//
//   **It must not name the missionary in the subject.** The subject line is
//   visible on a lock screen and in every mail server between here and the
//   recipient; the body is at least behind a login.

import { escapeHtml as escape } from './mail.js';

const SIGNATURE = 'Pday Letters';

// Written as a date the recipient can act on. Deliberately not localised:
// a month name cannot be misread the way 03/08 can.
const readableDate = (iso) =>
    new Date(iso).toLocaleDateString('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/**
 * @param {object} input
 * @param {string} input.baseUrl        e.g. https://pdayletters.com
 * @param {string} input.token
 * @param {number} input.messageCount
 * @param {string} input.sender         the missionary's address
 * @param {string} input.expiresAt
 * @param {boolean} [input.forwarded]   did the recipient forward it themselves?
 */
export function claimEmail({ baseUrl, token, messageCount, sender, expiresAt, forwarded = false }) {
    const link = `${baseUrl.replace(/\/$/, '')}/claim#${token}`;
    const count = plural(messageCount, 'letter', 'letters');
    const deadline = readableDate(expiresAt);

    // A variant rather than a separate function, unlike the `claim@` reply:
    // everything after this first line is identical, because the situation is
    // identical -- a pending site, a first-come link, a hold that expires. All
    // that differs is whether the recipient already knows why they are hearing
    // from us. A parent who forwarded a letter thirty seconds ago does; being
    // told letters "have arrived" reads like a notice about someone else's
    // mail.
    const opening = forwarded
        ? `You forwarded ${messageCount === 1 ? 'a letter' : `${messageCount} letters`} from ${sender} to ${SIGNATURE}.`
        : `${count} sent from ${sender} have arrived at ${SIGNATURE}.`;

    // No name, no slug, no count. This line is visible without unlocking a
    // phone, and it is forwarded more often than the body is read.
    const subject = 'Your missionary letters are being saved';

    const text = [
        opening,
        '',
        'They are being held, not published. Nobody can read them, including us,',
        'until someone sets up the archive and chooses who to share it with.',
        '',
        'Set it up here:',
        link,
        '',
        `Please use a personal account rather than a work or school one. This`,
        `archive is meant to outlast the job you have today.`,
        '',
        `If nobody sets it up by ${deadline}, the letters stop being held.`,
        'Every new letter that arrives extends that date.',
        '',
        'If you were not expecting this, you can ignore it. The link only works',
        'once, and only for whoever uses it first.',
        '',
        SIGNATURE
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        forwarded
            ? `<p>${escape(opening)}</p>`
            : `<p>${escape(count)} sent from <strong>${escape(sender)}</strong> have arrived at ${SIGNATURE}.</p>`,
        '<p>They are being held, not published. Nobody can read them, including us, until someone sets up the archive and chooses who to share it with.</p>',
        `<p><a href="${escape(link)}" style="display:inline-block;padding:12px 20px;background:#1f4e79;color:#fff;text-decoration:none;border-radius:4px">Set up the archive</a></p>`,
        '<p>Please use a <strong>personal</strong> account rather than a work or school one. This archive is meant to outlast the job you have today.</p>',
        `<p>If nobody sets it up by <strong>${escape(deadline)}</strong>, the letters stop being held. Every new letter that arrives extends that date.</p>`,
        '<p>If you were not expecting this, you can ignore it. The link only works once, and only for whoever uses it first.</p>',
        `<p>&mdash; ${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html, link };
}

/**
 * The reply to a message sent to `claim@`.
 *
 * A different message from the one above, not a variant of it, because the
 * recipient is in a different situation in every way that matters. They asked
 * for this seconds ago, so nothing needs to explain what the service is. They
 * have proved who they are, so the link confers `verifiedMissionary` and the
 * "only works for whoever uses it first" warning would be actively wrong. And
 * the site may already have an owner — a parent running it perfectly happily —
 * in which case the one thing this must not imply is that anyone is being
 * displaced.
 *
 * The subject may say more than the pending one does, on the same reasoning
 * that governs it: that message goes to someone who has not asked for
 * anything, while this answers a request its recipient just made. It still
 * names nobody.
 *
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {string} input.token
 * @param {string} input.expiresAt
 * @param {boolean} [input.alreadyOwned]  is there already an `acl.json`?
 */
export function missionaryClaimEmail({ baseUrl, token, expiresAt, alreadyOwned = false }) {
    const link = `${baseUrl.replace(/\/$/, '')}/claim#${token}`;
    const deadline = readableDate(expiresAt);

    const subject = 'Your Pday Letters access link';

    // Said in both versions, because it is the single most consequential
    // sentence in the message: an owner entry keyed on the missionary address
    // dies with the mailbox 60 days after they come home, and this is the last
    // moment anyone can act on that.
    const personal = [
        'Use a personal Google or Microsoft account, not your missionary one.',
        'Your missionary address stops working 60 days after you come home, and',
        'the archive is meant to outlast it.'
    ];

    const situation = alreadyOwned
        ? [
              'This site already has someone looking after it, and that does not',
              'change. You will be added alongside them, not in place of them.'
          ]
        : ['Following the link sets the archive up and makes you its owner.'];

    const text = [
        'Here is your link:',
        link,
        '',
        ...situation,
        '',
        ...personal,
        '',
        `The link stops working on ${deadline}. Email ${'claim@pdayletters.com'} again for a new one.`,
        '',
        'If you did not ask for this, ignore it — the link does nothing until',
        'someone signs in with it.',
        '',
        SIGNATURE
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p><a href="${escape(link)}" style="display:inline-block;padding:12px 20px;background:#1f4e79;color:#fff;text-decoration:none;border-radius:4px">Open your archive</a></p>`,
        `<p>${escape(situation.join(' '))}</p>`,
        `<p>Use a <strong>personal</strong> Google or Microsoft account, not your missionary one. Your missionary address stops working 60 days after you come home, and the archive is meant to outlast it.</p>`,
        `<p>The link stops working on <strong>${escape(deadline)}</strong>. Email claim@pdayletters.com again for a new one.</p>`,
        '<p>If you did not ask for this, ignore it &mdash; the link does nothing until someone signs in with it.</p>',
        `<p>&mdash; ${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html, link };
}