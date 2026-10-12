import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setting } from '../src/lib/settings.js';

describe('reading configuration', () => {
    const NAME = 'MJ_TEST_SETTING';

    afterEach(() => {
        delete process.env[NAME];
    });

    test('uses a configured value, then a fallback, then an empty string', () => {
        const cases = [
            { value: 'a-real-value', fallback: 'fallback', expected: 'a-real-value' },
            { value: undefined, fallback: 'fallback', expected: 'fallback' },
            { value: undefined, fallback: undefined, expected: '' }
        ];

        for (const { value, fallback, expected } of cases) {
            if (value === undefined) delete process.env[NAME];
            else process.env[NAME] = value;
            assert.equal(setting(NAME, fallback), expected);
        }
    });

    // The whole reason this file exists. App Service hands the process the
    // reference itself when the secret behind it cannot be read, so a feature
    // guarded by `if (!key)` switches on with a key that is a sentence about
    // where a key would have come from.
    test('a Key Vault reference that never resolved counts as no setting at all', () => {
        process.env[NAME] = '@Microsoft.KeyVault(SecretUri=https://mj-kv.vault.azure.net/secrets/peecho-api-key/)';

        assert.equal(setting(NAME, ''), '');
    });

    test('a value that merely mentions a vault is still a value', () => {
        process.env[NAME] = 'https://mj-kv.vault.azure.net/';

        assert.equal(setting(NAME), 'https://mj-kv.vault.azure.net/');
    });
});
