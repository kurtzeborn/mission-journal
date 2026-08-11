// The few characters that decide whether a letter is destroyed.
//
// This layer exists because neither the CLI nor the SDK can express the
// request: `az storage blob delete` has no `--version-id`, and the SDK's
// delete options have no field for the delete type. So the request is built by
// hand, and the part worth pinning down is the URL -- which is pure, and
// therefore testable without a credential or a network.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { versionUrl, createPurgeStore } from '../src/lib/purgestore.js';

const built = (overrides = {}) =>
    new URL(
        versionUrl({
            accountName: 'mjst',
            container: 'raw',
            name: 'elder.example/u_01/message.eml',
            versionId: '2026-08-08T09:00:00.0000000Z',
            ...overrides
        })
    );

describe('addressing one version', () => {
    test('it is the account, the container and the blob', async () => {
        const url = built();

        assert.equal(url.origin, 'https://mjst.blob.core.windows.net');
        assert.equal(url.pathname, '/raw/elder.example/u_01/message.eml');
    });

    test('the version is named every time', async () => {
        // Without it this is a request to delete the blob itself, which is
        // both far more destructive and, for a current version, refused.
        assert.equal(built().searchParams.get('versionid'), '2026-08-08T09:00:00.0000000Z');
    });

    test('a soft delete does not ask for a permanent one', async () => {
        assert.equal(built().searchParams.get('deletetype'), null);
    });

    test('and the permanent delete asks, in the one word that means it', async () => {
        // Without `deletetype=permanent` this request succeeds, reports
        // nothing unusual, and erases nothing -- it just soft-deletes again.
        assert.equal(built({ permanent: true }).searchParams.get('deletetype'), 'permanent');
    });
});

describe('escaping the blob name', () => {
    test('slashes survive, because they are structure', async () => {
        // Encoding the whole path would collapse the prefix into a single
        // literal segment and address a blob that does not exist -- which
        // deletes nothing and reports success.
        assert.equal(built().pathname, '/raw/elder.example/u_01/message.eml');
    });

    test('everything else does not, because it is data', async () => {
        const url = built({ name: 'elder.example/u_01/re: hello & goodbye.eml' });

        assert.equal(url.pathname, '/raw/elder.example/u_01/re%3A%20hello%20%26%20goodbye.eml');
    });

    test('a question mark cannot start a query string', async () => {
        // Unescaped, everything after it would be read as parameters and the
        // request would aim at a shorter name than the caller asked for.
        const url = built({ name: 'elder.example/what?.eml' });

        assert.equal(url.pathname, '/raw/elder.example/what%3F.eml');
        assert.equal(url.searchParams.get('versionid'), '2026-08-08T09:00:00.0000000Z');
    });
});

describe('what the module leaves to its caller', () => {
    test('a missing client id is not refused here', async () => {
        // The check that matters is in the timer, which reports the
        // misconfiguration rather than erasing with the wrong identity.
        // Throwing here would turn that into a stack trace at module load.
        assert.doesNotThrow(() => createPurgeStore({ accountName: 'mjst' }));
    });
});
