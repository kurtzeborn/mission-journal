// The Azure side of the ingest pipeline.
//
// Kept deliberately thin: everything that makes a decision lives in ingest.js
// and is tested against an in-memory fake. What is left here is the part that
// can only be checked by running it against real storage.

import {
    BlobServiceClient,
    BlobSASPermissions,
    SASProtocol,
    generateBlobSASQueryParameters
} from '@azure/storage-blob';
import { QueueServiceClient } from '@azure/storage-queue';
import { DefaultAzureCredential } from '@azure/identity';

// A user delegation key is signed by Entra ID rather than by an account key,
// which is what lets this run on a storage account that has no keys worth
// stealing. Keys are valid for up to seven days and cost a round trip, so one
// is kept until shortly before it expires rather than fetched per download.
const KEY_LIFETIME_MINUTES = 60;
const KEY_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Access is by managed identity. No connection string, no account key, and
// nothing in app settings that would be worth stealing.
export function createBlobStore({ accountName, credential = new DefaultAzureCredential() }) {
    const service = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential
    );

    // Built lazily. Most callers never enqueue, and a queue client that is
    // never used should not cost a handshake.
    let queues = null;
    const queueService = () =>
        (queues ??= new QueueServiceClient(
            `https://${accountName}.queue.core.windows.net`,
            credential
        ));

    const blob = (container, name) =>
        service.getContainerClient(container).getBlockBlobClient(name);

    let delegation = null;

    const delegationKey = async () => {
        const now = Date.now();
        if (delegation && delegation.expiresAt - KEY_REFRESH_MARGIN_MS > now) {
            return delegation.key;
        }
        const expiresAt = now + KEY_LIFETIME_MINUTES * 60 * 1000;
        const key = await service.getUserDelegationKey(
            // Backdated, because the clock here and the clock at storage are
            // not the same clock. Without the skew a key can be rejected as
            // not-yet-valid for the first few seconds of its life.
            new Date(now - 5 * 60 * 1000),
            new Date(expiresAt)
        );
        delegation = { key, expiresAt };
        return key;
    };

    return {
        async readBlob(container, name) {
            try {
                const client = blob(container, name);
                const response = await client.downloadToBuffer();
                const properties = await client.getProperties();
                return {
                    bytes: response,
                    metadata: properties.metadata ?? {},
                    etag: properties.etag
                };
            } catch (err) {
                if (err?.statusCode === 404) return null;
                throw err;
            }
        },

        async writeBlob(container, name, bytes, options = {}) {
            const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
            const result = await blob(container, name).uploadData(body, {
                blobHTTPHeaders: options.contentType
                    ? { blobContentType: options.contentType }
                    : undefined,
                metadata: options.metadata,
                conditions: {
                    ifMatch: options.ifMatch,
                    ifNoneMatch: options.ifNoneMatch
                }
            });
            return { etag: result.etag };
        },

        /**
         * Every blob name under a prefix, sorted.
         *
         * Storage returns these in lexicographic order already; the sort is
         * restated rather than assumed, because promotion replays a pending
         * site's letters and the order it replays them in decides the order
         * they end up in when two letters share a timestamp.
         *
         * No paging. The only caller is a pending site's backlog, which is
         * bounded by the rolling expiry at a few months of one family's mail.
         * A caller that could exceed a page needs a different method, not a
         * larger page size.
         */
        async listBlobs(container, prefix = '') {
            const names = [];
            const iterator = service.getContainerClient(container).listBlobsFlat({ prefix });
            for await (const item of iterator) names.push(item.name);
            return names.sort();
        },

        async deleteBlob(container, name) {
            await blob(container, name).deleteIfExists();
        },

        /**
         * Upload a stream, without ever holding all of it.
         *
         * The archive is assembled and sent to storage at the same time, so
         * peak memory is the buffer below rather than the finished zip. That
         * matters at full-mission size, where the zip is larger than the
         * instance's entire memory allowance.
         */
        async uploadStream(container, name, stream, options = {}) {
            const BUFFER_BYTES = 4 * 1024 * 1024;
            const CONCURRENCY = 4;
            await blob(container, name).uploadStream(stream, BUFFER_BYTES, CONCURRENCY, {
                blobHTTPHeaders: {
                    blobContentType: options.contentType,
                    blobContentDisposition: options.contentDisposition
                }
            });
        },

        /**
         * A short-lived, read-only, single-blob URL.
         *
         * Scoped to one blob and one verb because it is handed to a browser:
         * whatever it can do is what an attacker who obtains the URL can do.
         * It carries no identity, so the authorization decision has already
         * been made by the time this is called -- never call it before the
         * gate.
         */
        async readUrl(container, name, { minutes = 15 } = {}) {
            const key = await delegationKey();
            const now = Date.now();
            const query = generateBlobSASQueryParameters(
                {
                    containerName: container,
                    blobName: name,
                    permissions: BlobSASPermissions.parse('r'),
                    protocol: SASProtocol.Https,
                    startsOn: new Date(now - 5 * 60 * 1000),
                    expiresOn: new Date(now + minutes * 60 * 1000)
                },
                key,
                accountName
            ).toString();

            return `${blob(container, name).url}?${query}`;
        },

        /**
         * Put a message on a queue.
         *
         * A queue-triggered function can do this with an output binding
         * instead, and ingest.js does, because a binding is written only when
         * the invocation succeeds. Nothing else has that option: an HTTP
         * handler's output binding is written *after* the handler returns,
         * which is too late for `promotePending`, whose whole safety argument
         * is that a pending letter is deleted only once its render job
         * exists. So this sends immediately and throws if it cannot.
         *
         * No base64. `host.json` sets `messageEncoding: none`, and the client
         * sends the string as given, so the two agree -- but they agree by
         * configuration rather than by default, so changing either one alone
         * would break every trigger silently.
         */
        async enqueue(queue, text) {
            await queueService().getQueueClient(queue).sendMessage(text);
        }
    };
}
