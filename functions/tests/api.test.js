// The authorization gate and the reader/owner projection.
//
// These tests carry more weight than most in this repo. Everything else here
// decides how a letter is stored; this decides who gets to read it, and it is
// the only layer standing between a family's private mail and the internet.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { memoryStore } from './memory-store.js';
import { gate } from '../src/lib/api.js';
import { presentPosts, photoIsVisible } from '../src/lib/present.js';
import { readPrincipal } from '../src/lib/principal.js';

const SLUG = 'isaac.backman';

const header = (userDetails) =>
    Buffer.from(JSON.stringify({ userDetails, identityProvider: 'aad' })).toString('base64');

const request = ({ auth, slug = SLUG, ...params }) => ({
    headers: { get: (name) => (name === 'x-ms-client-principal' ? (auth ?? null) : null) },
    params: { slug, ...params }
});

const POSTS = [
    {
        id: '2025-11-10-ZHCM',
        originalDate: '2025-11-10T05:57:00',
        subject: 'Week one',
        bodyHtml: '<p>hello</p>',
        bodyHead100: 'hello',
        hidden: false,
        heldReason: null,
        editedBy: null,
        editedAt: null,
        originalFrom: 'isaac.backman@missionary.org',
        forwardedBy: 'scott@kurtzeborn.org',
        originalMessageId: null,
        photos: [{ id: 'p_0eade5b54243', width: 10, height: 10 }],
        linkedPhotoServices: ['googlePhotos'],
        sourceRawPath: 'raw/isaac.backman/u_01/message.eml'
    },
    {
        id: '2025-12-01-FRSN',
        originalDate: '2025-12-01T10:07:00',
        subject: 'Week four',
        bodyHtml: '<p>later</p>',
        hidden: true,
        heldReason: 'unverified-original',
        photos: [{ id: 'p_2b341147a59e', width: 10, height: 10 }],
        linkedPhotoServices: [],
        sourceRawPath: 'raw/isaac.backman/u_02/message.eml'
    }
];

function seeded({ members = [{ email: 'gran@example.com', role: 'reader' }] } = {}) {
    const store = memoryStore();
    store.blobs.set(`config/${SLUG}/acl.json`, {
        bytes: Buffer.from(JSON.stringify({ members })),
        etag: 'e1'
    });
    store.blobs.set(`rendered/${SLUG}/posts.json`, {
        bytes: Buffer.from(JSON.stringify(POSTS)),
        etag: 'e2'
    });
    return store;
}

describe('principal decoding', () => {
    test('a missing header is not an identity', () => {
        assert.equal(readPrincipal(null), null);
    });

    test('a header that is not base64 JSON is not an identity', () => {
        assert.equal(readPrincipal('not-base64-json'), null);
    });

    test('a principal with no userDetails is not an identity', () => {
        assert.equal(readPrincipal(Buffer.from('{"userId":"x"}').toString('base64')), null);
    });

    test('the address is lowercased once, here', () => {
        assert.equal(readPrincipal(header('Gran@Example.COM')).email, 'gran@example.com');
    });
});

describe('the gate', () => {
    test('an anonymous caller gets 401 and is never cached', async () => {
        const result = await gate({ store: seeded(), request: request({}) });
        assert.equal(result.denied.status, 401);
        assert.equal(result.denied.headers['Cache-Control'], 'no-store');
    });

    test('a signed-in stranger gets 404, not 403', async () => {
        // 403 would confirm the site exists. The whole point is that the list
        // of missionaries is not enumerable by someone with any account.
        const result = await gate({
            store: seeded(),
            request: request({ auth: header('stranger@example.com') })
        });
        assert.equal(result.denied.status, 404);
    });

    test('a traversal slug never reaches a blob path', async () => {
        const store = seeded();
        const result = await gate({
            store,
            request: request({ auth: header('gran@example.com'), slug: '../config/other' })
        });
        assert.equal(result.denied.status, 404);
    });

    test('a site with no ACL is closed, not open', async () => {
        const store = seeded();
        store.blobs.delete(`config/${SLUG}/acl.json`);
        const result = await gate({
            store,
            request: request({ auth: header('gran@example.com') })
        });
        assert.equal(result.denied.status, 404);
    });

    test('a bare-array acl.json is rejected rather than guessed at', async () => {
        const store = seeded();
        store.blobs.set(`config/${SLUG}/acl.json`, {
            bytes: Buffer.from(JSON.stringify([{ email: 'gran@example.com', role: 'reader' }])),
            etag: 'e1'
        });
        const result = await gate({
            store,
            request: request({ auth: header('gran@example.com') })
        });
        assert.equal(result.denied.status, 404);
    });

    test('an unrecognized role is not silently a reader', async () => {
        const store = seeded({ members: [{ email: 'gran@example.com', role: 'raeder' }] });
        const result = await gate({
            store,
            request: request({ auth: header('gran@example.com') })
        });
        assert.equal(result.denied.status, 404);
    });

    test('a member is matched case-insensitively', async () => {
        const store = seeded({ members: [{ email: 'Gran@Example.com', role: 'reader' }] });
        const result = await gate({
            store,
            request: request({ auth: header('gran@example.com') })
        });
        assert.equal(result.role, 'reader');
        assert.equal(result.slug, SLUG);
    });

    test('an archive with no letters yet is empty, not forbidden', async () => {
        // A site claimed a minute ago has an ACL and no posts.json, and the
        // person looking at it is the person who just claimed it. Refusing
        // them told a family the archive they had been granted was not theirs.
        const store = seeded({ members: [{ email: 'gran@example.com', role: 'owner' }] });
        store.blobs.delete(`rendered/${SLUG}/posts.json`);
        const result = await gate({
            store,
            request: request({ auth: header('gran@example.com') })
        });
        assert.equal(result.denied, undefined);
        assert.equal(result.role, 'owner');
        assert.deepEqual(result.posts, []);
    });

    test('an empty archive is still closed to a stranger', async () => {
        // The concession above is to entitlement, not to existence.
        const store = seeded();
        store.blobs.delete(`rendered/${SLUG}/posts.json`);
        const result = await gate({
            store,
            request: request({ auth: header('stranger@example.com') })
        });
        assert.equal(result.denied.status, 404);
    });
});

