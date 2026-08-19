// Day thirty.
//
// The fake below is the interesting part of this file. It enforces the three
// rules that were measured against the real account, so a purge that skips a
// pass fails here rather than in production -- where the symptom is a family
// told their letters were erased and letters still sitting in the account.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import { eraseSite, runDueErasures, ERASED_CONTAINERS } from '../src/lib/erase.js';
import { deleteSite } from '../src/lib/deletion.js';
import { ROLE } from '../src/lib/acl.js';
import { TABLES } from '../src/lib/tables.js';

const SLUG = 'elder.example';
const MUM = 'mum@example.com';
const MEMBERS = [{ email: MUM, role: ROLE.owner }];

const silent = { info() {}, warn() {}, error() {} };
const at = (when) => () => new Date(when);

const DELETED = at('2026-08-08T09:00:00Z');
const DAY_29 = at('2026-09-06T09:00:00Z');
const DAY_30 = at('2026-09-07T09:00:01Z');

/**
 * A blob account with versioning on, enforcing the rules the real one does.
 *
 *   * A version that is still the current version of a live blob cannot be
 *     deleted at all -- 403, the same as the service. The base blob has to go
 *     first, which demotes it.
 *   * Deleting a version soft-deletes it. It is still there.
 *   * Permanently deleting a version that has not been soft-deleted is a 409.
 *
 * Every one of those is a way to leave data behind while reporting success,
 * which is why the fake refuses rather than tolerating them.
 */
function fakeAccount() {
    // container -> name -> [{ versionId, current, softDeleted }]
    const state = new Map();
    const of = (container) => {
        if (!state.has(container)) state.set(container, new Map());
        return state.get(container);
    };

    let seq = 0;
    const find = (container, name, versionId) =>
        of(container)
            .get(name)
            ?.find((version) => version.versionId === versionId);

    return {
        state,
        put(container, name, howMany = 1) {
            const versions = of(container).get(name) ?? [];
            for (let i = 0; i < howMany; i += 1) {
                for (const version of versions) version.current = false;
                versions.push({ versionId: `v${++seq}`, current: true, softDeleted: false });
            }
            of(container).set(name, versions);
        },
        remaining() {
            let count = 0;
            for (const names of state.values()) {
                for (const versions of names.values()) count += versions.length;
            }
            return count;
        },

        async listVersions(container, prefix) {
            const found = [];
            for (const [name, versions] of of(container)) {
                if (!name.startsWith(prefix)) continue;
                for (const version of versions) {
                    found.push({
                        name,
                        versionId: version.versionId,
                        isCurrentVersion: version.current,
                        deleted: version.softDeleted
                    });
                }
            }
            return found;
        },

        async deleteBlob(container, name) {
            // Demotes, it does not destroy. This is exactly the trap: the CLI
            // does this much and exits 0.
            for (const version of of(container).get(name) ?? []) version.current = false;
        },

        async softDeleteVersion(container, name, versionId) {
            const version = find(container, name, versionId);
            if (!version) return;
            if (version.current) throw new Error('403 OperationNotAllowedOnRootBlob');
            version.softDeleted = true;
        },

        async permanentlyDeleteVersion(container, name, versionId) {
            const version = find(container, name, versionId);
            if (!version) return;
            if (version.current) throw new Error('403 OperationNotAllowedOnRootBlob');
            if (!version.softDeleted) throw new Error('409 BlobSnapshotNotSoftDeleted');
            const versions = of(container).get(name).filter((v) => v !== version);
            if (versions.length) of(container).set(name, versions);
            else of(container).delete(name);
        }
    };
}

async function deleted({ now = DELETED } = {}) {
    const store = memoryStore();
    store.acl(SLUG, MEMBERS);

    const purge = fakeAccount();
    purge.put('raw', `${SLUG}/u_01/message.eml`, 3);
    purge.put('rendered', `${SLUG}/posts.json`, 5);
    purge.put('rendered', `${SLUG}/photos/p_1/large.webp`);
    purge.put('config', `${SLUG}/profile.json`, 2);
    purge.put('exports', `${SLUG}/owner.zip`);
    purge.put('raw', 'other.example/u_01/message.eml', 4);

    await deleteSite({ store, tables: store, slug: SLUG, by: MUM, now, log: silent });
    return { store, purge };
}

