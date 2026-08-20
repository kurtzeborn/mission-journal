import { app } from '@azure/functions';
import { blobStore } from '../lib/clients.js';
import { runRender } from '../lib/render.js';

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
