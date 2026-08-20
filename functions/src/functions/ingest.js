import { app, output } from '@azure/functions';
import { blobStore, mailer, tableStore } from '../lib/clients.js';
import { trustedSealersFrom } from '../lib/arc.js';
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

import { setting } from '../lib/settings.js';

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
        baseUrl: setting('PUBLIC_BASE_URL', 'https://pdayletters.com'),
        // Whose ARC seal we are willing to treat as evidence. Defaults to the
        // one provider we actually need, rather than to mailauth's list, which
        // is a general-purpose "these forwarders are usually honest" set and
        // much wider than anything here has a reason to trust.
        trustedArcSealers: trustedSealersFrom(setting('TRUSTED_ARC_SEALERS', ''))
    };

    const store = {
        ...blobStore(),
        // Deliberately shadows the store's own `enqueue`. Both work here; the
        // binding is preferred because the host writes it only if this
        // invocation succeeds, so a letter that fails after publishing does
        // not leave a render job for a post that was rolled back.
        //
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
