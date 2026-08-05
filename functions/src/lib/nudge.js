// The reply to a forward we could not verify.
//
// Everything else in this codebase drops a rejected message in silence, and
// for every other rejection that is right: the sender is either a stranger, a
// spammer, or a loop, and answering any of them is how a mail system becomes
// somebody else's problem. This is the one rejection with a different shape.
//
// A parent forwarding the first letter home is doing precisely what the
// service asks of them. The only thing wrong is a menu item -- their client
// quoted the letter inline instead of attaching it, and inline text carries no
// signature, so nothing proves the missionary wrote it. Dropping that in
// silence loses the exact person the service exists for, and they have no way
// to find out why.
//
// Two properties make replying safe, and neither is incidental:
//
//   **The sender is authenticated.** `classify` rejects on a failed DMARC
//   check long before it reaches the branch that sends this, so the address
//   being written to is one its own domain vouched for. There is no way to
//   make this mail a stranger; a sender can only ever nudge themselves.
//
//   **It is sent once.** Recorded in a table by an insert that fails if the
//   row exists, because the case this exists for -- somebody forwarding a
//   stack of old letters in one sitting -- arrives as a batch of queue
//   messages the host runs at the same time.
//
// What it costs, stated plainly: sending this confirms that no archive exists
// for that missionary, where a forward to a slug that *does* have one is
// refused in silence. That is an existence oracle, and it is accepted rather
// than overlooked. Reading it requires already knowing the missionary's exact
// address, it reveals nothing about who is in the family, and the alternative
// is losing real parents to a silent drop.

import { TABLES } from './tables.js';
import { POST_ADDRESS } from './offer.js';

const SIGNATURE = 'P-Day Letters';

const escape = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * The message body. Exported so its wording is testable without a mailer.
 *
 * DRAFT COPY, like the claim emails: written so the constraints are settled
 * and checkable before anyone argues about sentences.
 *
 * It names the missionary, which the claim email deliberately refuses to do,
 * and the difference is who is reading. A claim email arrives unasked at an
 * address we inferred; this answers a message its recipient sent us seconds
 * ago, quoting back the address they themselves put in it. It still keeps the
 * name out of the subject line, which is visible on a lock screen.
 *
 * @param {object} input
 * @param {string} input.author  the missionary the forwarded letter was from
 */
export function nudgeEmail({ author }) {
    const subject = 'That letter did not come through — one thing to try';

    const text = [
        `Thanks for forwarding a letter from ${author} to ${SIGNATURE}.`,
        '',
        'We could not keep it, and it is worth saying exactly why: your mail',
        'program quoted the letter as text rather than attaching the original.',
        'Quoted text can be edited by anyone who passes it along, so there is',
        'nothing in it that proves the letter is really theirs — and starting',
        'an archive on that basis is not something we are willing to do.',
        '',
        'The fix is one menu item. Instead of Forward, look for:',
        '',
        '  Gmail          More (⋮) > Forward as attachment',
        '  Outlook        More actions (…) > Forward as attachment',
        '  Apple Mail     Message > Forward as Attachment',
        '',
        'Send that to post@pdayletters.com and we will write straight back with',
        'a link to set up the archive.',
        '',
        'This is the only time we will send you this. If it happens again,',
        'nothing further will arrive.',
        '',
        SIGNATURE
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p>Thanks for forwarding a letter from <strong>${escape(author)}</strong> to ${SIGNATURE}.</p>`,
        '<p>We could not keep it, and it is worth saying exactly why: your mail program quoted the letter as text rather than attaching the original. Quoted text can be edited by anyone who passes it along, so there is nothing in it that proves the letter is really theirs &mdash; and starting an archive on that basis is not something we are willing to do.</p>',
        '<p><strong>The fix is one menu item.</strong> Instead of Forward, look for:</p>',
        '<ul>',
        '<li><strong>Gmail</strong> &mdash; More (&#8942;) &gt; Forward as attachment</li>',
        '<li><strong>Outlook</strong> &mdash; More actions (&hellip;) &gt; Forward as attachment</li>',
        '<li><strong>Apple Mail</strong> &mdash; Message &gt; Forward as Attachment</li>',
        '</ul>',
        '<p>Send that to <strong>post@pdayletters.com</strong> and we will write straight back with a link to set up the archive.</p>',
        '<p>This is the only time we will send you this. If it happens again, nothing further will arrive.</p>',
        `<p>&mdash; ${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html };
}

/**
 * Send it, at most once per person per missionary.
 *
 * Keyed on both rather than on the sender alone: a parent with two children
 * out at once has two archives to start, and getting the advice for the first
 * does not help them with the second if they never read it. Keyed on the
 * sender as well as the slug because the advice is about *their* mail client.
 *
 * The row is written before the send, not after. The two orderings trade a
 * lost nudge against a duplicated one, and a duplicate is the failure this
 * whole function exists to prevent -- so a send that fails is not retried, and
 * the person is left where a silent drop would have left them anyway.
 *
 * @param {object} input
 * @param {object} input.tables
 * @param {object} input.mailer
 * @param {string} input.to      the forwarder, already DMARC-authenticated
 * @param {string} input.author  the missionary the letter was from
 * @param {string} input.slug
 */
export async function nudgeOnce({ tables, mailer, to, author, slug, now = () => new Date(), log = console }) {
    if (!tables || !mailer || !to || !slug) return { status: 'skipped' };

    const at = now().toISOString();
    const recipient = String(to).toLowerCase();

    const first = await tables.insertEntity(TABLES.nudges, {
        partitionKey: recipient,
        rowKey: slug,
        sentAt: at,
        author: author ?? ''
    });

    if (!first) {
        log.info?.('nudge: already advised, staying quiet', { slug });
        return { status: 'duplicate' };
    }

    const body = nudgeEmail({ author });
    const result = await mailer.send({
        from: POST_ADDRESS,
        to: recipient,
        subject: body.subject,
        text: body.text,
        html: body.html,
        // RFC 3834, same reasoning as the claim email: this answers a specific
        // message rather than firing on a schedule, and it is going to an
        // address that may well have an out-of-office responder behind it.
        headers: { 'Auto-Submitted': 'auto-replied' },
        log
    });

    log.info?.('nudge: sent', { slug, status: result.status });
    return { status: result.status };
}
