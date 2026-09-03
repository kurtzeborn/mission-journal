// The table half of the Azure side.
//
// Kept as thin as store.js and for the same reason: everything that decides
// anything lives in a module tested against an in-memory fake, and what is
// left here is the part that can only be checked by running it against real
// storage.
//
// Every table here is a *derived index and never the authority*. The two that
// set the pattern:
//
//   `memberships`  PartitionKey = lowercased email, RowKey = slug
//   `users`        PartitionKey = lowercased email, RowKey = 'profile'
//
// `acl.json` remains the source of truth for who may read a site, and the
// content API keeps checking it on every request. `memberships` exists only
// to answer the reverse question -- *which sites does this address belong
// to* -- which a blob layout cannot answer without scanning every ACL in the
// account. Nothing may ever grant access from a membership row: if the two
// disagree, the ACL wins and the row is the thing that is wrong.
//
// The rest are documented where they are named below.

import { TableClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';

export const TABLES = {
    memberships: 'memberships',
    users: 'users',
    sites: 'sites',
    nudges: 'nudges',
    // PartitionKey = slug, RowKey = the invitation token's hash. Never the
    // token: an owner listing invitations is shown the hash, which is a handle
    // for revoking one and not a credential for accepting it.
    invites: 'invites',
    // PartitionKey = '{slug}:{YYYY-MM-DD}', RowKey = the message's ULID. One
    // row per letter that arrived, partitioned by the day it arrived on, so
    // counting a day's traffic for one archive is a single-partition list
    // bounded by the cap rather than a scan.
    arrivals: 'arrivals',
    // PartitionKey = slug, RowKey = 'record'. One row per archive that has
    // been deleted and not yet purged, which is the only place the thirty-day
    // promise is written down. Ordinarily empty.
    //
    // **This one is not a derived index.** Losing it would not lose any
    // letters -- the blobs are all still there -- but it would strand them:
    // nothing would ever purge them, and nothing would know to offer them back.
    deletions: 'deletions',
    // PartitionKey = 'optout', RowKey = SHA-256 of the address. One partition
    // on purpose: the only question ever asked of it is "this one address,
    // yes or no", and a single partition makes that a point read. It is also
    // the one table here that is *not* a derived index -- nothing else records
    // that somebody asked us to stop, so losing it would silently resume mail
    // to people who told us not to.
    optouts: 'optouts',
    // PartitionKey = 'delivery', RowKey = SHA-256 of the address. Same shape
    // as `optouts` and for the same reason, but recording the opposite kind of
    // silence: not "they asked us to stop" but "we tried and it did not
    // arrive". Derived -- Cloudflare's suppression list is the authority and
    // this is our readable copy of what it did to us. See delivery.js.
    deliveries: 'deliveries',
    // PartitionKey = slug, RowKey = the message's ULID. One row per first
    // letter that was refused, and the only durable trace of one: a rejection
    // keeps nothing but the inbox blob, which nothing reads, and a log line,
    // which nobody is watching. Without this the person it happened to is the
    // only one who knows. See rejections.js.
    rejections: 'rejections',
    // PartitionKey = 'identity', RowKey = SHA-256 of `provider:userId`. The
    // last address we saw this sign-in use, and the only thing that can tell
    // us an address has *changed* rather than that a stranger has arrived.
    // Derived, and the recovery is a sign-in: an empty table simply re-binds
    // everyone the next time they visit. See identity.js.
    identities: 'identities',
    // PartitionKey = 'YYYY-MM-DD', RowKey = '{slug}|SHA-256 of the address'.
    // One row per person per archive per day they read it, upserted, so the
    // count is people rather than page loads. Holds no address and nothing
    // about what was read. Derived, and losing it costs a month of history.
    // See visits.js.
    visits: 'visits'
};

export function createTableStore({ accountName, credential = new DefaultAzureCredential() }) {
    const url = `https://${accountName}.table.core.windows.net`;

    // One client per table per process. The credential caches tokens, so a
    // fresh client per call would re-authenticate every time.
    const clients = new Map();
    const client = (table) => {
        if (!clients.has(table)) {
            clients.set(table, new TableClient(url, table, credential, { allowInsecureConnection: false }));
        }
        return clients.get(table);
    };

    return {
        async getEntity(table, partitionKey, rowKey) {
            try {
                return await client(table).getEntity(partitionKey, rowKey);
            } catch (err) {
                if (err?.statusCode === 404) return null;
                throw err;
            }
        },

        // Upsert rather than insert, because every caller here is recording a
        // fact that is true regardless of whether it was already recorded --
        // re-running a claim, or a rebuild-from-`config/*` drift repair, must
        // both be safe to do twice.
        async upsertEntity(table, entity) {
            await client(table).upsertEntity(entity, 'Merge');
        },

        // The exception to the rule above: a caller that needs to know whether
        // it was first. Returns false if the row already existed.
        //
        // Read-then-write would not do here. The one situation this exists to
        // handle -- somebody forwarding a stack of old letters in one sitting
        // -- arrives as a batch of queue messages the host runs concurrently,
        // so a check and a later write straddle exactly the window that
        // matters. The 409 is the whole point of the method.
        async insertEntity(table, entity) {
            try {
                await client(table).createEntity(entity);
                return true;
            } catch (err) {
                if (err?.statusCode === 409) return false;
                throw err;
            }
        },

        async listEntities(table, { partitionKey } = {}) {
            const options = partitionKey
                ? { queryOptions: { filter: odata`PartitionKey eq ${partitionKey}` } }
                : undefined;
            const found = [];
            for await (const entity of client(table).listEntities(options)) found.push(entity);
            return found;
        },

        async deleteEntity(table, partitionKey, rowKey) {
            try {
                await client(table).deleteEntity(partitionKey, rowKey);
            } catch (err) {
                // Already gone is the outcome the caller wanted.
                if (err?.statusCode !== 404) throw err;
            }
        }
    };
}
