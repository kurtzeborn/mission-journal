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
import { escapeHtml as escape, mailFrom } from './mail.js';

const SIGNATURE = 'Pday Letters';

// Two things can go wrong on the way to a first letter, and they need
// different answers.
//
//   `attach` -- the client quoted the letter inline. Usually fixable from a
//   menu, but not always: the Outlook and Gmail phone apps have no "forward
//   as attachment" item at all, so this advice is unfollowable for anyone
//   holding only a phone. Both kinds therefore carry the relay link.
//
//   `rebuilt` -- the letter was attached, correctly, and the client rebuilt it
//   on the way out, which erases the proof that the missionary wrote it. Not
//   fixable from a menu, and the classic desktop Outlook client does it to
//   every message it forwards. This is the one that needs a way out.
//
// Offering the relay from both costs nothing in security, which is worth
// stating because it looks as though it should. The author address on an
// inline forward is attacker-controlled text; the author address on an
// unverified attachment is an attacker-controlled header in a file they
// wrote. Neither is evidence, and the fences are the same for both: the
// requester's own DMARC has already passed, so we know who asked; the note
// names them; and only one grant per missionary can be outstanding at a time.
export const NUDGE = { attach: 'attach', rebuilt: 'rebuilt' };


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
 * The FAQ link is anchored at `#forward-did-nothing` rather than pointing at
 * the top of the page. Someone reading this has one question, and a link that
 * lands them on a contents list has made them do the work of finding it again.
 *
 * @param {object} input
 * @param {string} input.author   the missionary the forwarded letter was from
 * @param {string} input.baseUrl  e.g. https://pdayletters.com
 * @param {string} [input.kind]   a NUDGE value
 * @param {string} [input.askUrl] the relay link
 * @param {string} [input.requester] the address the missionary will be asked
 *                                   to forward to, shown so the reader can
 *                                   check it before spending anyone's time
 */
export function nudgeEmail({ author, baseUrl, kind = NUDGE.attach, askUrl = '', requester = '' }) {
    const faq = `${String(baseUrl ?? '').replace(/\/$/, '')}/faq#forward-did-nothing`;
    return kind === NUDGE.rebuilt
        ? rebuiltEmail({ author, faq, askUrl, requester })
        : attachEmail({ author, faq, askUrl, requester });
}

/**
 * The second route, written once and used by both replies so they cannot drift
 * apart. The heading differs between them; everything below it does not.
 *
 * The link is anchored rather than printed bare. A naked URL in a message about
 * not trusting unverified mail reads exactly like the thing it is warning
 * about, and it is the plain-text part that forces the URL to appear at all --
 * there is no way to anchor text without HTML, and an instruction to "click
 * this link" with no link to click is worse than an ugly one.
 */
function askRoute({ heading, askUrl, requester }) {
    const who = requester || 'you';

    const text = [
        heading.text,
        '',
        '   Click this link to send a short email to your missionary with a',
        '   link to get started.',
        '',
        askUrl ? `   ${askUrl}` : '   (link unavailable — please write to us instead)',
        '',
        `   The mail will ask the missionary to forward it to you`,
        `   (${who}) and you will take care of it from there.`,
        '   You can then click the link you got from the missionary and get',
        '   things started.',
        '',
        '   We do this so that missionaries are never spoofed or faked on this',
        '   site. We do this out of deep respect for missionaries and their',
        '   families.'
    ];

    const opener = askUrl
        ? `<a href="${escape(askUrl)}">Click this link</a>`
        : 'Click this link (unavailable &mdash; please write to us instead)';

    const html = [
        heading.html,
        `<p>${opener} to send a short email to your missionary with a link to get started.</p>`,
        `<p>The mail will ask the missionary to forward it to you (<strong>${escape(who)}</strong>) and you will take care of it from there. You can then click the link you got from the missionary and get things started.</p>`,
        '<p>We do this so that missionaries are never spoofed or faked on this site. We do this out of deep respect for missionaries and their families.</p>'
    ];

    return { text, html };
}

