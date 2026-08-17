// Whether our mail is actually reaching somebody.
//
// Every other failure in this service is loud in the right direction. The
// daily cap refuses a letter but keeps it. A render failure leaves the raw
// `.eml` where it was. Undeliverable mail is the opposite: the recipient's
// experience is *silence*, which is indistinguishable from "no letters this
// week" -- and for a service whose only job is telling people a letter
// arrived, the failure mode and the success mode look identical from outside.
//
// Worse, it compounds. Cloudflare's suppression list is per *account*, not per
// site, so one grandparent marking a claim email as spam suppresses that
// address for every archive we will ever host. Two years later their
// grandchild's invitation fails too, silently, for a reason nobody wrote down.
//
// This table is where it gets written down.
//
// **Keyed by address, not by site**, mirroring the thing it records. The
// alternative -- a column on the ACL entry and another on the invitation row --
// would have needed the same fact stored twice, kept in step, and would still
// have known nothing about an address the owner has not invited yet.
//
// **Every outcome is recorded, not just the failures.** A send that succeeds
// has to be able to clear a stale warning, or an address that recovers is
// marked as broken forever and the owner learns to ignore the mark. The row is
// the *last* thing that happened, which is the only question anybody asks of
// it.
//
// **It is advisory and nothing reads it to make a decision.** Nothing here
// refuses to send. Cloudflare already refuses, authoritatively, and a second
// copy of that judgement in our storage could only ever be wrong in the
// direction that matters: silently declining to email somebody whose address
// started working again. This exists to be *shown to a person*.

import { createHash } from 'node:crypto';
import { TABLES } from './tables.js';

const lower = (value) => String(value ?? '').trim().toLowerCase();

/**
 * The row key.
 *
 * Hashed for the same reason `optOutKey` is: an email address may legally
 * contain `/`, `\`, `#` and `?`, none of which an Azure Table row key admits.
 * The address is stored in the row as well -- the hash is for the key, not for
 * secrecy, and a table of hashes could not answer "why did grandmother stop
 * hearing from us", which is the entire point of keeping it.
 */
export const deliveryKey = (email) => createHash('sha256').update(lower(email), 'utf8').digest('hex');

// The outcomes worth showing somebody. `blocked` is ours -- the allowlist --
// and says nothing about the recipient, so it is not recorded: while the
// allowlist is narrow it would mark half the world as unreachable.
//
// Suppression is not a status of its own. Cloudflare's REST API publishes no
// code for it, so telling it apart from any other rejection would mean
// guessing at wording -- and the page says the same useful thing either way.
const TROUBLE = new Set(['bounced', 'failed']);

/**
 * Write down how the last send to this address went.
 *
 * Swallows its own failures. Every caller has already done the thing that
 * mattered, and a telemetry write is not permitted to fail an invitation or
 * make a mail server redeliver a letter.
 */
export async function recordDelivery({ tables, email, status, slug = '', now = () => new Date(), log = console }) {
    const them = lower(email);
    if (!tables || !them || !status || status === 'blocked') return;

    try {
        await tables.upsertEntity(TABLES.deliveries, {
            partitionKey: 'delivery',
            rowKey: deliveryKey(them),
            email: them,
            status,
            at: now().toISOString(),
            // Which archive's mail it was. Enough to answer "when did this
            // start" without a second table, and harmless to overwrite: the
            // row is a snapshot, not a history.
            slug
        });
    } catch (error) {
        log.error?.('delivery: could not record an outcome', { status, message: error?.message });
    }
}

/**
 * The trouble, for a handful of addresses.
 *
 * Point reads rather than a partition scan, because the caller always knows
 * exactly whom it is asking about and a site has a handful of people on it.
 * The partition holds every address the service has ever written to, and
 * listing that to answer a question about six of them would get slower for
 * every family we ever add.
 *
 * Addresses that are fine are simply absent from the result, so a caller that
 * gets nothing back has nothing to show -- which is the common case and the
 * one worth being cheap.
 *
 * @returns {Promise<Map<string, {status: string, at: string}>>}
 */
export async function deliveryTrouble({ tables, emails, log = console }) {
    const found = new Map();
    if (!tables || !emails?.length) return found;

    const unique = [...new Set(emails.map(lower).filter(Boolean))];

    await Promise.all(
        unique.map(async (email) => {
            let row;
            try {
                row = await tables.getEntity(TABLES.deliveries, 'delivery', deliveryKey(email));
            } catch (error) {
                // One unreadable row must not blank out the page it was going
                // to annotate. The cost of failing quietly here is a missing
                // warning; the cost of throwing is a people page that will not
                // load.
                log.error?.('delivery: could not read an outcome', { message: error?.message });
                return;
            }
            if (row && TROUBLE.has(row.status)) found.set(email, { status: row.status, at: row.at ?? '' });
        })
    );

    return found;
}
