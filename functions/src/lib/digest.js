// Telling people a letter arrived.
//
// Until this existed the service published letters to a website and never
// mentioned it to anybody. Grandparents are a core audience and will not
// remember to check a URL, so without a nudge the archive gets built for
// readers who never arrive.
//
// Four rules hold this together, and each of them is a decision rather than
// an implementation detail:
//
//   **Freshness is measured on arrival, not on the date the letter carries.**
//   Same distinction the operator's flow view is built around, pointed at a
//   reader instead of an operator. A family forwarding two years of backlog
//   in one evening has just given everybody twenty new letters to read; on
//   `originalDate` that is a digest covering 2024 that goes to nobody,
//   because nothing in the window is dated inside it.
//
//   **Hidden letters are dropped by the same code that drops them for a
//   reader.** `presentPosts` with a reader's role is the only filter here,
//   because a second rule that agrees with the first today is a second rule
//   that disagrees with it later -- and the way it would fail is by mailing
//   the contents of a letter an owner hid.
//
//   **No pictures.** The design asked for a thumbnail per letter and it
//   cannot have one: every rendition in this service is behind the ACL, so an
//   `<img>` in an email is either broken for everybody or served from a
//   public URL. It would also be a public URL that Gmail fetches and caches
//   on its own proxy the moment the message is opened. A count of the
//   photographs says the same useful thing -- there are pictures, come and
//   look -- and discloses nothing to an inbox.
//
//   **Nothing goes out empty.** Never a "no new letters this month" email.
//   It is pure noise, and it would arrive most reliably during exactly the
//   stretch -- a transfer, a sick week, a missionary between areas -- when
//   the family is already uneasy about the silence.

import { ROLE } from './acl.js';
import { flowBody } from './bookflow.js';
import { escapeHtml as escape, HUMAN_ADDRESS, mailFrom } from './mail.js';
import { membershipsFor } from './memberships.js';
import { issueOptOut, optedOut, unsubscribeHeaders } from './optout.js';
import { presentPosts } from './present.js';
import { digestDue, everyUser, markDigested } from './users.js';

const SIGNATURE = 'Pday Letters';

// Long enough to recognise a letter, short enough that nobody reads the
// digest instead of the archive. The second half matters more: the point of
// this message is to get somebody to the letters, and a digest that contains
// the letters is a digest that replaces them.
const SNIPPET = 180;


