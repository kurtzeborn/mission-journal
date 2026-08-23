// Sending mail, through Cloudflare Email Service's REST API.
//
// The obvious alternative was the Workers `send_email` binding, and the plan
// originally assumed it, because Phase 7 asks for the claim email to go out
// "as a reply to an arriving letter" and `message.reply()` is the only thing
// that literally is one. Reading Cloudflare's own documentation settled it the
// other way: their reply example sets `In-Reply-To` and `References` by hand,
// so threading is a property of headers we write, not of the transport. What
// `reply()` uniquely adds is a list of ways to fail -- DMARC must pass, one
// reply per event, recipient must equal the incoming sender -- every one of
// which lands at the exact moment somebody's first letter arrives.
//
// So sending lives here, in the Function, where it is retryable from durable
// storage, testable without a Worker, and free to send to somebody other than
// whoever just wrote to us.
//
// Two rules this module exists to enforce:
//
//   **Nothing here logs a message body, a subject, or a recipient's address
//   in full.** The claim email's entire security model is that its token is
//   seen only by the person who received it, and the token is in the body.
//   Telemetry is not a place to put credentials.
//
//   **Nothing is sent to an address that is not on the allowlist.** Not as
//   belt and braces -- as the actual containment for a service that computes
//   its recipients from strangers' mail headers.

const ENDPOINT = (accountId) =>
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`;

/**
 * Where a reply to our mail should land.
 *
 * Every address this service sends *from* is also an address it ingests: mail
 * to `post@` becomes a letter, mail to `claim@` becomes a claim. That is not
 * an accident -- both replies deliberately come from the address their
 * recipient wrote to, because Gmail weighs prior correspondence and a reply
 * arriving from somewhere else reads as an unrelated stranger. The cost was
 * that pressing Reply put a human's question into the classifier, where the
 * best case is a silent rejection and the worst case is publication: a copy
 * of our own claim email reached `post@` once and was published to the
 * archive it granted access to.
 *
 * `Reply-To` separates the two concerns that were fighting. `From` stays the
 * address they wrote to, so the deliverability argument holds untouched, and
 * the reply goes somewhere a person reads.
 *
 * Deliberately not used on the nudge: that message asks its recipient to send
 * the letter again, and its `From` is already the address it should go back
 * to.
 */
export const HUMAN_ADDRESS = 'hello@pdayletters.com';

/**
 * The name on our mail, and how to put it there.
 *
 * Kept separate from the address constants rather than folded into them,
 * because those constants are also identity: `POST_ADDRESS` and
 * `CLAIM_ADDRESS` name inboxes this service reads, and the day something
 * compares an incoming recipient against one of them, a display name baked
 * into the constant is a bug that only shows up in the comparison. `from:`
 * is the one place a name belongs, so `sender()` is applied at the one place
 * `from:` is written.
 *
 * `Pday Letters` needs no quoting -- RFC 5322 atext admits every character in
 * it, and the rendering was checked against a real client rather than assumed.
 */
export const SENDER_NAME = 'Pday Letters';

export const mailFrom = (address) => `${SENDER_NAME} <${address}>`;

// A recipient reduced to something safe to write down: enough to tell two
// failures apart in a log, not enough to be an address.
export const maskAddress = (address) => {
    const at = String(address ?? '').lastIndexOf('@');
    if (at < 1) return '(invalid)';
    return `${address[0]}***@${address.slice(at + 1).toLowerCase()}`;
};

const lower = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Parse the `MAIL_ALLOWLIST` setting.
 *
 * Absent or empty means **nothing sends**, and that asymmetry is deliberate.
 * The purge timer defaults the other way -- forgetting its flag can only ever
 * cause deletion to happen -- because there the dangerous outcome is silence.
 * Here the dangerous outcome is noise: a bug in the classifier picks its
 * recipients out of a stranger's `From:` header, and an unrecoverable mistake
 * is emailing that stranger. A mistake that emails nobody shows up in the
 * logs on the next send and costs a setting to fix.
 *
 * `*` means everyone, so widening is one deliberate value rather than the
 * accident of leaving something blank.
 */
export function parseAllowlist(setting) {
    const entries = String(setting ?? '')
        .split(',')
        .map((entry) => lower(entry))
        .filter(Boolean);

    return {
        open: entries.includes('*'),
        addresses: new Set(entries.filter((entry) => entry !== '*'))
    };
}

const permitted = (allowlist, to) => allowlist.open || allowlist.addresses.has(lower(to));

/**
 * Text made safe to drop into an HTML mail body.
 *
 * Every message this service sends carries something a stranger chose: a
 * display name, a subject line, a slug, the first hundred and eighty
 * characters of a letter. All of it goes into HTML we compose, so all of it
 * has to be escaped, and the eight mail composers each had a byte-identical
 * private copy of this function to do it.
 *
 * That is the shape a security bug hides in. Eight copies means a correction
 * gets applied to seven of them, and the eighth keeps sending markup somebody
 * else wrote to somebody's inbox -- with no test failing, because each copy
 * was individually correct on the day it was written. One copy here means the
 * next change to the rule is the rule.
 *
 * The apostrophe is deliberately not escaped: attribute values in these
 * templates are double-quoted throughout, and `&#39;` in a plain-text-ish
 * mail body is uglier than the character it replaces.
 */
