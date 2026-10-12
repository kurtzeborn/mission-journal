// Does the fake behave like the real thing?
//
// Every other test in this suite runs against `memoryStore()`, which means the
// suite is only as honest as that fake. The failure this file exists to catch
// is the one that actually happened: `promotePending` called `store.enqueue`,
// the fake had an `enqueue`, the real store did not, and 257 tests passed
// against code that threw the moment it ran in Azure.
//
// A fake that is *richer* than the real store is worse than no fake at all,
// because it manufactures confidence. So the rule below is one-directional and
// deliberately blunt: anything production code can reach on the fake must
// exist on the real store.
//
// Neither client performs I/O when constructed, so this needs no network, no
// credentials and no Azure. A stub credential is passed only because the real
// `DefaultAzureCredential` goes looking for one at construction time.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createBlobStore } from '../src/lib/store.js';
import { createTableStore } from '../src/lib/tables.js';
import { memoryStore } from './memory-store.js';

const credential = {
    getToken: async () => ({ token: 'stub', expiresOnTimestamp: Date.now() + 60_000 })
};

const realSurface = () =>
    new Set([
        ...Object.keys(createBlobStore({ accountName: 'example', credential })),
        ...Object.keys(createTableStore({ accountName: 'example', credential }))
    ]);

// Helpers that exist to arrange and inspect a test, and have no business on a
// real store. Listed one by one rather than matched by a naming convention,
// so that adding a helper is a deliberate act and a *method* cannot be added
// by accident and then quietly excused as a helper.
const TEST_ONLY = new Set(['acl', 'blobs', 'conflictOnce', 'json', 'queues', 'seed', 'tables']);

// Real methods the fake does not implement. Every entry is a production code
// path this suite cannot exercise, so this list should only ever get shorter.
// It is empty: `readUrl` was the last one, and it is faked now that a handler
// exists whose whole purpose is the link it returns -- what the fake declines
// to imitate is the signature, which is storage's arithmetic and not ours.
const NOT_FAKED = new Set([]);

describe('the memory store and the real store agree', () => {
    test('the fake and production stores expose compatible production surfaces', () => {
        const real = realSurface();
        const fake = new Set(Object.keys(memoryStore()));
        const missing = Object.keys(memoryStore())
            .filter((name) => !TEST_ONLY.has(name))
            .filter((name) => !real.has(name));
        const unfaked = [...realSurface()].filter((name) => !fake.has(name)).sort();
        const collisions = [...TEST_ONLY].filter((name) => real.has(name));

        assert.deepEqual({
            fakeOnlyProductionMethods: missing,
            unfakedProductionMethods: unfaked,
            helperNameCollisions: collisions
        }, {
            fakeOnlyProductionMethods: [],
            unfakedProductionMethods: [...NOT_FAKED].sort(),
            helperNameCollisions: []
        });
    });
});
