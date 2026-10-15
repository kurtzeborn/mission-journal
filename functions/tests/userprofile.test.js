import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import {
    PROFILE_ROW,
    readUserProfile,
    setUserProfile,
    userProfilesFor
} from '../src/lib/userprofile.js';
import { read, write } from '../src/functions/userprofile.js';

const THEM = 'someone@example.com';
const principal = (email = THEM, provider = 'google') =>
    Buffer.from(JSON.stringify({
        userDetails: email,
        identityProvider: provider,
        userId: 'provider-id'
    })).toString('base64');
const request = (email, body, provider) => ({
    headers: new Headers(email ? { 'x-ms-client-principal': principal(email, provider) } : {}),
    json: async () => body
});

describe('the stored presentation profile', () => {
    test('it is a separate row from digest settings and preserves structured names', async () => {
        const store = memoryStore();
        await setUserProfile({
            tables: store,
            email: ` ${THEM.toUpperCase()} `,
            displayName: '  Ana   María  Example ',
            givenName: 'Ana María',
            familyName: 'Example',
            provider: 'Google',
            now: () => new Date('2026-10-15T00:00:00Z')
        });

        const row = await readUserProfile({ tables: store, email: THEM });
        assert.equal(row.rowKey, PROFILE_ROW);
        assert.equal(row.partitionKey, THEM);
        assert.equal(row.displayName, 'Ana María Example');
        assert.equal(row.givenName, 'Ana María');
        assert.equal(row.familyName, 'Example');
        assert.equal(row.nameProvider, 'google');
    });

    test('several addresses are resolved without manufacturing missing profiles', async () => {
        const store = memoryStore();
        await setUserProfile({ tables: store, email: THEM, displayName: 'Ana Example' });

        const found = await userProfilesFor({
            tables: store,
            emails: [THEM, 'missing@example.com', THEM.toUpperCase()]
        });
        assert.equal(found.size, 1);
        assert.equal(found.get(THEM).displayName, 'Ana Example');
    });
});

describe('the protected profile endpoint', () => {
    test('a signed-out caller can neither read nor write a profile', async () => {
        const store = memoryStore();
        assert.equal((await read({ request: request(), tables: store })).status, 401);
        assert.equal((await write({ request: request(null, { displayName: 'Stranger' }), tables: store })).status, 401);
    });

    test('the signed-in address and provider are authoritative', async () => {
        const store = memoryStore();
        const response = await write({
            request: request(THEM, {
                displayName: 'Ana Example',
                givenName: 'Ana',
                familyName: 'Example',
                provider: 'not-google',
                email: 'somebody-else@example.com'
            }, 'google'),
            tables: store
        });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.nameProvider, 'google');
        assert.equal((await readUserProfile({ tables: store, email: THEM })).displayName, 'Ana Example');
        assert.equal(await readUserProfile({ tables: store, email: 'somebody-else@example.com' }), null);
    });

    test('a provider without structured names clears old components', async () => {
        const store = memoryStore();
        await setUserProfile({
            tables: store,
            email: THEM,
            displayName: 'Ana Example',
            givenName: 'Ana',
            familyName: 'Example',
            provider: 'google'
        });

        await write({
            request: request(THEM, { displayName: 'Ana Example' }, 'aad'),
            tables: store
        });

        const row = await readUserProfile({ tables: store, email: THEM });
        assert.equal(row.nameProvider, 'aad');
        assert.equal(row.givenName, '');
        assert.equal(row.familyName, '');
    });
});
