// Making it stop.
//
// Everything else this service sends is a reply. A claim email answers a
// letter somebody forwarded; a nudge answers a letter that arrived the wrong
// way. In every one of those cases the recipient wrote to us first, and the
// remedy for unwanted mail is simply to stop writing.
//
// An invitation is the exception, and it is the only one. It goes to somebody
// who has never heard of this service, chosen by a third party, at an address
// that third party typed. Until this module existed there was no way for that
// person to stop it: they could ignore the link, and a fortnight later a
// well-meaning relative could send another. That is the definition of the
// thing anti-spam law exists about, and "the owner will probably stop" is not
// a control.
//
// Three decisions worth stating, because each had a cheaper wrong answer:
//
//   **The opt-out is global, not per archive.** Somebody who says "stop
//   emailing me" has not said "stop emailing me about Elder Example". Making
//   them repeat it once per family would be a way of technically honouring a
//   request while defeating it.
//
//   **The address is inside the signature.** The endpoint never takes anybody's
//   word for whom to suppress. If it did, the opt-out form would be a way to
//   silence a stranger -- to stop a grandmother ever receiving the invitation
//   her family is about to send.
//
//   **It is spent by POST, never by GET.** Mail providers and corporate
//   scanners fetch every link in a message before its recipient sees it. A GET
//   that suppressed an address would mean the scanners decided, and the person
//   the mail was for would simply never hear from us again with no idea why.
//   The machine-readable header is a POST for the same reason -- RFC 8058
//   exists precisely because one-click unsubscribe had this bug.

import { createHash } from 'node:crypto';
import { issueClaimToken, PURPOSE, verifyClaimToken } from './claimtoken.js';
import { TABLES } from './tables.js';

const lower = (value) => String(value ?? '').trim().toLowerCase();

// Long enough not to matter.
//
// An opt-out link is found months after it arrives -- that is when somebody
// looks at an old message and decides they have had enough -- so the usual
// argument for a short life is inverted here: an expired opt-out is a promise
// withdrawn. Expiry exists in the token format at all to limit the damage a
// leaked link can do, and the damage this one can do is to stop us emailing
// the address it names, which is what it is for.
export const OPTOUT_YEARS = 10;

/**
 * The row key.
 *
 * Hashed because an email address may legally contain `/`, `\`, `#` and `?`,
 * none of which an Azure Table row key admits -- so some encoding is required
 * and a hash is the one that cannot collide with a legitimate address.
 *
 * The address is stored in the row as well, and that is deliberate rather than
 * careless: the question this table has to answer for a human is "why did
 * grandmother never get her invitation", and a table of hashes cannot answer
 * it. The hash is for the key, not for secrecy.
 */
export const optOutKey = (email) => createHash('sha256').update(lower(email), 'utf8').digest('hex');

const farFuture = (now) => {
    const at = new Date(now());
    at.setUTCFullYear(at.getUTCFullYear() + OPTOUT_YEARS);
    return at.toISOString();
};

/**
 * Mint the link that goes in an invitation.
 *
 * The slug rides along unused by the suppression itself, so a log line can say
 * which archive's invitation somebody opted out of without the address being
 * written down next to it.
 */
export function issueOptOut({ email, slug, key, now = () => new Date() }) {
    const them = lower(email);
    if (!them) throw new Error('opt-out: an address is required');

    return issueClaimToken({
        slug,
        key,
        expiresAt: farFuture(now),
        purpose: PURPOSE.optout,
        subject: them
    }).token;
}

/**
 * Who a token is for, without spending it.
 *
 * The address comes back so the page can show it. That is not a disclosure:
 * whoever holds this token was mailed it, and the only way to hold it is to
 * have been sent the message it was in.
 */
export function readOptOut({ token, key, now = () => new Date() }) {
    const verified = verifyClaimToken({ token, key, purpose: PURPOSE.optout, now });
    if (!verified.valid || !verified.subject) return null;
    return { email: verified.subject, slug: verified.slug };
}

/**
 * Record it. Idempotent, because the same link may be pressed twice and
 * because a provider's one-click POST may be retried.
 */
export async function recordOptOut({ tables, token, key, now = () => new Date(), log = console }) {
    const read = readOptOut({ token, key, now });
    if (!read) return { status: 'invalid' };

    await tables.upsertEntity(TABLES.optouts, {
        partitionKey: 'optout',
        rowKey: optOutKey(read.email),
        email: read.email,
        at: now().toISOString(),
        // Which invitation prompted it. Useful when an owner asks why their
        // invitations stopped arriving.
        slug: read.slug ?? ''
    });

    log.info?.('optout: recorded', { slug: read.slug });
    return { status: 'ok', email: read.email };
}

/** Has this address asked us to stop? */
export async function optedOut({ tables, email }) {
    const them = lower(email);
    if (!them) return false;
    const row = await tables.getEntity(TABLES.optouts, 'optout', optOutKey(them));
    return Boolean(row);
}

/**
 * Take it back.
 *
 * The opt-out is spent from a link because the person pressing it has no
 * account here and wants none. Undoing one is the opposite situation and
 * takes the opposite proof: signing in with the address itself. A link that
 * could restore mail to an address would be a way to sign a stranger back up,
 * which is the thing the rest of this module exists to prevent.
 *
 * Deleting the row rather than marking it withdrawn, because a suppression
 * list nobody can leave is a suppression list that eventually stops being
 * believed -- and because what the row is for is answering "may we write to
 * this address", to which the answer is now simply yes.
 */
export async function forgetOptOut({ tables, email, log = console }) {
    const them = lower(email);
    if (!them) return { status: 'invalid' };

    await tables.deleteEntity(TABLES.optouts, 'optout', optOutKey(them));

    // No address, matching `optout: recorded` above. Whether a given person
    // wants our mail is not a thing to leave lying around in a log.
    log.info?.('optout: withdrawn');
    return { status: 'ok' };
}

/**
 * The headers that make a mail client show an Unsubscribe button.
 *
 * Both forms, and the `mailto:` first, because they fail differently: the URL
 * is what Gmail's one-click button posts to, and the mailbox is what still
 * works when we are down. RFC 8058's `List-Unsubscribe-Post` is what tells a
 * provider it may act without a human -- and what stops it from *fetching* the
 * URL to see what is there.
 *
 * The token is in the query string here rather than in a fragment, which is
 * the opposite of the rule every other link in this service follows. It is the
 * right call for this one: a fragment is never sent to a server, so a provider
 * could not post to it, and the reason the rule exists elsewhere -- a token in
 * our logs is a credential in our logs -- does not apply to a token whose only
 * power is to stop us sending mail.
 */
export const unsubscribeHeaders = ({ baseUrl, token, humanAddress }) => ({
    'List-Unsubscribe': `<mailto:${humanAddress}?subject=unsubscribe>, <${baseUrl.replace(/\/$/, '')}/api/optout?t=${encodeURIComponent(token)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
});