const readableDate = (iso) => {
    const at = new Date(String(iso ?? '').slice(0, 19) + 'Z');
    if (Number.isNaN(at.getTime())) return '';
    return at.toLocaleDateString('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
};

/**
 * The opening of a letter, as text.
 *
 * Reuses the book's flattener rather than stripping tags here. It is the one
 * piece of code in the service that already knows a letter's markup is not
 * its text -- that `<br>` is a newline, that an alt attribute is not prose,
 * that mail clients indent with tables -- and a second, simpler answer to
 * that question would be wrong in a way nobody notices until it quotes a
 * style attribute at a grandmother.
 */
export function snippetOf(post, slug, limit = SNIPPET) {
    let text = '';

    if (post.bodyHtml) {
        for (const block of flowBody(post.bodyHtml, slug)) {
            if (!block.runs) continue;
            text = `${text} ${block.runs.map((run) => run.text).join('')}`;
            if (text.length > limit) break;
        }
    } else {
        text = String(post.bodyText ?? '');
    }

    text = text.replace(/\s+/g, ' ').trim();
    if (text.length <= limit) return text;

    // Cut at a space, so the last thing a reader sees is a word rather than
    // half of one. Falls back to the hard cut for a language that does not
    // put spaces between words.
    const cut = text.slice(0, limit);
    const space = cut.lastIndexOf(' ');
    return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}\u2026`;
}

/**
 * The letters that arrived in one archive since a given moment.
 *
 * The visible set comes from `presentPosts`, and `receivedAt` is joined back
 * on afterwards by id. It reads like a detour and it is the point: the reader
 * projection deliberately does not carry `receivedAt`, so taking the window
 * from it would mean either widening what every reader is sent or keeping a
 * second copy of the hidden rule here. The join keeps both where they are.
 */
export async function lettersSince({ store, slug, since }) {
    const blob = await store.readBlob('rendered', `${slug}/posts.json`);
    if (!blob) return [];

    let stored;
    try {
        stored = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
    } catch {
        // One unreadable archive must not stop everybody else's digest.
        return [];
    }
    if (!Array.isArray(stored)) return [];

    const arrived = new Map(stored.map((post) => [post.id, String(post.receivedAt ?? '')]));

    return presentPosts(stored, ROLE.reader)
        .filter((post) => arrived.get(post.id) > since)
        .map((post) => ({
            id: post.id,
            subject: String(post.subject ?? '').trim(),
            date: post.originalDate ?? '',
            photos: (post.photos ?? []).length,
            snippet: snippetOf(post, slug)
        }));
}

/**
 * Everything one person has to catch up on, across every archive they belong
 * to. Archives with nothing new are not in the list at all.
 */
export async function newFor({ store, tables, email, since }) {
    const memberships = await membershipsFor({ tables, email });
    const archives = [];

    for (const membership of memberships) {
        // The site row already knows when this archive last received
        // anything, so an archive that has been quiet all month costs a map
        // lookup instead of reading and parsing its whole `posts.json`. It is
        // only ever a skip: a blank or stale value falls through to the read.
        if (membership.lastReceivedAt && membership.lastReceivedAt <= since) continue;

        const letters = await lettersSince({ store, slug: membership.slug, since });
        if (!letters.length) continue;

        archives.push({
            slug: membership.slug,
            name: membership.missionaryDisplayName || membership.slug,
            letters
        });
    }

    return archives;
}

/**
 * @param {object} input
 * @param {string} input.baseUrl
 * @param {object[]} input.archives  from `newFor`
 * @param {string} [input.optOutToken]
 */
export function digestEmail({ baseUrl, archives, optOutToken = '' }) {
    const root = baseUrl.replace(/\/$/, '');
    const optOut = optOutToken ? `${root}/optout#${optOutToken}` : '';
    const count = archives.reduce((total, archive) => total + archive.letters.length, 0);
    const letters = count === 1 ? '1 new letter' : `${count} new letters`;

    // The missionary is named in the subject, which is the opposite of the
    // rule the claim and invitation emails follow -- and the rule is about
    // entitlement, not about lock screens in general. Those messages go to
    // somebody who has not been granted anything yet and may never be. This
    // one goes to a person already on the archive's ACL, and a subject line
    // reading "you have mail from a website" is how a digest gets ignored.
    const subject =
        archives.length === 1
            ? `${letters} from ${archives[0].name}`
            : `${letters} on ${SIGNATURE}`;

    const link = (archive) => `${root}/${encodeURIComponent(archive.slug)}/`;
    const deep = (archive, letter) => `${link(archive)}#panel-${encodeURIComponent(letter.id)}`;

    const pictures = (letter) =>
        letter.photos === 0 ? '' : letter.photos === 1 ? '1 photograph' : `${letter.photos} photographs`;

    const text = [
        count === 1 ? 'A new letter has arrived.' : `${count} new letters have arrived.`,
        ...archives.flatMap((archive) => [
            '',
            `${archive.name}`,
            '-'.repeat(archive.name.length),
            ...archive.letters.flatMap((letter) => {
                const when = readableDate(letter.date);
                const shot = pictures(letter);
                return [
                    '',
                    [letter.subject || '(no subject)', when].filter(Boolean).join(' \u2014 '),
                    ...(letter.snippet ? [letter.snippet] : []),
                    ...(shot ? [shot] : []),
                    deep(archive, letter)
                ];
            }),
            '',
            `All of ${archive.name}'s letters: ${link(archive)}`
        ]),
        '',
        'You are getting this because you asked us to tell you when letters',
        'arrive. Change how often, or stop it altogether, on the settings page:',
        `${root}/email`,
        ...(optOut ? ['', 'Or stop all of our email to this address:', optOut] : []),
        '',
        SIGNATURE
    ].join('\n');

    const html = [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5">',
        `<p>${count === 1 ? 'A new letter has arrived.' : `<strong>${count}</strong> new letters have arrived.`}</p>`,
        ...archives.map((archive) =>
            [
                `<h2 style="font-size:18px;margin:24px 0 8px">${escape(archive.name)}</h2>`,
                ...archive.letters.map((letter) => {
                    const shot = pictures(letter);
                    return [
                        '<div style="margin:0 0 18px;padding-left:12px;border-left:3px solid #e6e1d8">',
                        `<p style="margin:0"><a href="${escape(deep(archive, letter))}" style="color:#1f4e79;font-weight:600;text-decoration:none">${escape(letter.subject || '(no subject)')}</a>`,
                        readableDate(letter.date)
                            ? ` <span style="color:#666">&mdash; ${escape(readableDate(letter.date))}</span>`
                            : '',
                        '</p>',
                        letter.snippet ? `<p style="margin:4px 0 0">${escape(letter.snippet)}</p>` : '',
                        shot ? `<p style="margin:4px 0 0;color:#666;font-size:14px">${escape(shot)}</p>` : '',
                        '</div>'
                    ].join('');
                }),
                `<p><a href="${escape(link(archive))}" style="display:inline-block;padding:10px 18px;background:#1f4e79;color:#fff;text-decoration:none;border-radius:4px">Read ${escape(archive.name)}&rsquo;s letters</a></p>`
            ].join('')
        ),
        `<p style="color:#666;font-size:14px">You are getting this because you asked us to tell you when letters arrive. <a href="${escape(`${root}/email`)}">Change how often, or stop it.</a></p>`,
        optOut
            ? `<p style="color:#666;font-size:14px">Or <a href="${escape(optOut)}">stop all of our email to this address</a>.</p>`
            : '',
        `<p>&mdash; ${SIGNATURE}</p>`,
        '</div>'
    ].join('');

    return { subject, text, html, count };
}