const erase = ({ store, purge }, now) =>
    eraseSite({ purge, store, tables: store, slug: SLUG, now, log: silent });

describe('when it runs at all', () => {
    test('not on day twenty-nine', async () => {
        const world = await deleted();

        const result = await erase(world, DAY_29);

        assert.equal(result.outcome, 'not-due');
        assert.equal(world.purge.remaining(), 16);
    });

    test('on day thirty', async () => {
        const world = await deleted();

        assert.equal((await erase(world, DAY_30)).outcome, 'erased');
    });

    test('not for an archive that was never deleted', async () => {
        const store = memoryStore();
        store.acl(SLUG, MEMBERS);

        assert.equal((await erase({ store, purge: fakeAccount() }, DAY_30)).outcome, 'gone');
    });

    test('a record with an unreadable date is never due', async () => {
        // Parsed, this would be NaN, and a numeric comparison would read it as
        // 1970 and erase immediately. Not due is the only safe reading.
        const world = await deleted();
        await world.store.upsertEntity(TABLES.deletions, {
            partitionKey: SLUG,
            rowKey: 'record',
            purgeAfter: 'soon'
        });

        assert.equal((await erase(world, DAY_30)).outcome, 'not-due');
        assert.equal(world.purge.remaining(), 16);
    });
});

describe('what it takes, and what it leaves', () => {
    test('every version of every blob, not just the current one', async () => {
        // The failure mode this exists for: a purge that deletes base blobs,
        // reports success, and leaves thirty days of recoverable versions of a
        // family's letters sitting in the account.
        const world = await deleted();

        const result = await erase(world, DAY_30);

        assert.equal(result.versions, 12);
        for (const container of ERASED_CONTAINERS) {
            assert.deepEqual(await world.purge.listVersions(container, `${SLUG}/`), []);
        }
    });

    test('and nothing belonging to any other archive', async () => {
        const world = await deleted();

        await erase(world, DAY_30);

        assert.equal((await world.purge.listVersions('raw', 'other.example/')).length, 4);
    });

    test('including the copy of the member list deletion left behind', async () => {
        // It lives beside the ACL in `config/` precisely so that this sweep
        // takes it. Otherwise the one surviving artifact of an archive that is
        // supposed to be gone is the list of everybody who could read it.
        const world = await deleted();
        world.purge.put('config', `${SLUG}/deleted-acl.json`);

        await erase(world, DAY_30);

        assert.deepEqual(await world.purge.listVersions('config', `${SLUG}/`), []);
    });

    test('the record goes last, so a failure leaves something to retry', async () => {
        const world = await deleted();

        await erase(world, DAY_30);

        assert.equal(await world.store.getEntity(TABLES.deletions, SLUG, 'record'), null);
    });

    test('and the site row, which deletion deliberately kept', async () => {
        // The row carries the missionary's display name, so deletion leaves it
        // alone -- restoring an archive whose name had been thrown away would
        // put a family back with a blank masthead. Erasure makes no such
        // promise, and a row left here would keep the archive on the
        // operator's service-wide view forever with nothing behind it.
        const world = await deleted();
        await world.store.upsertEntity(TABLES.sites, {
            partitionKey: SLUG,
            rowKey: 'activity',
            lastPostAt: '2026-08-01T09:00:00.000Z',
            missionaryDisplayName: 'Elder Example'
        });

        await erase(world, DAY_30);

        assert.equal(await world.store.getEntity(TABLES.sites, SLUG, 'activity'), null);
    });

    test('running it twice is not an error', async () => {
        // The retry path, and the ordering above guarantees it happens.
        const world = await deleted();
        await erase(world, DAY_30);

        assert.equal((await erase(world, DAY_30)).outcome, 'gone');
    });
});

