// The table half of the Azure side.
//
// Kept as thin as store.js and for the same reason: everything that decides
// anything lives in a module tested against an in-memory fake, and what is
// left here is the part that can only be checked by running it against real
// storage.
//
// Two tables, both of which are *derived indexes and never the authority*:
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

import { TableClient, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';

export const TABLES = { memberships: 'memberships', users: 'users', sites: 'sites', nudges: 'nudges' };

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
