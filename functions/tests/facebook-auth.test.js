import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

describe('Facebook authentication configuration', () => {
    test('Static Web Apps reads the App ID and secret from named settings', () => {
        const config = JSON.parse(read('web/staticwebapp.config.json'));

        assert.deepEqual(config.auth.identityProviders.facebook, {
            registration: {
                appIdSettingName: 'FACEBOOK_APP_ID',
                appSecretSettingName: 'FACEBOOK_APP_SECRET'
            },
            login: {
                scopes: ['public_profile', 'email']
            }
        });
    });

    test('infrastructure references the existing Key Vault secret', () => {
        const bicep = read('infra/main.bicep');

        assert.match(bicep, /param facebookAppId string = '1144678524889057'/);
        assert.match(bicep, /param facebookAppSecretName string = 'facebook-app-secret'/);
        assert.match(bicep, /FACEBOOK_APP_ID: facebookAppId/);
        assert.match(
            bicep,
            /FACEBOOK_APP_SECRET: '@Microsoft\.KeyVault\(SecretUri=\$\{keyVault\.properties\.vaultUri\}secrets\/\$\{facebookAppSecretName\}\/\)'/
        );
    });

    test('every sign-in chooser offers Facebook', () => {
        for (const file of ['login.html', 'claim.html', 'invite.html', 'join.html', 'email.html']) {
            assert.match(read(`web/${file}`), /id="signin-facebook"/, file);
        }
    });

    test('the privacy URL contains explicit Facebook deletion instructions', () => {
        const terms = read('web/terms.html');

        assert.match(terms, /id="data-deletion"/);
        assert.match(terms, /Facebook's Apps and Websites settings/);
    });
});
