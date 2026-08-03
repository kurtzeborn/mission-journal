import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { runRender } from '../lib/render.js';

const setting = (name, fallback) => process.env[name] ?? fallback;

// One client per process, not per invocation: DefaultAzureCredential caches
// tokens, and a fresh instance per message would re-authenticate every time.
let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: setting('STORAGE_ACCOUNT_NAME') }));

async function handler(message, context) {
    // Ingest enqueues JSON, but the host only parses it for us when the
    // payload is an object already — a string payload arrives verbatim.
    const parsed = typeof message === 'string' ? JSON.parse(message) : message;

    return runRender({ message: parsed, store: blobStore(), log: context });
}

app.storageQueue('render', {
    queueName: 'render',
    connection: 'STORAGE',
    handler
});
