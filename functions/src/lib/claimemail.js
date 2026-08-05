// The claim email.
//
// DRAFT COPY. The wording below is a placeholder written to be replaced --
// it is here so that the shape of the message, the link, and the constraints
// it has to satisfy are settled and testable before anyone argues about
// sentences.
//
// Nothing sends this yet. Phase 8 wires it to Cloudflare Email Service, where
// it will go out as a reply to an arriving letter so that it threads into a
// conversation the recipient already recognises.
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

const SIGNATURE = 'P-Day Letters';

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

const escape = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * @param {object} input
 * @param {string} input.baseUrl        e.g. https://pdayletters.com
 * @param {string} input.token
 * @param {number} input.messageCount
 * @param {string} input.sender         the missionary's address
 * @param {string} input.expiresAt
 */
export function claimEmail({ baseUrl, token, messageCount, sender, expiresAt }) {
    const link = `${baseUrl.replace(/\/$/, '')}/claim#${token}`;
    const count = plural(messageCount, 'letter', 'letters');
    const deadline = readableDate(expiresAt);

    // No name, no slug, no count. This line is visible without unlocking a
    // phone, and it is forwarded more often than the body is read.
    const subject = 'Your missionary letters are being saved';

    const text = [
        `${count} sent from ${sender} have arrived at ${SIGNATURE}.`,
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
        `<p>${escape(count)} sent from <strong>${escape(sender)}</strong> have arrived at ${SIGNATURE}.</p>`,
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
