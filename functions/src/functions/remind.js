// The daily chase for pending sites nobody came back to.
//
// A separate timer from the purge sweep on purpose, even though both walk the
// same manifests. That job destroys letters and this one sends mail, and the
// operational questions about them are opposites: the purge should run as
// seldom as it can get away with, and a mail failure here is a retry rather
// than an incident. Sharing a handler would also mean a broken mailer could
// stop the sweep, which is the one job that must not quietly stop.
//
// 03:45 UTC, after the purge at 03:15, so a site that is being deleted tonight
// is already gone rather than reminded on its way out.
//
// `runOnStartup` is left off, like the purge. Mail that fires on every
// deployment is mail tied to whenever somebody pushes.

import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createMailer } from '../lib/mail.js';
import { remindPending } from '../lib/offer.js';

const setting = (name, fallback) => process.env[name] ?? fallback;

let cachedStore = null;
let cachedMailer = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: setting('STORAGE_ACCOUNT_NAME') }));
const mailer = () =>
    (cachedMailer ??= createMailer({
        accountId: setting('CLOUDFLARE_ACCOUNT_ID'),
        token: setting('CLOUDFLARE_API_TOKEN'),
        allowlist: setting('MAIL_ALLOWLIST')
    }));

async function handler(timer, context) {
    const key = setting('CLAIM_TOKEN_KEY', '');
    if (!key) {
        // Every reminder carries a freshly minted link, so there is nothing
        // useful to send without the signing key. Loud, because the symptom
        // otherwise is silence -- exactly what a working night looks like.
        context.error('remind: CLAIM_TOKEN_KEY is not configured; sent nothing');
        return { scanned: 0, reminded: [] };
    }

    const result = await remindPending({
        store: blobStore(),
        mailer: mailer(),
        key,
        baseUrl: setting('PUBLIC_BASE_URL', 'https://pdayletters.com'),
        log: context
    });

    context.log('remind: chased pending sites', {
        scanned: result.scanned,
        reminded: result.reminded.length,
        pastDue: Boolean(timer?.isPastDue)
    });

    return result;
}

app.timer('remind', {
    schedule: '0 45 3 * * *',
    handler
});
