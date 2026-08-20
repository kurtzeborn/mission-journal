// The daily sweep for archives whose thirty days are up.
//
// Separate from the pending-site sweep next door, and separate on purpose. The
// two destroy things for entirely different reasons -- one ends a promise
// nobody asked us to make, this one keeps a promise an owner asked for -- and
// they run on different credentials. Sharing a handler would mean one of them
// carried the other's permissions.
//
// 04:15 UTC, an hour after the pending sweep. Nightly rather than hourly for
// the same reason: what is being measured is a thirty-day window, so the
// resolution is irrelevant, and a job that erases things should run as seldom
// as it can get away with. No `runOnStartup` -- tying irreversible destruction
// to "somebody deployed" is not a schedule.

import { app } from '@azure/functions';
import { blobStore, tableStore } from '../lib/clients.js';
import { createPurgeStore } from '../lib/purgestore.js';
import { runDueErasures } from '../lib/erase.js';
import { setting } from '../lib/settings.js';

let cachedPurge = null;

// The only construction of this credential anywhere in the service. See
// purgestore.js for why it is named explicitly rather than left to
// DefaultAzureCredential's own selection.
const purgeStore = () =>
    (cachedPurge ??= createPurgeStore({
        accountName: setting('STORAGE_ACCOUNT_NAME'),
        clientId: setting('PURGE_IDENTITY_CLIENT_ID')
    }));

export async function handler(timer, context) {
    // Without the identity there is nothing to try. Erasing with the app's own
    // credential would appear to work -- it can delete base blobs -- and would
    // leave every version behind, which is the one failure this whole design
    // exists to prevent: a family told their letters were destroyed, and the
    // letters still in the account.
    if (!setting('PURGE_IDENTITY_CLIENT_ID')) {
        context.error('erase: PURGE_IDENTITY_CLIENT_ID is not set, nothing was erased');
        return [];
    }

    const results = await runDueErasures({
        purge: purgeStore(),
        store: blobStore(),
        tables: tableStore(),
        log: context
    });

    const counted = (outcome) => results.filter((result) => result.outcome === outcome).length;

    context.log('erase: swept deleted archives', {
        due: results.length,
        erased: counted('erased'),
        notDue: counted('not-due'),
        recreated: counted('recreated'),
        failed: counted('failed'),
        pastDue: Boolean(timer?.isPastDue)
    });

    return results;
}

app.timer('erase', {
    schedule: '0 15 4 * * *',
    handler
});
