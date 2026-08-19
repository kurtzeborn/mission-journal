import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setting } from '../src/lib/settings.js';

describe('reading configuration', () => {
    const NAME = 'MJ_TEST_SETTING';

    afterEach(() => {
        delete process.env[NAME];
    });

    test('a setting that is there is the setting', () => {
        process.env[NAME] = 'a-real-value';

        assert.equal(setting(NAME, 'fallback'), 'a-real-value');
    });

    test('a setting that is not there is the fallback', () => {
        assert.equal(setting(NAME, 'fallback'), 'fallback');
    });

    test('a setting with nothing to fall back on is empty rather than undefined', () => {
        assert.equal(setting(NAME), '');
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