/**
 * One person's turn.
 *
 * Returns what happened rather than throwing, because this is called in a
 * loop over everybody and one address's bad day is not everybody else's.
 */
export async function digestOne({ store, tables, mailer, row, key, baseUrl, now, log = console }) {
    const email = row.partitionKey;
    const at = now().toISOString();

    // Above the preference, never merged into it. Somebody who said stop has
    // said something stronger than "monthly", and the row still saying
    // "monthly" is not a contradiction -- it is what they will get back if
    // they ever ask us to start again.
    if (await optedOut({ tables, email })) {
        await markDigested({ tables, email, at });
        return { status: 'suppressed' };
    }

    const archives = await newFor({ store, tables, email, since: row.digestAt ?? '' });

    // The cycle is over either way. Moving the window over a quiet month
    // cannot lose a letter -- there were none in it.
    await markDigested({ tables, email, at });

    if (!archives.length) return { status: 'empty' };

    // One token, spent in two places. The link in the body and the header the
    // provider posts to are the same promise, and minting them separately
    // would mean an address could be suppressed by one and not the other if
    // the format ever grew a nonce.
    const optOutToken = key ? issueOptOut({ email, slug: archives[0].slug, key, now }) : '';
    const body = digestEmail({ baseUrl, archives, optOutToken });

    const result = await mailer.send({
        from: mailFrom(HUMAN_ADDRESS),
        to: email,
        subject: body.subject,
        text: body.text,
        html: body.html,
        headers: {
            'Auto-Submitted': 'auto-generated',
            ...(optOutToken
                ? unsubscribeHeaders({ baseUrl, token: optOutToken, humanAddress: HUMAN_ADDRESS })
                : {})
        },
        log
    });

    // No retry and no rollback. `digestAt` has already moved, so a letter
    // that failed to send is a letter that will not be mentioned again --
    // which is the right way round for a message whose entire purpose is to
    // be a nudge. Putting the window back would mean a provider having a bad
    // hour turns into the same digest arriving every day until it stops.
    if (result.status !== 'sent') {
        log.error?.('digest: could not deliver', { status: result.status, letters: body.count });
    }

    return { status: result.status, letters: body.count, archives: archives.length };
}

/**
 * The whole run.
 *
 * Sequential on purpose. This is a handful of rows once a day, and the thing
 * on the other end is a mail provider with a reputation attached to how the
 * traffic looks.
 */
export async function runDigests({
    store,
    tables,
    mailer,
    key = '',
    baseUrl,
    now = () => new Date(),
    log = console
}) {
    const rows = await everyUser({ tables });
    const due = rows.filter((row) => digestDue({ row, now }));

    let sent = 0;
    let empty = 0;
    let failed = 0;

    for (const row of due) {
        let result;
        try {
            result = await digestOne({ store, tables, mailer, row, key, baseUrl, now, log });
        } catch (error) {
            // Not `markDigested`, deliberately: this one did not get a cycle,
            // so tomorrow's run tries the same window again.
            log.error?.('digest: failed', { detail: error.message });
            failed++;
            continue;
        }

        if (result.status === 'sent') sent++;
        else if (result.status === 'empty' || result.status === 'suppressed') empty++;
        else failed++;
    }

    return { considered: rows.length, due: due.length, sent, empty, failed };
}
