// The nightly sweep of finished counting rows.
//
// 03:45 UTC, deliberately after `purge` at 03:15 and deliberately not on the
// hour. The two do not interact -- one works on blobs and one on a table --
// but running them back to back keeps the whole night's housekeeping in one
// place in the logs.
//
// `runOnStartup` is off, for the reason it is off on `purge`: a job that
// deletes should not fire because somebody deployed.

import { app } from '@azure/functions';
import { tableStore } from '../lib/clients.js';
import { sweepArrivals } from '../lib/sweep.js';
import { setting } from '../lib/settings.js';

async function handler(timer, context) {
    // Opt-in, so forgetting it can only cause the sweep to run, never cause
    // it to quietly stop. Same reasoning as `PURGE_DRY_RUN`.
    const dryRun = setting('SWEEP_DRY_RUN', '') === 'true';

    const result = await sweepArrivals({ tables: tableStore(), log: context, dryRun });

    context.log('sweep: cleared finished arrival rows', {
        scanned: result.scanned,
        deleted: result.deleted,
        kept: result.kept,
        failed: result.failed,
        oldest: result.oldest,
        dryRun,
        pastDue: Boolean(timer?.isPastDue)
    });

    return result;
}

app.timer('sweep', {
    schedule: '0 45 3 * * *',
    handler
});
