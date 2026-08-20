// The daily sweep for lapsed pending sites.
//
// Nightly rather than hourly: the thing being measured is a sixty-day window,
// so the resolution of the check is irrelevant, and a job that deletes things
// should run as seldom as it can get away with. 03:15 UTC is deliberately not
// on the hour, where every scheduled job in the world already is.
//
// `runOnStartup` is left off. A deleting job that fires on every deployment
// would tie destruction to an event that happens whenever somebody pushes.

import { app } from '@azure/functions';
import { blobStore } from '../lib/clients.js';
import { purgeExpired } from '../lib/purge.js';
import { setting } from '../lib/settings.js';

async function handler(timer, context) {
    // An escape hatch that reports without deleting, for confirming the sweep
    // is judging correctly before it is allowed to act. Opt-in, so that
    // forgetting to set it can only ever cause deletion to happen, never
    // cause it to silently stop happening -- the failure this design cares
    // about is a purge nobody notices has been dead for months.
    const dryRun = setting('PURGE_DRY_RUN', '') === 'true';

    const result = await purgeExpired({ store: blobStore(), log: context, dryRun });

    context.log('purge: swept pending sites', {
        scanned: result.scanned,
        purged: result.purged.length,
        letters: result.purged.reduce((total, site) => total + site.letters, 0),
        kept: result.kept.length,
        dryRun,
        pastDue: Boolean(timer?.isPastDue)
    });

    return result;
}

app.timer('purge', {
    schedule: '0 15 3 * * *',
    handler
});
