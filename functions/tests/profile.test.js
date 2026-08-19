// Renaming an archive.
//
// The thing under test is not really the form -- it is that two records agree
// afterwards. The blob is what survives a rebuild and the `sites` row is what
// every reader path actually consults, so a rename that updates one and not
// the other is a rename that comes back later.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { readProfile, saveProfile } from '../src/lib/profile.js';
import { read } from '../src/functions/profile.js';
import { sitesBySlug, setSiteProfile } from '../src/lib/sites.js';
import { ROLE } from '../src/lib/acl.js';
import { memoryStore } from './memory-store.js';

const SLUG = 'elder.example';
const silent = { info() {}, warn() {}, error() {} };

const nameOf = async (store) => (await sitesBySlug({ tables: store, slugs: [SLUG] })).get(SLUG).missionaryDisplayName;

const save = (store, fields) =>
    saveProfile({ store, tables: store, slug: SLUG, log: silent, ...fields });

describe('reading a profile that is not there', () => {
    test('a site claimed before profiles existed is blank, not broken', async () => {
        // The common case, not the exotic one: the claim flow writes the
        // `sites` row and no file at all.
        const store = memoryStore();

        const { profile, etag } = await readProfile({ store, slug: SLUG });

        assert.equal(profile.displayName, '');
        assert.equal(profile.slug, SLUG);
        assert.equal(etag, '');
    });

    test('a corrupt file is treated as blank rather than as a wall', async () => {
        const store = memoryStore();
        await store.writeBlob('config', `${SLUG}/profile.json`, 'not json at all');

        const { profile } = await readProfile({ store, slug: SLUG });

        assert.equal(profile.displayName, '');
    });
});

describe('renaming', () => {
    test('both records agree afterwards', async () => {
        const store = memoryStore();

        const result = await save(store, { displayName: 'Elder Example' });

        assert.equal(result.error, undefined);
        assert.equal(store.json('config', `${SLUG}/profile.json`).displayName, 'Elder Example');
        assert.equal(await nameOf(store), 'Elder Example');
    });

    test('a typo can be corrected, which is the entire point', async () => {
        const store = memoryStore();
        await setSiteProfile({ tables: store, slug: SLUG, missionaryDisplayName: 'Elder Exmaple' });

        await save(store, { displayName: 'Elder Example' });

        assert.equal(await nameOf(store), 'Elder Example');
    });

    test('an empty name is refused, because every page is headed with it', async () => {
        const store = memoryStore();

        assert.equal((await save(store, { displayName: '   ' })).error, 'a display name is required');
        assert.equal((await save(store, {})).error, 'a display name is required');
    });

    test('a newline cannot be smuggled into a name', async () => {
        // The name is pasted into the subject line of every invitation. A
        // newline there is header injection, so it is refused at the boundary
        // rather than trusted to six call sites.
        const store = memoryStore();

        await save(store, { displayName: 'Elder Example\r\nBcc: someone@evil.test' });

        assert.equal(await nameOf(store), 'Elder Example Bcc: someone@evil.test');
    });

    test('a very long name is cut rather than refused', async () => {
        const store = memoryStore();

        await save(store, { displayName: 'E'.repeat(400) });

        assert.equal((await nameOf(store)).length, 60);
    });
});

describe('which mission it was', () => {
    test('is kept as it was written', async () => {
        const store = memoryStore();

        await save(store, {
            displayName: 'Elder Example',
            mission: 'Argentina Buenos Aires North Mission'
        });

        assert.equal(
            store.json('config', `${SLUG}/profile.json`).mission,
            'Argentina Buenos Aires North Mission'
        );
    });

    test('takes whatever it is given, because no list of missions is current for long', async () => {
        const store = memoryStore();

        await save(store, { displayName: 'Elder Example', mission: 'the one with the mountains' });

        assert.equal(
            store.json('config', `${SLUG}/profile.json`).mission,
            'the one with the mountains'
        );
    });

    test('is tidied on the way in', async () => {
        // It goes on a cover. A newline in it would break the line it is set
        // on rather than being visible as a mistake.
        const store = memoryStore();

        await save(store, { displayName: 'Elder Example', mission: '  Chile\n  Santiago  East ' });

        assert.equal(store.json('config', `${SLUG}/profile.json`).mission, 'Chile Santiago East');
    });

    test('is absent rather than empty when nobody said', async () => {
        const store = memoryStore();

        await save(store, { displayName: 'Elder Example' });

        assert.equal('mission' in store.json('config', `${SLUG}/profile.json`), false);
    });

    test('can be cleared again', async () => {
        const store = memoryStore();
        await save(store, { displayName: 'Elder Example', mission: 'Chile Santiago East' });

        await save(store, { displayName: 'Elder Example', mission: '' });

        assert.equal('mission' in store.json('config', `${SLUG}/profile.json`), false);
    });
});

