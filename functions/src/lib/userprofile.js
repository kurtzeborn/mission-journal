// The presentation half of a signed-in person.
//
// Authorization stays on verified email and provider identity. This row is
// only how the product refers to that person in invitations, membership lists
// and operator displays. The browser receives provider claims at `/.auth/me`;
// Functions do not, so a protected endpoint copies those values here.

import { TABLES } from './tables.js';
import { DIGEST_ROW, validFrequency } from './users.js';

export const PROFILE_ROW = 'profile';

const lower = (value) => String(value ?? '').trim().toLowerCase();
const clean = (value, maximum) =>
    String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximum);

export function normalizeUserProfile({ displayName, givenName, familyName, provider }) {
    return {
        displayName: clean(displayName, 200),
        givenName: clean(givenName, 100),
        familyName: clean(familyName, 100),
        nameProvider: clean(provider, 50).toLowerCase()
    };
}

export async function readUserProfile({ tables, email }) {
    const them = lower(email);
    if (!tables || !them) return null;
    return await tables.getEntity(TABLES.users, them, PROFILE_ROW);
}

export async function setUserProfile({
    tables,
    email,
    displayName,
    givenName = '',
    familyName = '',
    provider = '',
    now = () => new Date()
}) {
    const them = lower(email);
    if (!them) throw new Error('profile: an address is required');

    const profile = normalizeUserProfile({ displayName, givenName, familyName, provider });
    if (!profile.displayName) throw new Error('profile: a display name is required');

    const entity = {
        partitionKey: them,
        rowKey: PROFILE_ROW,
        ...profile,
        nameUpdatedAt: now().toISOString()
    };
    await tables.upsertEntity(TABLES.users, entity);
    return entity;
}

export async function userProfilesFor({ tables, emails }) {
    if (!tables) return new Map();
    const unique = [...new Set((emails ?? []).map(lower).filter(Boolean))];
    const found = new Map();

    await Promise.all(
        unique.map(async (email) => {
            const row = await readUserProfile({ tables, email });
            if (row?.displayName) found.set(email, row);
        })
    );

    return found;
}

/**
 * Presentation name and digest choice for a known list of members.
 *
 * Both rows share the email partition in `users`, so one bounded partition
 * query replaces the profile point read the People page already performed.
 * This does not scan the users table or add another request per member.
 */
export async function memberUserDetailsFor({ tables, emails }) {
    if (!tables) return new Map();
    const unique = [...new Set((emails ?? []).map(lower).filter(Boolean))];
    const found = new Map();

    await Promise.all(
        unique.map(async (email) => {
            const rows = await tables.listEntities(TABLES.users, { partitionKey: email });
            const profile = rows.find((row) => row.rowKey === PROFILE_ROW);
            const digest = rows.find((row) => row.rowKey === DIGEST_ROW);
            found.set(email, {
                displayName: profile?.displayName ?? '',
                digestFrequency: validFrequency(digest?.digestFrequency)
            });
        })
    );

    return found;
}

export async function userNameFor({ tables, email }) {
    return (await readUserProfile({ tables, email }))?.displayName ?? '';
}
