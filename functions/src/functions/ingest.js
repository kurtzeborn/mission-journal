import { app, output } from '@azure/functions';
import { blobStore, ingestConfig, mailer, tableStore } from '../lib/clients.js';
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

async function handler(message, context) {
    // The Worker enqueues the ULID as plain text, but the host will hand back
    // an object if a payload ever parses as JSON.
    const ulid = String(typeof message === 'string' ? message : (message?.ulid ?? message)).trim();

    const config = ingestConfig();

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