describe('the return date', () => {
    test('is kept when it is a date', async () => {
        const store = memoryStore();

        await save(store, { displayName: 'Elder Example', returnDate: '2027-06-15' });

        assert.equal(store.json('config', `${SLUG}/profile.json`).returnDate, '2027-06-15');
    });

    test('is absent rather than empty when nobody set one', async () => {
        // Absent means "derive it from the letters". An empty string would
        // make that indistinguishable from "there is no return date".
        const store = memoryStore();

        await save(store, { displayName: 'Elder Example' });

        assert.equal('returnDate' in store.json('config', `${SLUG}/profile.json`), false);
    });

    test('can be cleared again', async () => {
        const store = memoryStore();
        await save(store, { displayName: 'Elder Example', returnDate: '2027-06-15' });

        await save(store, { displayName: 'Elder Example', returnDate: '' });

        assert.equal('returnDate' in store.json('config', `${SLUG}/profile.json`), false);
    });

    test('refuses a day that does not exist', async () => {
        // Matches the pattern and is not a date. Worth its own test because
        // the regular expression alone accepts it.
        const store = memoryStore();

        const result = await save(store, { displayName: 'Elder Example', returnDate: '2027-02-31' });

        assert.match(result.error, /must be a date/);
    });

    test('refuses anything that is not a plain calendar day', async () => {
        const store = memoryStore();

        for (const bad of ['June 2027', '15/06/2027', '2027-06-15T00:00:00Z', '2027-6-5']) {
            const result = await save(store, { displayName: 'Elder Example', returnDate: bad });
            assert.match(result.error ?? '', /must be a date/, bad);
        }
    });

    test('a bad date changes nothing at all', async () => {
        // The name and the date arrive together, so a rejected date must not
        // half-apply the rename.
        const store = memoryStore();
        await save(store, { displayName: 'Elder Example' });

        await save(store, { displayName: 'Sister Someone', returnDate: 'soon' });

        assert.equal(await nameOf(store), 'Elder Example');
    });
});

// The start date is the first thing in the profile that a reader is ever shown
// -- the archive page counts up from it in front of the whole family -- so it
// has to reach the `sites` row, which is what the read path consults. A date
// that lives only in the blob is a counter that never appears.
describe('the mission start date', () => {
    const startOf = async (store) =>
        (await sitesBySlug({ tables: store, slugs: [SLUG] })).get(SLUG).missionStartDate;

    test('reaches both records', async () => {
        const store = memoryStore();

        await save(store, { displayName: 'Elder Example', startDate: '2025-06-15' });

        assert.equal(store.json('config', `${SLUG}/profile.json`).startDate, '2025-06-15');
        assert.equal(await startOf(store), '2025-06-15');
    });

    test('is absent rather than empty when nobody set one', async () => {
        const store = memoryStore();

        await save(store, { displayName: 'Elder Example' });

        assert.equal('startDate' in store.json('config', `${SLUG}/profile.json`), false);
        assert.equal(await startOf(store), '');
    });

    test('clearing it takes the counter off the archive', async () => {
        // The row is the copy the archive page reads, so a clear that only
        // reached the blob would leave the counter running for everybody.
        const store = memoryStore();
        await save(store, { displayName: 'Elder Example', startDate: '2025-06-15' });

        await save(store, { displayName: 'Elder Example', startDate: '' });

        assert.equal('startDate' in store.json('config', `${SLUG}/profile.json`), false);
        assert.equal(await startOf(store), '');
    });

    test('refuses anything that is not a plain calendar day', async () => {
        const store = memoryStore();

        for (const bad of ['June 2025', '2025-02-31', '2025-06-15T00:00:00Z', 'soon']) {
            const result = await save(store, { displayName: 'Elder Example', startDate: bad });
            assert.match(result.error ?? '', /start date must be a date/, bad);
        }
    });

    test('a bad start date changes nothing at all', async () => {
        const store = memoryStore();
        await save(store, { displayName: 'Elder Example' });

        await save(store, { displayName: 'Sister Someone', startDate: 'soon' });

        assert.equal(await nameOf(store), 'Elder Example');
    });

    test('survives the mission being renamed afterwards', async () => {
        // The two fields share one form and one write, and the rename is the
        // thing people come back to do.
        const store = memoryStore();
        await save(store, { displayName: 'Elder Exmaple', startDate: '2025-06-15' });

        await save(store, { displayName: 'Elder Example', startDate: '2025-06-15' });

        assert.equal(await startOf(store), '2025-06-15');
    });
});

describe('what is not touched', () => {
    test('alternateSenders survives an edit that cannot see it', async () => {
        // Nothing reads the field yet and nothing here can set it, so the one
        // property that matters is that editing the name does not delete it.
        const store = memoryStore();
        await store.writeBlob(
            'config',
            `${SLUG}/profile.json`,
            JSON.stringify({ slug: SLUG, displayName: 'Elder Example', alternateSenders: ['elder@personal.test'] })
        );

        await save(store, { displayName: 'Elder Renamed' });

        assert.deepEqual(store.json('config', `${SLUG}/profile.json`).alternateSenders, [
            'elder@personal.test'
        ]);
    });

    test('createdAt is not rewritten by a rename', async () => {
        const store = memoryStore();
        await store.writeBlob(
            'config',
            `${SLUG}/profile.json`,
            JSON.stringify({ slug: SLUG, displayName: 'Elder Example', createdAt: '2026-01-01T00:00:00Z' })
        );

        await save(store, { displayName: 'Elder Renamed' });

        assert.equal(store.json('config', `${SLUG}/profile.json`).createdAt, '2026-01-01T00:00:00Z');
    });
});

