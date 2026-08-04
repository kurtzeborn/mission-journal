// Reading the ACL, and turning it into a role for one signed-in identity.
//
// Extracted from ingest.js so there is exactly one reader of acl.json. A
// second parser is how the write format and the read format drift apart, and
// the failure is silent in the direction that matters: a mis-parsed ACL denies
// access to a family that has it, or grants it to someone who doesn't.

import { validSlug } from './paths.js';

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

/**
 * The single authorization decision for (identity, slug).
 *
 * Stage 1 has one branch: look the address up in acl.json. Operators resolve
 * above this in Phase 9 and invitations write into it; neither changes any
 * caller, which is the whole reason this is a function and not an inline
 * lookup in each endpoint.
 *
 * @returns {Promise<string|null>} a ROLE value, or null when not entitled
 */
export async function resolveRole({ store, slug, principal }) {
    const email = principal?.email;
    if (!email) return null;

    const members = await readAcl(store, slug);
    if (!members) return null;

    // Keyed on `email`, matching what seed-config.ps1 writes and what ingest
    // checks forwarding rights against.
    const member = members.find((m) => m.email?.toLowerCase() === email);
    if (!member) return null;

    // An unrecognized role is not treated as a reader. Roles reach this file
    // from a hand-edited JSON file, and quietly upgrading a typo into read
    // access to a family's letters is the wrong direction to fail in.
    return member.role === ROLE.owner || member.role === ROLE.reader ? member.role : null;
}
