// The daily look for anybody whose digest is due.
//
// Daily rather than monthly, and that is not a contradiction. Cycles are
// per person and start whenever each person answered the question, so
// "monthly" means a thirtieth of the audience is due on any given day. That
// is also the shape a sending domain wants: a steady trickle rather than one
// morning a month where every message this service has ever sent goes out at
// once.
//
// 13:15 UTC, which is early morning across the United States, where the
// families are. Deliberately not in the small hours with the purge and the
// reminder: those two jobs are chosen to be invisible, and this one is chosen
// to land at the top of an inbox somebody is about to read.
//
// `runOnStartup` is off, like every other timer here. Mail that fires on
// deployment is mail tied to whenever somebody pushes.

import { app } from '@azure/functions';
import { blobStore, mailer, tableStore } from '../lib/clients.js';
import { runDigests } from '../lib/digest.js';
import { setting } from '../lib/settings.js';

async function handler(timer, context) {
    // Unlike the reminder, this one runs without the signing key. The key
    // buys an unsubscribe link, and a digest with no unsubscribe link is
    // worse than one with -- but a digest nobody receives is worse than
    // either, and the recipients here are people who explicitly asked to be
    // written to and can turn it off on a page they are signed in to.
    const key = setting('CLAIM_TOKEN_KEY', '');
    if (!key) context.warn('digest: CLAIM_TOKEN_KEY is not configured; sending without opt-out links');

    const result = await runDigests({
        store: blobStore(),
        tables: tableStore(),
        mailer: mailer(),
        key,
        baseUrl: setting('PUBLIC_BASE_URL', 'https://pdayletters.com'),
        log: context
    });

    context.log('digest: run complete', { ...result, pastDue: Boolean(timer?.isPastDue) });

    return result;
}

app.timer('digest', {
    schedule: '0 15 13 * * *',
    handler
});