// Two routes here as well, ordered on the same principle as the other reply:
// the fix that costs nobody anything comes first, and the one that spends a
// missionary's limited minutes comes second, framed as what to do when the
// menu item is missing rather than as an equal choice.
function attachEmail({ author, faq, askUrl, requester }) {
    const subject = 'That letter did not come through — how to send it again';

    const route2 = askRoute({
        heading: {
            text: `2. Or, if you cannot find that menu item, let us ask\n   ${author} to vouch for you.`,
            html: `<p><strong>2. Or, if you cannot find that menu item, let us ask ${escape(author)} to vouch for you.</strong></p>`
        },
        askUrl,
        requester
    });

    const text = [
        `Thanks for forwarding a letter from ${author} to ${SIGNATURE}.`,
        '',
        'Unfortunately, the manner in which you forwarded it to us is not',
        'secure enough to start an archive. We need you to do it again in a',
        'more secure way, and there are two ways to do that.',
        '',
        '1. Forward the letter again as an attachment.',
        '',
        '   In your mail program, instead of Forward, look for:',
        '',
        '     Gmail          More (⋮) > Forward as attachment',
        '     Outlook        More actions (…) > Forward as attachment',
        '     Apple Mail     Message > Forward as Attachment',
        '',
        `   Send that to ${POST_ADDRESS} and we will write straight back`,
        '   with a link to set up the archive.',
        '',
        ...route2.text,
        '',
        'Either way, this is only needed for the first letter.',
        '',
        `For further information, consult our FAQ at ${faq}`,
        '',
        SIGNATURE
    ].join('\n');

    // Deliberately the same words as the plain-text part. A client that shows
    // one and a client that shows the other should not be able to disagree
    // about what was said, and nothing in the send path checks that they match.
    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p>Thanks for forwarding a letter from <strong>${escape(author)}</strong> to ${SIGNATURE}.</p>`,
        '<p>Unfortunately, the manner in which you forwarded it to us is not secure enough to start an archive. We need you to do it again in a more secure way, and there are two ways to do that.</p>',
        '<p><strong>1. Forward the letter again as an attachment.</strong></p>',
        '<p>In your mail program, instead of Forward, look for:</p>',
        '<ul>',
        '<li><strong>Gmail</strong> &mdash; More (&#8942;) &gt; Forward as attachment</li>',
        '<li><strong>Outlook</strong> &mdash; More actions (&hellip;) &gt; Forward as attachment</li>',
        '<li><strong>Apple Mail</strong> &mdash; Message &gt; Forward as Attachment</li>',
        '</ul>',
        `<p>Send that to <strong>${POST_ADDRESS}</strong> and we will write straight back with a link to set up the archive.</p>`,
        ...route2.html,
        '<p>Either way, this is only needed for the first letter.</p>',
        `<p>For further information, consult <a href="${escape(faq)}">our FAQ</a>.</p>`,
        `<p>${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html };
}

/**
 * The reply when the letter was attached properly and still did not verify.
 *
 * The tone matters more here than anywhere else in the service. This person
 * did everything right, twice, and is being told no by a machine. So the mail
 * says outright that it is not their fault, names the cause, and does not
 * repeat advice they have already followed.
 *
 * The two routes are ordered deliberately. Outlook on the web is first because
 * it costs nobody anything and it works. Asking the missionary is second
 * because it spends somebody else's time -- a missionary has a set number of
 * minutes to write home, and this would take some of them.
 */
