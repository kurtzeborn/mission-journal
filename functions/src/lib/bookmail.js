// The message that says a book is finished.
//
// DRAFT COPY, on the same terms as `claimemail.js` and `invitemail.js`: the
// shape and the constraints are settled and tested; the sentences are
// placeholders.
//
// This message exists because of one sentence on the book page -- "you can
// close this page, it carries on without you" -- which is only true if
// something tells them afterwards. A build takes minutes on a long mission,
// and an owner who took us at our word and closed the tab has no way to learn
// the book finished except by remembering to come back.
//
// The constraints:
//
//   **It links to the page, never to the file.** Both renditions are handed
//   out as storage links that die in a quarter of an hour, and an email is
//   read hours later by definition -- a PDF link in here would be dead before
//   most people opened it, and would arrive at the one person we were careful
//   to make the links short-lived for. `/book/<slug>` is behind the same
//   owners-only gate the button was.
//
//   **It must not name the missionary in the subject.** The rule from
//   `claimemail.js`, unchanged: subject lines are visible on a locked phone
//   and get forwarded more often than bodies get read.
//
//   **The failure is a message too, not a silence.** `delivery.js` opens by
//   saying that silence is this service's worst failure mode because it is
//   indistinguishable from success. That is exactly what a failed build looks
//   like to somebody who closed the tab. The build's own error text is
//   carried through, because the server writes those for the person reading
//   them -- "there are no letters to print yet" is something an owner can act
//   on, and "something went wrong" is not.
//
//   **Nothing here counts as a subscription.** These go to somebody who
//   pressed a button minutes ago and to nobody else, so there is no list to
//   leave and no `List-Unsubscribe` on them -- the same reasoning that keeps
//   those headers off the acknowledgement in `ack.js`. The global opt-out is
//   still honoured by the caller, because a person who has asked us to stop
//   writing to them has asked exactly that.

const SIGNATURE = 'Pday Letters';

const escape = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const bookLink = (baseUrl, slug) =>
    `${String(baseUrl ?? '').replace(/\/$/, '')}/book/${encodeURIComponent(slug)}`;

/**
 * The book is made.
 *
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {string} input.slug
 * @param {string} [input.missionary] the archive's display name
 * @param {number} [input.pages]
 * @param {number} [input.letters]
 */
export function bookReadyEmail({ baseUrl, slug, missionary = '', pages = 0, letters = 0 }) {
    const link = bookLink(baseUrl, slug);

    // Named in the body, never in the subject. The recipient is an owner of
    // this archive, so the name discloses nothing they do not already know --
    // it is here because a message about "your book" is unreadable to someone
    // who looks after two missionaries' letters.
    const whose = missionary ? `${missionary}'s letters` : 'your letters';

    const subject = 'Your book is ready to look at';

    // Sheets rather than leaves, matching the book page: it is what the
    // printer counts and what the object will physically be. Short archives
    // are padded up to two dozen, so this is often more than the letters
    // account for, and quoting both is how that stops looking like a bug.
    const size = `${plural(letters, 'letter', 'letters')}, ${plural(pages, 'page', 'pages')}`;

    const text = [
        `The book of ${whose} has finished printing to a file.`,
        '',
        `It came to ${size}.`,
        '',
        'Look it over here:',
        link,
        '',
        'You will find a review copy to read on screen, marked on every page,',
        'and the print file itself. Nothing has been sent to a printer and',
        'nothing will be until you say so.',
        '',
        'If letters arrive after today, make the book again -- it is built',
        'fresh each time from whatever the archive holds.',
        '',
        SIGNATURE
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p>The book of ${escape(whose)} has finished printing to a file. It came to ${escape(size)}.</p>`,
        `<p><a href="${escape(link)}" style="display:inline-block;padding:12px 20px;background:#1f4e79;color:#fff;text-decoration:none;border-radius:4px">Look it over</a></p>`,
        '<p>You will find a review copy to read on screen, marked on every page, and the print file itself. Nothing has been sent to a printer and nothing will be until you say so.</p>',
        '<p>If letters arrive after today, make the book again &mdash; it is built fresh each time from whatever the archive holds.</p>',
        `<p>&mdash; ${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html, link };
}

/**
 * The book is not made, and here is what went wrong.
 *
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {string} input.slug
 * @param {string} [input.missionary]
 * @param {string} [input.reason] the build's own sentence, written for a person
 */
export function bookFailedEmail({ baseUrl, slug, missionary = '', reason = '' }) {
    const link = bookLink(baseUrl, slug);
    const whose = missionary ? `${missionary}'s letters` : 'your letters';

    // Says it did not work, in the subject, deliberately. The alternative is a
    // neutral line that gets opened days later, and the thing being reported
    // is usually a five-second fix.
    const subject = 'Your book did not finish';

    const said = reason ? [`What stopped it: ${reason}`, ''] : [];
    const nothingLost = 'Nothing has happened to the letters themselves.';

    const text = [
        `The book of ${whose} did not finish.`,
        '',
        ...said,
        nothingLost,
        '',
        'Try it again here:',
        link,
        '',
        SIGNATURE
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p>The book of ${escape(whose)} did not finish.</p>`,
        ...(reason ? [`<p>What stopped it: ${escape(reason)}</p>`] : []),
        `<p>${nothingLost}</p>`,
        `<p><a href="${escape(link)}" style="display:inline-block;padding:12px 20px;background:#1f4e79;color:#fff;text-decoration:none;border-radius:4px">Try it again</a></p>`,
        `<p>&mdash; ${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html, link };
}