describe('two owners at once', () => {
    test('the second creation is refused rather than silently winning', async () => {
        // A parent and the missionary both hold the owner seat, so simultaneous
        // is normal rather than exotic. Simulated by writing the file between
        // this call's read and its write.
        const store = memoryStore();
        const realRead = store.readBlob.bind(store);
        store.readBlob = async (container, name) => {
            const found = await realRead(container, name);
            if (name.endsWith('profile.json') && !found) {
                await store.writeBlob('config', name, JSON.stringify({ slug: SLUG, displayName: 'Theirs' }));
            }
            return found;
        };

        const result = await save(store, { displayName: 'Mine' });

        assert.equal(result.error, 'somebody else changed this first');
        assert.equal(store.json('config', `${SLUG}/profile.json`).displayName, 'Theirs');
    });
});

// The form the owner is actually handed. What is checked here is that it
// arrives knowing the archive's name -- because for every site claimed before
// profiles existed, the name lives in a place `readProfile` never looks.
describe('the settings form arrives filled in', () => {
    const OWNER = 'mum@example.com';
    const READER = 'gran@example.com';

    const header = (email) =>
        Buffer.from(JSON.stringify({ userDetails: email, identityProvider: 'aad' })).toString('base64');

    const request = (as) => ({
        headers: { get: (name) => (name === 'x-ms-client-principal' ? header(as) : null) },
        params: { slug: SLUG },
        method: 'GET',
        url: `https://pdayletters.com/api/profile/${SLUG}`
    });

    const get = (store, as) =>
        read({ request: request(as), context: { ...silent, log() {} }, store, tables: store });

    async function seeded() {
        const store = memoryStore();
        store.acl(SLUG, [
            { email: OWNER, role: ROLE.owner },
            { email: READER, role: ROLE.reader }
        ]);
        return store;
    }

    test('a site with no profile.json still knows what it is called', async () => {
        const store = await seeded();
        await setSiteProfile({ tables: store, slug: SLUG, missionaryDisplayName: 'Elder Example' });

        const response = await get(store, OWNER);

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.displayName, 'Elder Example');
    });

    test('the file wins when there is one, because it is the record', async () => {
        const store = await seeded();
        await setSiteProfile({ tables: store, slug: SLUG, missionaryDisplayName: 'Stale Index' });
        await store.writeBlob(
            'config',
            `${SLUG}/profile.json`,
            JSON.stringify({ slug: SLUG, displayName: 'Elder Renamed' })
        );

        const response = await get(store, OWNER);

        assert.equal(response.jsonBody.displayName, 'Elder Renamed');
    });

    test('a site with neither is blank, and the placeholder does its job', async () => {
        const store = await seeded();

        const response = await get(store, OWNER);

        assert.equal(response.jsonBody.displayName, '');
    });

    test('the dates come back so the form is not retyped from memory', async () => {
        const store = await seeded();
        await save(store, {
            displayName: 'Elder Example',
            startDate: '2025-06-15',
            returnDate: '2027-06-15'
        });

        const response = await get(store, OWNER);

        assert.equal(response.jsonBody.startDate, '2025-06-15');
        assert.equal(response.jsonBody.returnDate, '2027-06-15');
    });

    test('a date nobody has set arrives empty rather than missing', async () => {
        // The form assigns straight into an <input type="date">, and undefined
        // there is the string "undefined".
        const store = await seeded();

        const response = await get(store, OWNER);

        assert.equal(response.jsonBody.startDate, '');
        assert.equal(response.jsonBody.returnDate, '');
    });

    test('the fallback is not a way past the owner check', async () => {
        const store = await seeded();
        await setSiteProfile({ tables: store, slug: SLUG, missionaryDisplayName: 'Elder Example' });

        const response = await get(store, READER);

        assert.equal(response.status, 403);
    });

    // Carried on this response because this is the page the delete control
    // lives on, and the form cannot ask for a reason it does not know is
    // required.
    test('and it says when the authority came from the operator setting', async () => {
        const before = process.env.OPERATOR_EMAILS;
        process.env.OPERATOR_EMAILS = 'ops@pdayletters.com';
        try {
            const store = await seeded();

            const mine = await get(store, OWNER);
            const theirs = await get(store, 'ops@pdayletters.com');

            assert.equal(mine.jsonBody.viaOperator, false);
            assert.equal(theirs.jsonBody.viaOperator, true);
        } finally {
            if (before === undefined) delete process.env.OPERATOR_EMAILS;
            else process.env.OPERATOR_EMAILS = before;
        }
    });
});
