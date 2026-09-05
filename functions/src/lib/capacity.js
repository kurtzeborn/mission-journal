// Telling an archive's owners that it is running out of room.
//
// The letter ceiling in `cap.js` is the only limit in the service whose
// arrival is invisible to the people it affects. Every other refusal answers
// somebody who is standing there -- a picture too large, one photograph too
// many on a letter, a book the press will not bind -- and says so on the
// screen they are already looking at. This one fires inside a queue worker,
// hours after the family last opened anything, against mail that arrives on
// its own. Without these two messages the only record is a log line, read by
// nobody who can act on it.
//
// **Both are sent on the way up, not on the way out.** They fire when a letter
// is committed and the archive reaches an exact count, so the second one lands
// as the archive becomes full rather than after a letter has already been
// refused. By the time anything can be lost the owners have been told twice.
//
// **That is also what makes them safe to send with no suppression row.**
// `commitPost` appends one letter at a time under an ETag, so every count from
// one upward is passed through exactly once and an equality test cannot
// repeat: two letters racing means one lands on the threshold and the other
// retries onto the number above it. Deleting letters and filling the archive
// again re-arms both for free, which a once-ever row in `nudges` would have
// quietly prevented.

import { readAcl, ROLE } from './acl.js';
import { ARCHIVE_CAP } from './cap.js';
import { escapeHtml as escape, mailFrom, HUMAN_ADDRESS } from './mail.js';
import { optedOut } from './optout.js';

// How much warning the first message gives. Ten letters is about two and a
// half months of a weekly p-day -- long enough to decide what to do, short
// enough that the number still reads as a deadline.
export const NEAR = 10;

const archiveUrl = (baseUrl, slug) =>
    `${String(baseUrl ?? '').replace(/\/$/, '')}/${encodeURIComponent(slug)}/`;

/**
 * The message body. Exported so its wording is testable without a mailer.
 *
 * DRAFT COPY, like the claim and nudge emails.
 *
 * The archive is named in the body and not in the subject, the same courtesy
 * nudge.js keeps: a subject line is visible on a lock screen. An owner with
 * two archives has to open it to find out which, which is the cost of that.
 *
 * The full message says the thirty days out loud. It is the one fact that
 * decides whether this is urgent, and an owner who does not know it will
 * reasonably assume a refused letter is either safe forever or already gone.
 */
export function roomEmail({ slug, count, cap = ARCHIVE_CAP, baseUrl = '' }) {
    const link = archiveUrl(baseUrl, slug);
    const left = Math.max(0, cap - count);
    const full = count >= cap;

    const subject = full ? 'Your archive is full' : 'Your archive is nearly full';

    const opening = full
        ? [
              `The PDayLetters.com archive for ${slug} now holds ${count} letters, which is as many as one archive can hold.`,
              'The next letter sent to it will not be added.'
          ]
        : [
              `The PDayLetters.com archive for ${slug} holds ${count} letters, and one archive can hold ${cap} maximum.`,
              `That leaves room for ${left} more. Once it is full, letters sent to it will not be added.`
          ];

    const closing = full
        ? [
              'A refused letter is not immediately lost -- we keep the original for thirty',
              'days and can put it back once there is room -- but after that it is gone, so',
              'this is worth addressing this month.'
          ]
        : [
              'Over the course of a two-year mission, letters run to about a hundred',
              '(fewer for an eighteen-month one), so most archives never come near this.',
              'If yours has, your best option is to delete any superfluous content, or to',
              'combine letters from the same day or week using the edit feature.'
          ];

    const text = [
        ...opening,
        '',
        'You can make room by deleting letters you no longer need:',
        '',
        `  ${link}`,
        '',
        ...closing,
        '',
        'If you would rather keep all of them, reply to this message and we will work',
        'something out.',
        '',
        'Pday Letters'
    ].join('\n');

    const html = [
        `<p>${escape(opening.join(' '))}</p>`,
        `<p>You can make room by <a href="${escape(link)}">deleting letters you no longer need</a>.</p>`,
        `<p>${escape(closing.join(' '))}</p>`,
        '<p>If you would rather keep all of them, reply to this message and we will work something out.</p>',
        '<p>Pday Letters</p>'
    ].join('\n');

    return { subject, text, html };
}

/**
 * Warn the owners, if this letter is the one that reaches a threshold.
 *
 * Silent for every other count, which is almost all of them -- the equality
 * test is the whole of the rate limiting.
 *
 * @param {object} input
 * @param {object} input.store   for the ACL
 * @param {object} input.tables  for the opt-out list; optional
 * @param {object} input.mailer
 * @param {string} input.slug
 * @param {number} input.count   how many letters the archive holds now
 */
export async function warnIfFilling({
    store,
    tables = null,
    mailer,
    slug,
    count,
    baseUrl = '',
    cap = ARCHIVE_CAP,
    log = console
}) {
    if (!store || !mailer || !slug) return { status: 'skipped' };
    if (count !== cap - NEAR && count !== cap) return { status: 'quiet' };

    const members = (await readAcl(store, slug)) ?? [];
    const owners = new Set(
        members
            .filter((member) => member.role === ROLE.owner && member.email)
            .map((member) => String(member.email).toLowerCase())
    );

    const body = roomEmail({ slug, count, cap, baseUrl });
    let sent = 0;

    for (const to of owners) {
        // The rule digest.js sets: somebody who said stop has said something
        // stronger than any preference of ours, and this is not urgent enough
        // to be the exception that overrules them.
        if (tables && (await optedOut({ tables, email: to }))) continue;

        try {
            const result = await mailer.send({
                from: mailFrom(HUMAN_ADDRESS),
                to,
                subject: body.subject,
                text: body.text,
                html: body.html,
                // Generated rather than replied: nothing was sent to us. It
                // still invites a reply, which is why it comes from the human
                // address and not from `post@`.
                headers: { 'Auto-Submitted': 'auto-generated' },
                log
            });
            if (result?.status === 'sent') sent += 1;
        } catch (error) {
            // One owner's bad address must not cost the others their warning,
            // and none of this may make the sender's server redeliver a letter
            // that is already safely stored.
            log.error?.('capacity: could not warn an owner', { slug, error: error.message });
        }
    }

    log.info?.('capacity: archive filling up', { slug, count, cap, owners: owners.size, sent });
    return { status: 'warned', owners: owners.size, sent };
}
