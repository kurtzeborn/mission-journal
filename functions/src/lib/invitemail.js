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

const SIGNATURE = 'P-Day Letters';

const readableDate = (iso) =>
    new Date(iso).toLocaleDateString('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

const escape = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {string} input.token
 * @param {string} input.invitedBy     the owner's address
 * @param {string} [input.missionary]  the archive's display name, if it has one
 * @param {string} input.role
 * @param {string} input.expiresAt
 */
export function inviteEmail({ baseUrl, token, invitedBy, missionary = '', role, expiresAt }) {
    const link = `${baseUrl.replace(/\/$/, '')}/invite#${token}`;
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
    const subject = `${invitedBy} wants to share missionary letters with you`;

    const text = [
        `${invitedBy} has invited you to read ${whose} on ${SIGNATURE}.`,
        '',
        role === 'owner'
            ? 'You have been invited as an owner, so you will be able to read the\nletters, edit them, and invite other people.'
            : 'You have been invited as a reader, so you will be able to read the\nletters and download them.',
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
        '',
        SIGNATURE
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p><strong>${escape(invitedBy)}</strong> has invited you to read ${escape(whose)} on ${SIGNATURE}.</p>`,
        role === 'owner'
            ? '<p>You have been invited as an <strong>owner</strong>, so you will be able to edit letters and invite other people as well as read them.</p>'
            : '<p>You have been invited as a <strong>reader</strong>, so you will be able to read letters and download them.</p>',
        `<p><a href="${escape(link)}" style="display:inline-block;padding:12px 20px;background:#1f4e79;color:#fff;text-decoration:none;border-radius:4px">Accept the invitation</a></p>`,
        '<p>Please use a <strong>personal</strong> account rather than a work or school one. The account you sign in with is the one that gets access &mdash; it does not have to be the address this email arrived at.</p>',
        `<p>This invitation stops working on <strong>${escape(deadline)}</strong>.</p>`,
        `<p>If you do not know ${escape(invitedBy)}, ignore this. Nothing happens until somebody follows the link.</p>`,
        `<p>&mdash; ${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html, link };
}
