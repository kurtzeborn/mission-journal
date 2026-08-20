// The endpoint behind the email settings page.
//
// Two things it must get right, and neither is the reading and writing. It
// must refuse an unrecognised value instead of quietly turning it into "off"
// -- the safe-default rule that governs everything else here is exactly wrong
// when the client is trying to set something -- and it must report an
// unsubscribe separately from a preference, because they are different
// statements and only one of them is a preference.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from './memory-store.js';
import { read, write } from '../src/functions/preferences.js';
import { issueOptOut, recordOptOut } from '../src/lib/optout.js';
import { DIGEST, readUser, setDigest } from '../src/lib/users.js';

const THEM = 'grandma@example.com';
const KEY = 'a-signing-key-from-key-vault';
const silent = { info() {}, warn() {}, error() {} };
const at = (when) => () => new Date(when);

const signedIn = (email) =>
    email ? Buffer.from(JSON.stringify({ userDetails: email, identityProvider: 'google' })).toString('base64') : null;

const asking = (email, body) => ({
    method: body ? 'PUT' : 'GET',
    headers: { get: (name) => (name === 'x-ms-client-principal' ? signedIn(email) : null) },
    json: async () => body
});

describe('reading what somebody has asked for', () => {
    test('a stranger is refused before any table is touched', async () => {
        const response = await read({ request: asking(null), tables: null });
        assert.equal(response.status, 401);
    });

    test('an address with no row is off, and says it has never been asked', async () => {
        const store = memoryStore();
        const response = await read({ request: asking(THEM), tables: store });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.digestFrequency, DIGEST.off);
        assert.equal(response.jsonBody.answered, false);
        assert.equal(response.jsonBody.email, THEM);
    });

    test('an unsubscribe is reported next to the preference, not instead of it', async () => {
        const store = memoryStore();
        await setDigest({ tables: store, email: THEM, frequency: DIGEST.monthly, now: at('2026-08-01T00:00:00Z') });
        await recordOptOut({
            tables: store,
            token: issueOptOut({ email: THEM, slug: 'elder.example', key: KEY, now: at('2026-08-02T00:00:00Z') }),
            key: KEY,
            now: at('2026-08-02T00:00:00Z'),
            log: silent
        });

        const response = await read({ request: asking(THEM), tables: store });

        assert.equal(response.jsonBody.digestFrequency, DIGEST.monthly);
        assert.equal(response.jsonBody.suppressed, true);
    });

    test('nothing about a person is ever cached', async () => {
        const response = await read({ request: asking(THEM), tables: memoryStore() });
        assert.match(response.headers['Cache-Control'], /no-store/);
    });
});

describe('changing it', () => {
    test('a stranger cannot set another person preference', async () => {
        const response = await write({ request: asking(null, { digestFrequency: 'weekly' }), tables: null });
        assert.equal(response.status, 401);
    });

    test('each offered value is kept', async () => {
        for (const frequency of [DIGEST.monthly, DIGEST.weekly, DIGEST.off]) {
            const store = memoryStore();
            const response = await write({ request: asking(THEM, { digestFrequency: frequency }), tables: store });

            assert.equal(response.status, 200);
            assert.equal((await readUser({ tables: store, email: THEM })).digestFrequency, frequency);
        }
    });

    test('an unrecognised value is refused rather than silently made off', async () => {
        // The safe default belongs on the read side. Here it would mean a
        // typo in a client switching somebody's mail off and reporting
        // success.
        const store = memoryStore();
        const response = await write({ request: asking(THEM, { digestFrequency: 'daily' }), tables: store });

        assert.equal(response.status, 400);
        assert.equal(await readUser({ tables: store, email: THEM }), null);
    });

    test('a body that is not json is refused the same way', async () => {
        const store = memoryStore();
        const request = {
            method: 'PUT',
            headers: { get: (name) => (name === 'x-ms-client-principal' ? signedIn(THEM) : null) },
            json: async () => {
                throw new Error('not json');
            }
        };

        assert.equal((await write({ request, tables: store })).status, 400);
    });
});
