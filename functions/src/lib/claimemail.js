// The claim email.
//
// Goes out as a reply to an arriving letter, so that it threads into a
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
    const deadline = readableDate(expiresAt);
    const single = messageCount === 1;

    // A variant rather than a separate function, unlike the `claim@` reply:
    // the situation is identical either way -- a pending site, a first-come
    // link, a hold that expires. What differs is who is reading. A parent who
    // forwarded a letter thirty seconds ago knows why they are hearing from us.
    // The missionary is being told about mail they sent themselves, to the very
    // address it was sent from, so the third person reads like a notice about
    // somebody else's post.
    const opening = forwarded
        ? `You forwarded ${single ? 'a letter' : `${messageCount} letters`} from ${sender} to ${SIGNATURE}.`
        : `${single ? 'Your letter has' : `Your ${messageCount} letters have`} arrived at ${SIGNATURE}.`;

    const held = single
        ? [
              'It is being held, not published. Nobody can read it, including us,',
              'until someone sets up the archive and chooses who to share it with.'
          ]
        : [
              'They are being held, not published. Nobody can read them, including us,',
              'until someone sets up the archive and chooses who to share it with.'
          ];

    // Only the missionary hears this. A forwarder is already the person doing
    // the setting up, and inviting them to pass it on would send them looking
    // for somebody else to ask.
    const handoff = [
        'You can do that yourself, or forward this email to a parent, family',
        "member or friend and they'll do it for you."
    ];

    // Both are told to use a personal account; only the missionary is told
    // which account that rules out, because only they hold a mailbox with an
    // expiry date on it.
    const personal = forwarded
        ? [
              'Please use a personal account rather than a work or school one. This',
              'archive is meant to outlast the job you have today.'
          ]
        : [
              'Please use a personal account rather than your official missionary',
              'one. That address stops working after you come home, and the archive',
              'is meant to outlast it.'
          ];

    // No name, no slug, no count. This line is visible without unlocking a
    // phone, and it is forwarded more often than the body is read.
    const subject = 'Your missionary letters are being saved';

    const text = [
        opening,
        '',
        ...held,
        '',
        'Set it up here:',
        link,
        ...(forwarded ? [] : ['', ...handoff]),
        '',
        ...personal,
        '',
        `If nobody sets it up by ${deadline}, ${single ? 'the letter stops' : 'the letters stop'} being held.`,
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
            ? `<p>You forwarded ${single ? 'a letter' : `${messageCount} letters`} from <strong>${escape(sender)}</strong> to ${SIGNATURE}.</p>`
            : `<p>${escape(opening)}</p>`,
        `<p>${held.join(' ')}</p>`,
        `<p><a href="${escape(link)}" style="display:inline-block;padding:12px 20px;background:#1f4e79;color:#fff;text-decoration:none;border-radius:4px">Set up the archive</a></p>`,
        forwarded ? '' : `<p>${handoff.join(' ')}</p>`,
        `<p>Please use a <strong>personal</strong> account rather than ${forwarded
            ? 'a work or school one. This archive is meant to outlast the job you have today.'
            : 'your official missionary one. That address stops working after you come home, and the archive is meant to outlast it.'}</p>`,
        `<p>If nobody sets it up by <strong>${escape(deadline)}</strong>, ${single ? 'the letter stops' : 'the letters stop'} being held. Every new letter that arrives extends that date.</p>`,
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
 * so the reassurance leads and the rights follow: this link displaces nobody,
 * and what the missionary chooses to do afterwards is a separate question they
 * are told they have the standing to answer.
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
        'Use a personal Google or Microsoft account, not your official missionary',
        'one. That address stops working 60 days after you come home, and the',
        'archive is meant to outlast it.'
    ];

    // "Nobody can remove you" is a promise `members.js` keeps: a
    // `verifiedMissionary` owner cannot be removed or demoted by anyone, an
    // operator included. Do not soften it here without changing it there.
    const situation = alreadyOwned
        ? [
              'Your archive already has someone looking after it, and you are added',
              'alongside them rather than in place of them. Once you are, nobody can',
              'remove you. These are your letters and this is your archive: you can',
              'add or remove other owners, and you can delete it outright.'
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
        `The link stops working on ${deadline}. Email claim@pdayletters.com`,
        'again for a new one.',
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
        `<p>Use a <strong>personal</strong> Google or Microsoft account, not your official missionary one. That address stops working 60 days after you come home, and the archive is meant to outlast it.</p>`,
        `<p>The link stops working on <strong>${escape(deadline)}</strong>. Email claim@pdayletters.com again for a new one.</p>`,
        '<p>If you did not ask for this, ignore it &mdash; the link does nothing until someone signs in with it.</p>',
        `<p>&mdash; ${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html, link };
}