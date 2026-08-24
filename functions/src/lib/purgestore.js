// Permanent deletion, and the credential that is allowed to do it.
//
// Separate from store.js, which every other module shares, and the separation
// is the point rather than tidiness. `permanentDelete` is the one capability in
// this service that can destroy something no backup will bring back, and the
// shared store is constructed by the code that processes attacker-supplied
// mail. Keeping them apart means the right to erase is a credential the ingest
// path does not carry.
//
// **The identity is asked for by client ID, explicitly.** The function app now
// carries both a system-assigned identity and this user-assigned one, and what
// `DefaultAzureCredential` picks in that situation is not documented -- the
// guidance covers multiple user-assigned identities and is silent on the mixed
// case. Every other module in this service constructs a bare credential and
// gets the system-assigned one; if the platform ever preferred the
// user-assigned identity by default, the split this module exists to enforce
// would be undone invisibly and every one of those modules would silently gain
// the right to erase. Naming the identity here does not prevent that, but it
// does mean this module's behavior does not depend on the answer.
//
// **Three passes, and it is not the sequence you would guess.** Measured
// against the real account, not read in a document:
//
//   1. **Delete the base blob.** A version that is still the *current* version
//      of a live blob refuses both of the passes below with `403
//      OperationNotAllowedOnRootBlob`. Deleting the base blob demotes it.
//   2. **Delete the version.** With soft delete on, this only soft-deletes it.
//   3. **Delete the version again, with `deletetype=permanent`.** Skipping (2)
//      makes this return `409 BlobSnapshotNotSoftDeleted`.
//
// Skipping any pass leaves data behind while reporting success, which is the
// worst available outcome: a family told their letters were erased, and the
// letters still there.
//
// **This has to be raw REST.** `az storage blob delete` has no `--version-id`
// at all, and a `?versionid=` smuggled in through `--blob-url` is *silently
// ignored* -- the CLI deletes the base blob, exits 0, and leaves every version
// intact. The JavaScript SDK is better but not sufficient: `BlobClient` can
// address a version through `withVersion`, and `BlobDeleteOptions` has no
// field for the delete type, so pass (3) cannot be expressed through it. The
// listing below does use the SDK, because listing is the part it does well.

import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

// The version this code was measured against. Pinned rather than left to the
// service default, because `deletetype=permanent` is a versioned feature and a
// silently older default would turn pass (3) into a second soft delete --
// succeeding, reporting nothing, and erasing nothing.
const API_VERSION = '2020-12-06';
const SCOPE = 'https://storage.azure.com/.default';

/**
 * The address of one version, and whether the delete is the real one.
 *
 * Pure, and exported, because these are the few characters that decide whether
 * a letter is destroyed or merely hidden for thirty days, and they are not
 * reachable through any credential-free path otherwise.
 *
 * The path is escaped one segment at a time. Slashes are structure and have to
 * survive; everything else in a blob name is data. Encoding the whole path
 * would collapse the prefix into a single literal segment and address a blob
 * that does not exist -- which deletes nothing and reports success.
 */
export function versionUrl({ accountName, container, name, versionId, permanent = false }) {
    const path = name.split('/').map(encodeURIComponent).join('/');
    const target = new URL(`https://${accountName}.blob.core.windows.net/${container}/${path}`);
    target.searchParams.set('versionid', versionId);
    if (permanent) target.searchParams.set('deletetype', 'permanent');
    return target.toString();
}

export function createPurgeStore({ accountName, clientId, fetch: send = fetch }) {
    // Named on purpose. See the note at the top of the file.
    const credential = new DefaultAzureCredential(
        clientId ? { managedIdentityClientId: clientId } : {}
    );

    const service = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential
    );

    // The token is cached by the credential, so this is a property read after
    // the first call rather than a round trip per blob.
    const authorize = async () => `Bearer ${(await credential.getToken(SCOPE)).token}`;

    const deleteVersion = async (container, name, versionId, permanent) => {
        const response = await send(
            versionUrl({ accountName, container, name, versionId, permanent }),
            {
                method: 'DELETE',
                headers: {
                    Authorization: await authorize(),
                    'x-ms-version': API_VERSION
                }
            }
        );

        // Already gone is the outcome the caller wanted, and a purge retried
        // after a partial run will meet it constantly.
        if (response.ok || response.status === 404) return;

        throw new Error(
            `purge: ${response.status} deleting ${container}/${name} version ${versionId}` +
                `${permanent ? ' permanently' : ''}`
        );
    };

    return {
        /**
         * Every blob under a prefix, every version of it, including the ones
         * already soft-deleted.
         *
         * Paged by the iterator, which matters here and does not elsewhere: a
         * full mission with versioning on is tens of thousands of entries, and
         * this is the one listing in the service that is not bounded by a
         * family's own behavior.
         */
        async listVersions(container, prefix) {
            const found = [];
            const iterator = service.getContainerClient(container).listBlobsFlat({
                prefix,
                includeVersions: true,
                includeDeleted: true
            });
            for await (const item of iterator) {
                found.push({
                    name: item.name,
                    versionId: item.versionId ?? '',
                    isCurrentVersion: Boolean(item.isCurrentVersion),
                    deleted: Boolean(item.deleted)
                });
            }
            return found;
        },

        async deleteBlob(container, name) {
            await service
                .getContainerClient(container)
                .getBlockBlobClient(name)
                .deleteIfExists({ deleteSnapshots: 'include' });
        },

        softDeleteVersion: (container, name, versionId) =>
            deleteVersion(container, name, versionId, false),

        permanentlyDeleteVersion: (container, name, versionId) =>
            deleteVersion(container, name, versionId, true)
    };
}