export const escapeHtml = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * A mailer.
 *
 * @param {object} input
 * @param {string} input.accountId    Cloudflare account id
 * @param {string} input.token        Cloudflare API token; never logged
 * @param {string} [input.allowlist]  raw `MAIL_ALLOWLIST` setting
 * @param {function} [input.fetch]    injected for tests
 */
export function createMailer({ accountId, token, allowlist = '', fetch: doFetch = fetch }) {
    const allowed = parseAllowlist(allowlist);

    /**
     * Send one message.
     *
     * Returns a status rather than throwing for anything the caller might
     * reasonably want to carry on after, because every caller in this service
     * has already done the thing that mattered -- the letter is stored -- and
     * none of them should turn a mail failure into a lost message.
     *
     * `replyTo` is a parameter rather than something a caller puts in
     * `headers`, because Cloudflare rejects the whole message if it is. Its
     * `headers` object is an allowlist, and every header with a first-class
     * field of its own -- `From`, `To`, `Cc`, `Bcc`, `Subject`, `Reply-To` --
     * is refused there with a 400 and no partial send. That cost this service
     * every claim link and every receipt it ever tried to send: the two
     * messages carrying `Reply-To` were the two that never arrived, and the
     * failure was a log line nobody was reading.
     *
     * @returns {Promise<{status: 'sent'|'blocked'|'bounced'|'failed', detail?: string}>}
     */
    async function send({ from, to, replyTo = '', subject, text, html, headers = {}, log = console }) {
        if (!permitted(allowed, to)) {
            // Error, not warn. While the allowlist is narrow this fires for
            // ordinary reasons, but "we decided not to tell someone their
            // letters exist" is the failure this whole service is about, and
            // it should never be something you have to widen a log level to
            // discover.
            log.error?.('mail: recipient not on the allowlist, nothing sent', {
                to: maskAddress(to),
                open: allowed.open
            });
            return { status: 'blocked' };
        }

        if (!accountId || !token) {
            log.error?.('mail: not configured, nothing sent', { to: maskAddress(to) });
            return { status: 'failed', detail: 'unconfigured' };
        }

        let response;
        let body;
        try {
            response = await doFetch(ENDPOINT(accountId), {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    from,
                    to,
                    ...(replyTo ? { reply_to: replyTo } : {}),
                    subject,
                    text,
                    html,
                    headers
                })
            });
            body = await response.json();
        } catch (error) {
            // The message is not in `detail` and must not be: a fetch failure
            // can carry the request in its message, and the request contains
            // the token in the body and the API key in a header.
            log.error?.('mail: send failed', { to: maskAddress(to), status: response?.status ?? 0 });
            return { status: 'failed', detail: error.name ?? 'network' };
        }

        if (!response.ok || body?.success !== true) {
            // Cloudflare's error objects are codes and machine-readable
            // strings, so they are safe to log whole -- they describe the
            // request's shape, never its content.
            const detail = (body?.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ');
            log.error?.('mail: rejected', {
                to: maskAddress(to),
                httpStatus: response.status,
                detail: detail || 'no error detail'
            });
            // One status for every rejection, including suppression -- an
            // address Cloudflare has blocked account-wide after a hard bounce
            // or a spam complaint. There was briefly a `suppressed` status
            // matching on the word, and it was removed: the REST API publishes
            // no code for it, so the match was a guess, and all it ever bought
            // was a differently-worded sentence on a page that was already
            // going to say this address is not receiving mail. `detail` still
            // carries whatever Cloudflare said, for anyone reading logs.
            return { status: 'failed', detail: detail || `http ${response.status}` };
        }

        // A permanent bounce is a successful API call that delivered nothing.
        // Treating it as success is how an owner silently stops hearing from
        // a service whose only job is to tell them things.
        if ((body.result?.permanent_bounces ?? []).length) {
            log.error?.('mail: permanently bounced', { to: maskAddress(to) });
            return { status: 'bounced' };
        }

        const queued = (body.result?.queued ?? []).length > 0;
        log.info?.('mail: sent', { to: maskAddress(to), queued });
        return { status: 'sent' };
    }

    return { send };
}
