// The Azure side of the ingest pipeline.
//
// Kept deliberately thin: everything that makes a decision lives in ingest.js
// and is tested against an in-memory fake. What is left here is the part that
// can only be checked by running it against real storage.

import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

// Access is by managed identity. No connection string, no account key, and
// nothing in app settings that would be worth stealing.
export function createBlobStore({ accountName, credential = new DefaultAzureCredential() }) {
    const service = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential
    );

    const blob = (container, name) =>
        service.getContainerClient(container).getBlockBlobClient(name);

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
        }
    };
}