describe('the slug that came back to life', () => {
    // Deletion does not reserve the name, so a forward can start a fresh
    // pending site under it and somebody can claim that. This appointment then
    // points at a different family's letters.
    const reoccupied = async () => {
        const world = await deleted();
        world.store.acl(SLUG, [{ email: 'newfamily@example.com', role: ROLE.owner }]);
        world.purge.put('rendered', `${SLUG}/posts.json`);
        return world;
    };

    test('is not erased', async () => {
        const world = await reoccupied();

        assert.equal((await erase(world, DAY_30)).outcome, 'recreated');
    });

    test('and keeps every blob, including the old family\u2019s', async () => {
        // Sorting the two apart is not something this timer can do safely, and
        // the direction to fail in is obvious.
        const world = await reoccupied();
        const before = world.purge.remaining();

        await erase(world, DAY_30);

        assert.equal(world.purge.remaining(), before);
    });

    test('the appointment is cancelled rather than retried tomorrow', async () => {
        // It will never become appropriate again, and a record that retries
        // daily is an alarm that fires forever.
        const world = await reoccupied();

        await erase(world, DAY_30);

        assert.equal(await world.store.getEntity(TABLES.deletions, SLUG, 'record'), null);
    });

    test('but the old family\u2019s member list does not stay behind', async () => {
        // The one thing here that belongs to the family who left. Cancelling
        // the appointment is the last moment anything knows the grave exists,
        // so leaving it would strand a member list under a slug that now
        // belongs to strangers -- for good.
        const world = await reoccupied();

        await erase(world, DAY_30);

        assert.equal(await world.store.readBlob('config', `${SLUG}/deleted-acl.json`), null);
    });
});

describe('the daily run', () => {
    test('takes the due and leaves the rest', async () => {
        const store = memoryStore();
        const purge = fakeAccount();
        for (const slug of ['a.one', 'b.two']) {
            store.acl(slug, MEMBERS);
            purge.put('rendered', `${slug}/posts.json`);
        }
        await deleteSite({ store, tables: store, slug: 'a.one', by: MUM, now: DELETED, log: silent });
        await deleteSite({
            store,
            tables: store,
            slug: 'b.two',
            by: MUM,
            now: at('2026-09-01T09:00:00Z'),
            log: silent
        });

        const results = await runDueErasures({ purge, store, tables: store, now: DAY_30, log: silent });

        assert.deepEqual(
            results.map((r) => [r.slug, r.outcome]),
            [
                ['a.one', 'erased'],
                ['b.two', 'not-due']
            ]
        );
    });

    test('one archive failing does not hold up the others', async () => {
        // A single stuck slug must not hold every other family's deletion open
        // indefinitely. The promise made to each of them was about their own
        // archive.
        const store = memoryStore();
        const purge = fakeAccount();
        for (const slug of ['a.one', 'b.two']) {
            store.acl(slug, MEMBERS);
            purge.put('rendered', `${slug}/posts.json`);
            await deleteSite({ store, tables: store, slug, by: MUM, now: DELETED, log: silent });
        }

        const listVersions = purge.listVersions.bind(purge);
        purge.listVersions = async (container, prefix) => {
            if (prefix === 'a.one/') throw new Error('storage said no');
            return listVersions(container, prefix);
        };

        const results = await runDueErasures({ purge, store, tables: store, now: DAY_30, log: silent });

        assert.deepEqual(
            results.map((r) => [r.slug, r.outcome]),
            [
                ['a.one', 'failed'],
                ['b.two', 'erased']
            ]
        );
    });

    test('and the failed one is still on the books tomorrow', async () => {
        const store = memoryStore();
        const purge = fakeAccount();
        store.acl('a.one', MEMBERS);
        purge.put('rendered', 'a.one/posts.json');
        await deleteSite({ store, tables: store, slug: 'a.one', by: MUM, now: DELETED, log: silent });

        purge.listVersions = async () => {
            throw new Error('storage said no');
        };
        await runDueErasures({ purge, store, tables: store, now: DAY_30, log: silent });

        assert.ok(await store.getEntity(TABLES.deletions, 'a.one', 'record'));
    });

    test('an account with nothing deleted does nothing', async () => {
        const store = memoryStore();

        assert.deepEqual(
            await runDueErasures({ purge: fakeAccount(), store, tables: store, now: DAY_30, log: silent }),
            []
        );
    });
});
