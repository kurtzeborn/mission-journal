import { app, output } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { createMailer } from '../lib/mail.js';
import { runIngest } from '../lib/ingest.js';

// The render job is emitted through an output binding rather than a queue
// client, so the host owns the credential and the SDK surface stays small.
// STORAGE is the identity-based connection defined in infra/main.bicep: the
// service URIs are named without a credential, which selects the function
// app's system-assigned identity.
const renderQueue = output.storageQueue({
    queueName: 'render',
    connection: 'STORAGE'
});

const setting = (name, fallback) => process.env[name] ?? fallback;

// One client per process, not per invocation: DefaultAzureCredential caches
// tokens, and a fresh instance per message would re-authenticate every time.
let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: setting('STORAGE_ACCOUNT_NAME') }));

let cachedTables = null;
const tableStore = () =>
    (cachedTables ??= createTableStore({ accountName: setting('STORAGE_ACCOUNT_NAME') }));

// Nothing is sent unless `MAIL_ALLOWLIST` says who may receive it -- see
// mail.js for why this one defaults closed while the purge flag defaults open.
let cachedMailer = null;
const mailer = () =>
    (cachedMailer ??= createMailer({
        accountId: setting('CLOUDFLARE_ACCOUNT_ID', ''),
        token: setting('CLOUDFLARE_API_TOKEN', ''),
        allowlist: setting('MAIL_ALLOWLIST', '')
    }));

async function handler(message, context) {
    // The Worker enqueues the ULID as plain text, but the host will hand back
    // an object if a payload ever parses as JSON.
    const ulid = String(typeof message === 'string' ? message : (message?.ulid ?? message)).trim();

    const config = {
        authservId: setting('AUTHSERV_ID', 'mx.cloudflare.net'),
        missionaryDomains: setting('MISSIONARY_DOMAINS', 'missionary.org')
            .split(',')
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean),
        // No fallback. An empty list means "accept anything", which is what
        // this did before the setting was read at all, so a missing app setting
        // cannot quietly start rejecting mail.
        acceptedIngestDomains: setting('ACCEPTED_INGEST_DOMAINS', '')
            .split(',')
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean),
        claimTokenKey: setting('CLAIM_TOKEN_KEY', ''),
        baseUrl: setting('PUBLIC_BASE_URL', 'https://pdayletters.com')
    };

    const store = {
        ...blobStore(),
        // Only a stored message reaches this, so an invocation that rejects or
        // dedupes simply never sets the binding and emits nothing.
        async enqueue(_queue, text) {
            context.extraOutputs.set(renderQueue, text);
        }
    };

    return runIngest({ ulid, store, tables: tableStore(), mailer: mailer(), config, log: context });
}

app.storageQueue('ingest', {
    queueName: 'ingest',
    connection: 'STORAGE',
    extraOutputs: [renderQueue],
    handler
});
