// The invitation email.
//
// DRAFT COPY, on the same terms as `claimemail.js`: the shape and the
// constraints are settled and tested; the sentences are placeholders.
//
// The constraints that survive any rewrite:
//
//   **The link carries the token in a fragment.** Same reasoning as the claim
//   link -- `/invite#<token>` is never sent to a server, so it stays out of
//   access logs and out of reach of the scanners that mail providers run over
//   inbound links before a human sees them.
//
//   **It has to say "personal account".** Doubly here. This message is aimed
//   at grandparents, and the whole reason invitations are links rather than
//   ACL entries is that the address a family knows is not always the account
//   the person signs in with.
//
//   **It must name whoever invited them.** Unsolicited mail asking somebody
//   to sign in somewhere is indistinguishable from phishing unless it names a
//   person the recipient actually knows. This is the line that makes it
//   legible, so it is in the body and in the subject.
//
//   **It must not name the missionary in the subject.** The rule from
//   `claimemail.js`, unchanged: subjects are visible on lock screens.
//
//   **It must not say what is in the archive.** The holder of an unaccepted
//   invitation is not yet entitled to anything, and forwarded mail is how
//   they most often come to hold one.

import {
    escapeHtml as escape,
    wrapEmailHtml,
    emailButtonHtml,
    readableEmailDate as readableDate,
    SENDER_NAME as SIGNATURE
} from './mail.js';


/**
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {string} input.token
 * @param {string} input.invitedBy     the owner's address
 * @param {string} [input.missionary]  the archive's display name, if it has one
 * @param {string} input.expiresAt
 * @param {string} [input.optOutToken] signed, names the recipient; omitted only in tests
 * @param {boolean} [input.again]      an owner asked for this one to be sent a second time
 */
export function inviteEmail({
    baseUrl,
    token,
    invitedBy,
    missionary = '',
    expiresAt,
    optOutToken = '',
    again = false
}) {
    const root = baseUrl.replace(/\/$/, '');
    const link = `${root}/invite#${token}`;
    const optOut = optOutToken ? `${root}/optout#${optOutToken}` : '';
    const deadline = readableDate(expiresAt);

    // Falls back to the generic phrasing rather than to the slug. A slug is
    // derived from the missionary's email local-part, and putting it in a
    // message to somebody who has not accepted yet would disclose the address
    // itself.
    const whose = missionary ? `${missionary}'s letters` : 'a missionary\'s letters';

    // Named in the subject, deliberately breaking the usual rule that subjects
    // identify nobody. The person named is the *sender's own correspondent*,
    // not the missionary, and without it this is a stranger asking somebody to
    // sign in to a website.
    //
    // A resend says so in the subject, so it does not read as the same message
    // arriving twice from a machine. This service promises never to repeat an
    // invitation on its own, and the honest way to keep that promise visible
    // is to be plain about the one case where a person asked us to.
    const subject = again
        ? `${invitedBy} sent you this again: missionary letters to share`
        : `${invitedBy} wants to share missionary letters with you`;

    // Both halves matter. Somebody who kept the first email will try its link
    // first, and "this link cannot be used" on a message that just arrived
    // reads as the service being broken rather than as the link being old.
    const repeated = again
        ? [
              `${invitedBy} asked us to send this again. If you still have the`,
              'earlier email, use the link below instead -- the older one has',
              'stopped working.',
              ''
          ]
        : [];

    const text = [
        ...repeated,
        `${invitedBy} has invited you to read ${whose} on ${SIGNATURE}.`,
        '',
        'You have been invited as a reader, so you will be able to read the\nletters and download them.',
        '',
        'Accept here:',
        link,
        '',
        'Please use a personal account rather than a work or school one. This',
        'archive is meant to outlast the job you have today, and the account',
        'you sign in with is the one that gets access -- it does not have to be',
        'the address this email arrived at.',
        '',
        `This invitation stops working on ${deadline}.`,
        '',
        `If you do not know ${invitedBy}, ignore this. Nothing happens until`,
        'somebody follows the link.',
        // The only message this service sends that its recipient did not ask
        // for, so it is the only one that has to carry a way out. Spelled out
        // rather than left to the mail client's Unsubscribe button, which not
        // every client shows.
        ...(optOut
            ? [
                  '',
                  'To stop anyone inviting you to this service again, follow this',
                  'link. It stops all of our mail to this address, not just this',
                  'invitation:',
                  optOut
              ]
            : []),
        '',
        SIGNATURE
    ].join('\n');

    const html = wrapEmailHtml([
        again
            ? `<p style="padding:12px;background:#faf8f4;border-radius:4px">${escape(invitedBy)} asked us to send this again. If you still have the earlier email, use the button below instead &mdash; the older link has stopped working.</p>`
            : '',
        `<p><strong>${escape(invitedBy)}</strong> has invited you to read ${escape(whose)} on ${SIGNATURE}.</p>`,
        '<p>You have been invited as a <strong>reader</strong>, so you will be able to read letters and download them.</p>',
        emailButtonHtml(link, 'Accept the invitation'),
        '<p>Please use a <strong>personal</strong> account rather than a work or school one. The account you sign in with is the one that gets access &mdash; it does not have to be the address this email arrived at.</p>',
        `<p>This invitation stops working on <strong>${escape(deadline)}</strong>.</p>`,
        `<p>If you do not know ${escape(invitedBy)}, ignore this. Nothing happens until somebody follows the link.</p>`,
        optOut
            ? `<p style="color:#666;font-size:14px">Would rather we did not write to you? <a href="${escape(optOut)}">Stop all email to this address.</a></p>`
            : '',
        `<p>&mdash; ${SIGNATURE}</p>`
    ]);

    return { subject, text, html, link, optOut };
}