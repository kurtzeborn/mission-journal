// Renaming an archive.
//
// The thing under test is not really the form -- it is that two records agree
// afterwards. The blob is what survives a rebuild and the `sites` row is what
// every reader path actually consults, so a rename that updates one and not
// the other is a rename that comes back later.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { readProfile, saveProfile } from '../src/lib/profile.js';
import { sitesBySlug, setSiteName } from '../src/lib/sites.js';
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
        await setSiteName({ tables: store, slug: SLUG, missionaryDisplayName: 'Elder Exmaple' });

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
