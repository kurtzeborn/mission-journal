// The three things every entry point needs, built once.
//
// Nineteen files each declared their own `let cachedBlobs = null` and their
// own three-line accessor, which was harmless right up until it wasn't. Two
// things went wrong in that copying, and only one of them is tidiness:
//
//   **Half of them read `process.env` directly.** `CLAIM_TOKEN_KEY` and
//   `CLOUDFLARE_API_TOKEN` are Key Vault references, and an unresolved
//   reference arrives as the literal text `@Microsoft.KeyVault(...)` rather
//   than as nothing at all -- which is the entire reason `setting()` exists,
//   and is documented at length at the top of settings.js. A handler reading
//   `process.env.CLAIM_TOKEN_KEY` past a failed resolution would sign and
//   verify tokens with the reference string as the key, and would look like
//   it was working. Routing every one of them through `setting()` here means
//   the guard cannot be forgotten by the twentieth file.
//
//   **Each cache was per-module,** so a process that touched five endpoints
//   held five credentials and five storage clients for the same account.
//   Nothing was measurably wrong with that, but nothing was right about it
//   either.
//
// Lazy, because these are constructed at first use rather than at import: a
// timer that only ever sends mail should not open a table client, and a test
// that imports a handler to check it registers should not need a credential
// at all.

import { createMailer } from './mail.js';
import { setting } from './settings.js';
import { createBlobStore } from './store.js';
import { createTableStore } from './tables.js';

let blobs = null;
let tables = null;
let post = null;

export const blobStore = () =>
    (blobs ??= createBlobStore({ accountName: setting('STORAGE_ACCOUNT_NAME') }));

export const tableStore = () =>
    (tables ??= createTableStore({ accountName: setting('STORAGE_ACCOUNT_NAME') }));

export const mailer = () =>
    (post ??= createMailer({
        accountId: setting('CLOUDFLARE_ACCOUNT_ID'),
        token: setting('CLOUDFLARE_API_TOKEN'),
        allowlist: setting('MAIL_ALLOWLIST')
    }));

/**
 * The key that signs and verifies every link we mail somebody.
 *
 * One key behind claim, invitation, opt-out, relay and print links, so this
 * is one function rather than the five near-identical copies it replaces --
 * which differed only in the word they logged, and in whether they went
 * through `setting()`.
 *
 * There is deliberately no fallback. A default here would make every token in
 * the system forgeable by anyone who read the source, and would do it
 * silently, because the flow would carry on working.
 *
 * @param {string} who the caller, for the log line
 * @param {object} context the invocation context, for `error`
 * @returns {string|null} null when it is not configured, which every caller
 *   turns into a 503 rather than a signature it cannot trust
 */
export function signingKey(who, context) {
    const key = setting('CLAIM_TOKEN_KEY');
    if (!key) {
        context?.error?.(`${who}: CLAIM_TOKEN_KEY is not configured; refusing to sign or verify`);
        return null;
    }
    return key;
}

/** Reset between tests. Never called in production -- nothing there restarts. */
export function forgetClients() {
    blobs = null;
    tables = null;
    post = null;
}