describe('what a reader receives', () => {
    const shown = () => presentPosts(POSTS, 'reader');

    test('held letters do not leave the Function at all', () => {
        assert.deepEqual(
            shown().map((p) => p.id),
            ['2025-11-10-ZHCM']
        );
    });

    test('internal fields are absent, not merely unrendered', () => {
        const post = shown()[0];
        for (const field of [
            'sourceRawPath',
            'bodyHead100',
            'originalMessageId',
            'originalFrom',
            'forwardedBy',
            'editedBy',
            'editedAt',
            'hidden',
            'heldReason'
        ]) {
            assert.equal(post[field], undefined, `${field} reached a reader`);
        }
    });

    test('the letter itself is intact', () => {
        const post = shown()[0];
        assert.equal(post.subject, 'Week one');
        assert.equal(post.bodyHtml, '<p>hello</p>');
        assert.deepEqual(post.linkedPhotoServices, ['googlePhotos']);
        assert.equal(post.photos.length, 1);
    });
});

describe('what an owner receives', () => {
    const shown = () => presentPosts(POSTS, 'owner');

    test('held letters are included, with the reason', () => {
        assert.equal(shown().length, 2);
        const held = shown().find((p) => p.id === '2025-12-01-FRSN');
        assert.equal(held.hidden, true);
        assert.equal(held.heldReason, 'unverified-original');
    });

    test('newest first', () => {
        assert.deepEqual(
            shown().map((p) => p.id),
            ['2025-12-01-FRSN', '2025-11-10-ZHCM']
        );
    });

    test('even an owner is not sent the raw blob path', () => {
        assert.equal(shown()[0].sourceRawPath, undefined);
    });
});

// Ordering is by the local wall clock the sender wrote, never by the instant
// it refers to. Untested until now, and correct only by accident before that:
// the offset happened to sort after a fixed-width stamp.
describe('the order letters are listed in', () => {
    const ids = (posts) => presentPosts(posts, 'reader').map((p) => p.id);

    test('a later written date wins even when its instant is earlier', () => {
        // The transfer case. Manila's morning of the 2nd happens two hours
        // *before* Utah's evening of the 1st, so comparing instants would
        // list the letter headed August 2 underneath the one headed
        // August 1, directly contradicting the dates printed beside them.
        const posts = [
            { id: '2026-08-01-UTAH', originalDate: '2026-08-01T20:00:00-07:00' },
            { id: '2026-08-02-MNLA', originalDate: '2026-08-02T09:00:00+08:00' }
        ];
        assert.deepEqual(ids(posts), ['2026-08-02-MNLA', '2026-08-01-UTAH']);
    });

    test('offset-free dates interleave with offset ones by what they say', () => {
        // Every inline forward lands here: the client rendered the quoted
        // header with no zone, so there is no instant to compare without
        // inventing one.
        const posts = [
            { id: '2026-08-01-EVEN', originalDate: '2026-08-01T19:45:18-07:00' },
            { id: '2026-08-03-NONE', originalDate: '2026-08-03T08:15:00' },
            { id: '2026-08-02-MORN', originalDate: '2026-08-02T09:00:00+08:00' }
        ];
        assert.deepEqual(ids(posts), ['2026-08-03-NONE', '2026-08-02-MORN', '2026-08-01-EVEN']);
    });

    test('letters sharing a timestamp keep one fixed order', () => {
        // A client that renders no seconds puts a whole evening at :00.
        // Without a tiebreak these come back in whatever order the engine's
        // sort left them, which need not match between two requests.
        const posts = [
            { id: '2026-08-01-BBBB', originalDate: '2026-08-01T20:00:00' },
            { id: '2026-08-01-AAAA', originalDate: '2026-08-01T20:00:00' },
            { id: '2026-08-01-CCCC', originalDate: '2026-08-01T20:00:00' }
        ];
        const once = ids(posts);
        assert.deepEqual(once, ['2026-08-01-CCCC', '2026-08-01-BBBB', '2026-08-01-AAAA']);
        assert.deepEqual(ids([...posts].reverse()), once, 'input order changed the output');
    });

    test('an undated letter sorts last rather than vanishing', () => {
        const posts = [
            { id: '2026-08-01-DATE', originalDate: '2026-08-01T20:00:00' },
            { id: '0000-00-00-NULL', originalDate: null }
        ];
        assert.deepEqual(ids(posts), ['2026-08-01-DATE', '0000-00-00-NULL']);
    });
});

describe('photo visibility', () => {
    test('a photo of a published letter is served', () => {
        assert.equal(photoIsVisible(POSTS, 'p_0eade5b54243', 'reader'), true);
    });

    test('a photo of a held letter is not fetchable by URL', () => {
        assert.equal(photoIsVisible(POSTS, 'p_2b341147a59e', 'reader'), false);
        assert.equal(photoIsVisible(POSTS, 'p_2b341147a59e', 'owner'), true);
    });

    test('a photo belonging to no post of this site is refused', () => {
        // Otherwise any member of any site could read any photo of any other,
        // since the blob path is built from caller-supplied segments.
        assert.equal(photoIsVisible(POSTS, 'p_ffffffffffff', 'owner'), false);
    });
});
