// Reading the ACL, and turning it into a role for one signed-in identity.
//
// Extracted from ingest.js so there is exactly one reader of acl.json. A
// second parser is how the write format and the read format drift apart, and
// the failure is silent in the direction that matters: a mis-parsed ACL denies
// access to a family that has it, or grants it to someone who doesn't.

import { validSlug } from './paths.js';
import { isOperator } from './operators.js';

/**
 * @returns {Array|null} the members array, or null when the site has no ACL
 */
export async function readAcl(store, slug) {
    const safe = validSlug(slug);
    if (!safe) return null;
    const blob = await store.readBlob('config', `${safe}/acl.json`);
    if (!blob) return null;
    const parsed = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
    return Array.isArray(parsed?.members) ? parsed.members : null;
}

export const ROLE = {
    owner: 'owner',
    reader: 'reader'
};

const NOBODY = { role: null, viaOperator: false };

/**
 * The single authorization decision for (identity, slug).
 *
 * Two branches: the site's own ACL, and the service-wide operator list. The
 * ACL is read first so that the answer for everybody who is not an operator --
 * which is everybody -- is exactly what it was before operators existed.
 *
 * `viaOperator` is what the callers need and a bare role cannot carry: it says
 * that some or all of this authority came from an app setting rather than from
 * the family's own list. It drives the banner and the audit event, and both of
 * those exist because private-by-default is a headline promise and this is the
 * standing exception to it.
 *
 * **An operator who is only a reader on a site still gets `owner`, and still
 * gets `viaOperator`.** The role is theirs by the setting, not by the ACL, so
 * saying otherwise would be the one case where operator authority went
 * unannounced.
 *
 * @returns {Promise<{role: string|null, viaOperator: boolean}>}
 */
export async function resolveAccess({ store, slug, principal, env }) {
    const email = principal?.email;
    if (!email) return NOBODY;

    const members = await readAcl(store, slug);

    // Keyed on `email`, matching what seed-config.ps1 writes and what ingest
    // checks forwarding rights against.
    const member = members?.find((m) => m.email?.toLowerCase() === email);

    // An unrecognized role is not treated as a reader. Roles reach this file
    // from a hand-edited JSON file, and quietly upgrading a typo into read
    // access to a family's letters is the wrong direction to fail in.
    const granted =
        member?.role === ROLE.owner || member?.role === ROLE.reader ? member.role : null;

    if (granted === ROLE.owner) return { role: ROLE.owner, viaOperator: false };

    if (isOperator(email, env)) return { role: ROLE.owner, viaOperator: true };

    return granted ? { role: granted, viaOperator: false } : NOBODY;
}

/**
 * The role alone, for the callers that have no use for where it came from.
 *
 * @returns {Promise<string|null>} a ROLE value, or null when not entitled
 */
export async function resolveRole({ store, slug, principal, env }) {
    return (await resolveAccess({ store, slug, principal, env })).role;
}
