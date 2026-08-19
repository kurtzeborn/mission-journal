// Reading configuration, with one rule that is not obvious.
//
// App Service resolves `@Microsoft.KeyVault(SecretUri=...)` settings before
// the process starts -- but when it *cannot* resolve one, it does not blank
// it and it does not fail to start. It hands the process the reference itself,
// as text. So a secret that has not been created yet arrives as a fifty-
// character string beginning `@Microsoft.KeyVault(`, and every `if (!key)`
// guard in the codebase reads that as configured.
//
// That is worse than an empty value in every case, because the feature then
// switches itself on and fails at the far end: a printer key that is really a
// reference gets a `401` from Peecho, and a signing key that is really a
// reference verifies nothing while looking like it does. Found the honest way
// -- by declaring the settings in Bicep before creating the secrets, and
// watching an endpoint that had been answering "not switched on" start
// answering "forbidden" instead.

const UNRESOLVED = '@Microsoft.KeyVault(';

/**
 * An app setting, or the fallback where there is nothing usable.
 *
 * Unresolved Key Vault references count as nothing usable, which is what they
 * are: the environment is telling us where a secret would have come from, not
 * what it is.
 */
export function setting(name, fallback = '') {
    const value = process.env[name];
    if (value === undefined || value.startsWith(UNRESOLVED)) return fallback;

    return value;
}
