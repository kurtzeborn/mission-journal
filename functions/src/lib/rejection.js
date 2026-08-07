// Telling somebody on the list why their letter did not arrive.
//
// Silence is the right answer to almost every rejected message, and nudge.js
// explains why: the sender is a stranger, a spammer, or a loop, and answering
// any of them makes this service somebody else's problem. But silence is
// exactly wrong for a person who is already on a site's ACL. They were invited
// by the owner, they can read the archive, and they forwarded a letter to it
// in good faith. Dropping that without a word means they believe it worked --
// so nobody goes looking, and the letter is simply gone. The archive's whole
// promise is that a family stops losing letters.
//
// Three fences, and they are the same three that make the nudge safe:
//
//   **The sender is authenticated.** Every reason handled here is reached
//   only after `classify` has passed DMARC on the outer sender, so the
//   address being written to is one its own domain vouched for. A sender can
//   only ever cause mail to themselves.
//
//   **The sender is on somebody's ACL.** Checked before anything is sent. A
//   stranger who forwards junk gets the same silence they always did.
//
//   **It is sent at most once a day per reason.** The case this exists for is
//   somebody forwarding a stack of old letters in one sitting, which arrives
//   as a batch of queue messages the host runs at once. Twenty identical
//   explanations is not a kindness.
//
// What it deliberately does *not* cover: anything rejected before DMARC has
// been evaluated, which includes an oversized message. That one is a real
// loss and worth solving, but the only address available at that point is an
// unauthenticated envelope sender, and mailing those is how a service becomes
// a spam relay. It needs a different answer, not this one.

import { TABLES } from './tables.js';
import { POST_ADDRESS } from './offer.js';
import { mailFrom } from './mail.js';

const SIGNATURE = 'P-Day Letters';

// The rejection reasons a member can actually cause, and the only ones this
// answers. `forwarder-not-on-acl` is absent on purpose -- by definition that
// sender is not a member, and telling them so would confirm which missionaries
// have archives. `bootstrap-*` are absent because nudge.js already answers
// them, better, with a way out.
export const TOLD = {
    noOriginal: 'no-recoverable-original',
    notMissionary: 'author-not-missionary'
};

export const isTold = (reason) => Object.values(TOLD).includes(reason);

const escape = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * The message body. Exported so its wording is testable without a mailer.
 *
 * DRAFT COPY, on the same terms as the other emails here.
 *
 * Both versions end the same way, and that ending is the point of the whole
 * message: nothing was lost, and forwarding the letter again is free. Somebody
 * who has just been told they did something wrong needs to know what it costs
 * before they will try again, and the honest answer is nothing -- duplicates
 * are detected, so the worst case of trying twice is that the second one is
 * ignored.
 *
 * @param {object} input
 * @param {string} input.reason   a TOLD value
 * @param {string} [input.author] the address the innermost letter came from
 * @param {string} [input.baseUrl]
 */
export function rejectionEmail({ reason, author = '', baseUrl = '' }) {
    const home = String(baseUrl ?? '').replace(/\/$/, '');
    const faq = `${home}/faq#forward-did-nothing`;

    const subject = 'That letter did not make it onto the site';

    const cause =
        reason === TOLD.notMissionary
            ? notMissionary(author)
            : noOriginal();

    const text = [
        'You forwarded a letter to P-Day Letters and it was not added to the',
        'archive. Here is why, so you can send it again.',
        '',
        ...cause.text,
        '',
        'Nothing was lost and nothing else was affected. The archive is exactly',
        'as it was, and you can forward the same letter as many times as you',
        'like \u2014 we recognise one we already have, so a second try can only',
        'help.',
        '',
        `More at ${faq}`,
        '',
        `${SIGNATURE} \u2014 ${home}`
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        '<p>You forwarded a letter to P-Day Letters and it was not added to the archive. Here is why, so you can send it again.</p>',
        ...cause.html,
        '<p>Nothing was lost and nothing else was affected. The archive is exactly as it was, and you can forward the same letter as many times as you like &mdash; we recognise one we already have, so a second try can only help.</p>',
        `<p><a href="${escape(faq)}">More about forwards that do not arrive</a></p>`,
        `<p>${SIGNATURE} &mdash; <a href="${escape(home)}">${escape(home)}</a></p>`,
        '</div>'
    ].join('');

    return { subject, text, html };
}