function rebuiltEmail({ author, faq, askUrl, requester }) {
    const subject = 'That letter did not come through — two ways to fix it';

    const route2 = askRoute({
        heading: {
            text: `2. Or let us ask ${author} to vouch for you.`,
            html: `<p><strong>2. Or let us ask ${escape(author)} to vouch for you.</strong></p>`
        },
        askUrl,
        requester
    });

    const text = [
        `Thanks for forwarding a letter from ${author} to ${SIGNATURE}.`,
        '',
        'You attached it, which is exactly right. The problem is not something',
        'you did. Your mail program rebuilt the letter as it sent it, and that',
        'erases the proof that the missionary wrote it. We cannot start an',
        'archive without that proof, and forwarding it the same way again will',
        'not work.',
        '',
        'This happens with the classic Outlook app on Windows and with the',
        'Outlook app on Android. There are two ways around it.',
        '',
        '1. Forward it again from Outlook on the web.',
        '',
        '   Open outlook.com in a browser, find the letter, and use',
        `   More actions (…) > Forward as attachment to ${POST_ADDRESS}.`,
        '   Outlook on the web keeps the part we need, so this works. The new',
        '   Outlook for Windows is the same program and works just as well.',
        '',
        ...route2.text,
        '',
        'Either way, this is only needed for the first letter.',
        '',
        `For further information, consult our FAQ at ${faq}`,
        '',
        SIGNATURE
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p>Thanks for forwarding a letter from <strong>${escape(author)}</strong> to ${SIGNATURE}.</p>`,
        '<p>You attached it, which is exactly right. The problem is not something you did. Your mail program rebuilt the letter as it sent it, and that erases the proof that the missionary wrote it. We cannot start an archive without that proof, and forwarding it the same way again will not work.</p>',
        '<p>This happens with the classic Outlook app on Windows and with the Outlook app on Android. There are two ways around it.</p>',
        '<p><strong>1. Forward it again from Outlook on the web.</strong></p>',
        `<p>Open outlook.com in a browser, find the letter, and use More actions (&hellip;) &gt; Forward as attachment to <strong>${POST_ADDRESS}</strong>. Outlook on the web keeps the part we need, so this works. The new Outlook for Windows is the same program and works just as well.</p>`,
        ...route2.html,
        '<p>Either way, this is only needed for the first letter.</p>',
        `<p>For further information, consult <a href="${escape(faq)}">our FAQ</a>.</p>`,
        `<p>${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html };
}

/**
 * Send it, at most once per person per missionary per kind.
 *
 * Keyed on the missionary as well as the person: a parent with two children
 * out at once has two archives to start, and getting the advice for the first
 * does not help them with the second if they never read it. Keyed on the
 * sender because the advice is about *their* mail client.
 *
 * Keyed on the kind too, which it was not originally, and the omission was a
 * trap: the ordinary path through this is inline first, attachment second, so
 * a single key per person per missionary meant the one piece of advice that
 * actually unblocks an Outlook user could never be sent -- it would always be
 * suppressed by the advice they had already followed.
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
 * @param {string} input.baseUrl
 * @param {string} [input.kind]  a NUDGE value
 * @param {string} [input.askUrl]
 */
export async function nudgeOnce({
    tables,
    mailer,
    to,
    author,
    slug,
    baseUrl = '',
    kind = NUDGE.attach,
    askUrl = '',
    now = () => new Date(),
    log = console
}) {
    if (!tables || !mailer || !to || !slug) return { status: 'skipped' };

    const at = now().toISOString();
    const recipient = String(to).toLowerCase();

    const first = await tables.insertEntity(TABLES.nudges, {
        partitionKey: recipient,
        rowKey: `${slug}:${kind}`,
        sentAt: at,
        author: author ?? ''
    });

    if (!first) {
        log.info?.('nudge: already advised, staying quiet', { slug, kind });
        return { status: 'duplicate' };
    }

    const body = nudgeEmail({ author, baseUrl, kind, askUrl, requester: recipient });
    const result = await mailer.send({
        from: mailFrom(POST_ADDRESS),
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

    log.info?.('nudge: sent', { slug, kind, status: result.status });
    return { status: result.status };
}

/**
 * Forget having advised somebody, so that the advice can be given again.
 *
 * The once-only rule is right for the automatic path and wrong for a person:
 * an operator looking at a refused letter can see that the advice was sent
 * weeks ago and went unread, or was sent when the advice itself was wrong --
 * which it was, until recently, for every Outlook user. Rather than a second
 * kind of nudge with its own key, this simply removes the suppression and
 * lets the ordinary send run.
 */
export async function forgetNudge({ tables, to, slug, kind = NUDGE.attach }) {
    if (!tables || !to || !slug) return false;
    await tables.deleteEntity(TABLES.nudges, String(to).toLowerCase(), `${slug}:${kind}`);
    return true;
}