// The message carried no letter we could read: a PDF, a screenshot, or mail
// whose original had already been flattened by something else along the way.
function noOriginal() {
    return {
        text: [
            'We could not find an email inside what you sent. That usually means',
            'the letter came through as something else along the way \u2014 a PDF, a',
            'screenshot, or a message another program had already flattened.',
            '',
            'Forward the missionary\u2019s own email again, straight from your',
            'inbox. Any ordinary forward works, because you are already on the',
            'list for this archive.'
        ],
        html: [
            '<p>We could not find an email inside what you sent. That usually means the letter came through as something else along the way &mdash; a PDF, a screenshot, or a message another program had already flattened.</p>',
            '<p><strong>Forward the missionary&rsquo;s own email again, straight from your inbox.</strong> Any ordinary forward works, because you are already on the list for this archive.</p>'
        ]
    };
}

// The commonest real cause of this is a forward of a forward: an aunt sends
// the letter on to a parent, the parent sends that to us, and the innermost
// message is the aunt's rather than the missionary's. Naming the address we
// actually found is what makes that legible -- told only that the letter "was
// not from a missionary", somebody looking at a letter that plainly is from
// one has no way to work out what we mean.
function notMissionary(author) {
    const found = author
        ? [
              '',
              'The innermost message we found was from:',
              '',
              `   ${author}`
          ]
        : [];

    const foundHtml = author
        ? [`<p>The innermost message we found was from <strong>${escape(author)}</strong>.</p>`]
        : [];

    return {
        text: [
            'The letter inside your message was not sent from a missionary',
            'address, so there was no archive to put it in.',
            ...found,
            '',
            'The usual cause is forwarding a message somebody else forwarded to',
            'you. We read the innermost letter, and in that case the innermost',
            'letter is theirs rather than the missionary\u2019s.',
            '',
            'Forward the missionary\u2019s own email instead \u2014 the one that arrived',
            'from their mission address \u2014 straight from your inbox.'
        ],
        html: [
            '<p>The letter inside your message was not sent from a missionary address, so there was no archive to put it in.</p>',
            ...foundHtml,
            '<p>The usual cause is forwarding a message somebody else forwarded to you. We read the innermost letter, and in that case the innermost letter is theirs rather than the missionary&rsquo;s.</p>',
            '<p><strong>Forward the missionary&rsquo;s own email instead</strong> &mdash; the one that arrived from their mission address &mdash; straight from your inbox.</p>'
        ]
    };
}

/**
 * Is this address on any site's ACL?
 *
 * Read from the `memberships` index rather than by scanning every `acl.json`,
 * and that is a deliberate use of a derived table for something it is allowed
 * to be wrong about. A stale row here means one explanatory email to somebody
 * who was recently removed from a family's archive; a missing row means one
 * fewer. Neither grants anything, and the authority for access is untouched.
 */
export async function onAnyAcl({ tables, email }) {
    if (!tables || !email) return false;
    const rows = await tables.listEntities(TABLES.memberships, {
        partitionKey: String(email).toLowerCase()
    });
    return rows.length > 0;
}

/**
 * Explain one rejection to one member, at most once a day per reason.
 *
 * The row is written before the send, for the reason nudge.js gives: the two
 * orderings trade a lost explanation against a duplicated one, and in a batch
 * the duplicate is the failure worth preventing.
 *
 * It shares the `nudges` table rather than adding one. Both answer the same
 * question -- have we already told this person this thing? -- and the row keys
 * cannot collide, because a slug can never contain a colon and every key here
 * begins `reject:`.
 *
 * @param {object} input
 * @param {object} input.tables
 * @param {object} input.mailer
 * @param {string} input.to      the forwarder, already DMARC-authenticated
 * @param {string} input.reason  a TOLD value
 * @param {string} [input.author]
 * @param {string} [input.baseUrl]
 */
export async function explainRejection({
    tables,
    mailer,
    to,
    reason,
    author = '',
    baseUrl = '',
    now = () => new Date(),
    log = console
}) {
    if (!tables || !mailer || !to || !isTold(reason)) return { status: 'skipped' };

    const recipient = String(to).toLowerCase();

    const member = await onAnyAcl({ tables, email: recipient });
    if (!member) return { status: 'not-a-member' };

    const at = now();
    const day = at.toISOString().slice(0, 10);

    const first = await tables.insertEntity(TABLES.nudges, {
        partitionKey: recipient,
        rowKey: `reject:${reason}:${day}`,
        sentAt: at.toISOString(),
        author: author ?? ''
    });

    if (!first) {
        log.info?.('rejection: already explained today, staying quiet', { reason });
        return { status: 'duplicate' };
    }

    const body = rejectionEmail({ reason, author, baseUrl });
    const result = await mailer.send({
        from: mailFrom(POST_ADDRESS),
        to: recipient,
        subject: body.subject,
        text: body.text,
        html: body.html,
        // RFC 3834. This answers a message its recipient sent moments ago, to
        // an address that may well have an out-of-office responder behind it.
        headers: { 'Auto-Submitted': 'auto-replied' },
        log
    });

    log.info?.('rejection: explained', { reason, status: result.status });
    return { status: result.status };
}
