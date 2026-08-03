// Ingest pipeline tests.
//
// The pipeline is driven against an in-memory store so the concurrency retry,
// the dedupe gate and the path construction can all be exercised with real
// fixture mail and no cloud.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIngest, MAX_RAW_BYTES } from '../src/lib/ingest.js';
import { safeName, msgIdSegment, validSlug } from '../src/lib/paths.js';
import { normalizeSubject, bodyHead100, findDuplicate, dedupeKey } from '../src/lib/dedupe.js';
import { dayInOwnOffset, rfc3339InOwnOffset } from '../src/lib/dates.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const raw = (name) => readFile(join(fixtures, `${name}.eml`));

const config = { authservId: 'mx.cloudflare.net', missionaryDomains: ['missionary.org'] };
const OWNER = [{ address: 'scott@kurtzeborn.org', role: 'owner' }];
const READER = [{ address: 'scott@kurtzeborn.org', role: 'reader' }];

const silent = { info() {}, warn() {}, error() {} };

function memoryStore() {
    const blobs = new Map();
    const queues = new Map();
    let seq = 0;

    return {
        blobs,
        queues,
        conflictOnce: null,
        async readBlob(container, name) {
            const found = blobs.get(`${container}/${name}`);
            return found ? { ...found } : null;
        },
        async writeBlob(container, name, bytes, options = {}) {
            const key = `${container}/${name}`;

            // Lets a test simulate another writer winning the race exactly
            // once, without any real concurrency.
            if (this.conflictOnce === key) {
                this.conflictOnce = null;
                const err = new Error('condition not met');
                err.statusCode = 412;
                throw err;
            }

            const current = blobs.get(key);
            if (options.ifNoneMatch === '*' && current) {
                const err = new Error('already exists');
                err.statusCode = 409;
                throw err;
            }
            if (options.ifMatch && current?.etag !== options.ifMatch) {
                const err = new Error('condition not met');
                err.statusCode = 412;
                throw err;
            }

            const etag = `etag-${++seq}`;
            blobs.set(key, {
                bytes: Buffer.from(bytes),
                metadata: options.metadata ?? {},
                contentType: options.contentType ?? null,
                etag
            });
            return { etag };
        },
        async enqueue(queue, text) {
            if (!queues.has(queue)) queues.set(queue, []);
            queues.get(queue).push(text);
        },
        json(container, name) {
            const blob = blobs.get(`${container}/${name}`);
            return blob ? JSON.parse(blob.bytes.toString('utf8')) : null;
        },
        seed(ulid, bytes, envelope = {}) {
            blobs.set(`inbox/${ulid}.raw`, {
                bytes: Buffer.from(bytes),
                metadata: {
                    envelopeto: encodeURIComponent(envelope.to ?? 'post@pdayletters.com'),
                    envelopefrom: encodeURIComponent(envelope.from ?? 'sender@example.com')
                },
                etag: `etag-${++seq}`
            });
        },
        acl(slug, members) {
            blobs.set(`config/${slug}/acl.json`, {
                bytes: Buffer.from(JSON.stringify(members), 'utf8'),
                metadata: {},
                etag: `etag-${++seq}`
            });
        }
    };
}

async function ingestFixture(store, name, ulid = '01TEST0000000000000000000') {
    store.seed(ulid, await raw(name));
    return runIngest({ ulid, store, config, log: silent, now: () => new Date('2026-08-03T12:00:00Z') });
}

// --- normalization ---------------------------------------------------------

test('subject normalization strips stacked reply and tag prefixes', () => {
    assert.equal(normalizeSubject('Re: [EXTERNAL] Fwd:  Week   34'), 'week 34');
    assert.equal(normalizeSubject('FW: Re: Fwd: P-day'), 'p-day');
    assert.equal(normalizeSubject(''), '');
    assert.equal(normalizeSubject(null), '');
});

test('body head drops quoted lines and signature blocks', () => {
    const body = ['Hello from Brazil!', '> you wrote this', '-- ', 'Elder Example'].join('\n');
    assert.equal(bodyHead100(body), 'hello from brazil!');

    const mobile = 'Short note\n\nSent from my iPhone';
    assert.equal(bodyHead100(mobile), 'short note');
});

test('the calendar day is read in the offset the header carries, not UTC', () => {
    // 22:30 on the 6th at -04:00 is already the 7th in UTC. The letter is
    // from the 6th.
    assert.equal(dayInOwnOffset('Mon, 6 Jul 2020 22:30:00 -0400'), '2020-07-06');
    assert.equal(rfc3339InOwnOffset('Mon, 6 Jul 2020 22:30:00 -0400'), '2020-07-06T22:30:00-04:00');
});

test('a client-rendered date with no offset becomes floating local time', () => {
    assert.equal(dayInOwnOffset('Sat, Aug 1, 2026 at 8:20 PM'), '2026-08-01');
    assert.equal(rfc3339InOwnOffset('Sat, Aug 1, 2026 at 8:20 PM'), '2026-08-01T20:20:00');
});

// --- path safety -----------------------------------------------------------

test('attachment names cannot escape their prefix', () => {
    assert.equal(
        safeName('../../rendered/elder.example/posts.json'),
        '-.-rendered-elder.example-posts.json'
    );
    assert.ok(!safeName('../../evil.json').includes('/'));
    assert.ok(!safeName('....//evil.json').includes('..'));
    assert.equal(safeName('.hidden'), 'hidden');
    assert.equal(safeName(''), 'unnamed');
    assert.equal(safeName(null), 'unnamed');
});

test('a long attachment name keeps its extension', () => {
    const name = safeName(`${'a'.repeat(300)}.jpg`);
    assert.ok(name.length <= 100);
    assert.ok(name.endsWith('.jpg'));
});

test('message ids are hashed, never sanitized into each other', () => {
    // Sanitizing these two would collapse them onto one directory and silently
    // merge two different letters.
    const a = msgIdSegment('<a/b@example.com>', 'U1');
    const b = msgIdSegment('<a..b@example.com>', 'U1');
    assert.notEqual(a, b);
    assert.match(a, /^m_[0-9a-f]{16}$/);
    assert.equal(msgIdSegment(null, 'U1'), 'u_U1');
});

test('slugs that could reach outside their container are refused', () => {
    assert.equal(validSlug('elder.example'), 'elder.example');
    assert.equal(validSlug('Elder.Example'), 'elder.example');
    assert.equal(validSlug('../config'), null);
    assert.equal(validSlug('a/b'), null);
    assert.equal(validSlug(''), null);
});

// --- pipeline --------------------------------------------------------------

test('a direct message becomes a post, an archive and a render job', async () => {
    const store = memoryStore();
    const result = await ingestFixture(store, 'direct-missionary');

    assert.equal(result.status, 'stored');
    assert.equal(result.slug, 'elder.example');

    const posts = store.json('rendered', 'elder.example/posts.json');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].extractionSource, null);
    assert.equal(posts[0].hidden, false);
    assert.ok(posts[0].originalDate, 'the post should carry the original date');
    assert.equal(posts[0].sourceRawPath, `raw/elder.example/${result.msgId}/message.eml`);

    assert.ok(store.blobs.has(`raw/elder.example/${result.msgId}/message.eml`));
    const metadata = store.json('raw', `elder.example/${result.msgId}/metadata.json`);
    assert.equal(metadata.envelope.to, 'post@pdayletters.com');
    assert.ok(metadata.headers.some((h) => h.key === 'authentication-results'));

    assert.deepEqual(store.queues.get('render'), [
        JSON.stringify({ slug: 'elder.example', msgId: result.msgId, postId: posts[0].id })
    ]);
});

test('the post body survives extraction', async () => {
    const store = memoryStore();
    const result = await ingestFixture(store, 'direct-missionary');
    const post = store.json('rendered', 'elder.example/posts.json')[0];
    assert.ok(post.bodyHtml || post.bodyText, 'a post with no body is not a letter');
    assert.ok(post.bodyHead100.length > 0);
    assert.equal(result.post.bodyHead100, post.bodyHead100);
});

test('the same message ingested twice yields one post', async () => {
    const store = memoryStore();
    const first = await ingestFixture(store, 'direct-missionary', '01FIRST000000000000000000');
    const second = await ingestFixture(store, 'direct-missionary', '01SECOND00000000000000000');

    assert.equal(first.status, 'stored');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.reason, 'message-id');
    assert.equal(store.json('rendered', 'elder.example/posts.json').length, 1);
});

test('an attached forward from an ACL member is archived with its attachments', async () => {
    const store = memoryStore();
    store.acl('elder.example', READER);
    const result = await ingestFixture(store, 'outlook-web-attached');

    assert.equal(result.status, 'stored');
    assert.equal(result.verdict.class, 'forward');
    assert.equal(result.post.forwardedBy, 'scott@kurtzeborn.org');

    const metadata = store.json('raw', `elder.example/${result.msgId}/metadata.json`);
    for (const attachment of metadata.attachments) {
        assert.ok(!attachment.path.includes('..'));
        assert.match(attachment.path, /^attachments\/\d{2}-/);
        assert.ok(store.blobs.has(`raw/elder.example/${result.msgId}/${attachment.path}`));
    }
});

test('an unverified forward is stored hidden rather than dropped', async () => {
    const store = memoryStore();
    store.acl('elder.example', READER);
    const result = await ingestFixture(store, 'outlook-web-attached');

    // DKIM re-verification is not wired in yet, so every forward from a
    // non-owner is held. The letter is kept either way.
    assert.equal(result.post.hidden, true);
    assert.equal(result.post.heldReason, 'unverified-original');
});

test('a forward from someone not on the ACL is rejected and nothing is written', async () => {
    const store = memoryStore();
    store.acl('elder.example', [{ address: 'stranger@example.com', role: 'owner' }]);
    const result = await ingestFixture(store, 'outlook-web-attached');

    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'forwarder-not-on-acl');
    assert.equal(store.json('rendered', 'elder.example/posts.json'), null);
    assert.equal(store.queues.get('render'), undefined);
});

test('an inline forward from an owner is stored, from a reader is refused', async () => {
    const asOwner = memoryStore();
    asOwner.acl('elder.example', OWNER);
    assert.equal((await ingestFixture(asOwner, 'outlook-web-inline')).status, 'stored');

    const asReader = memoryStore();
    asReader.acl('elder.example', READER);
    const refused = await ingestFixture(asReader, 'outlook-web-inline');
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.reason, 'inline-requires-owner');
});

test('a lost write race is retried, not lost', async () => {
    const store = memoryStore();
    store.conflictOnce = 'rendered/elder.example/posts.json';
    const result = await ingestFixture(store, 'direct-missionary');

    assert.equal(result.status, 'stored');
    assert.equal(store.json('rendered', 'elder.example/posts.json').length, 1);
});

test('a queue message whose blob has expired is not a failure', async () => {
    const store = memoryStore();
    const result = await runIngest({ ulid: '01GONE', store, config, log: silent });
    assert.equal(result.status, 'missing');
});

test('an oversized message is refused before the parser sees it', async () => {
    const store = memoryStore();
    store.seed('01BIG', Buffer.alloc(MAX_RAW_BYTES + 1));
    const result = await runIngest({ ulid: '01BIG', store, config, log: silent });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'oversize');
});

// --- dedupe gate -----------------------------------------------------------

test('an empty normalized field never matches another empty one', () => {
    // Two unrelated photo-only forwards from one relative on one day. Gmail
    // composes an attached forward with an empty subject unless the forwarder
    // types one, so both normalize to empty strings.
    const key = dedupeKey({
        messageId: null,
        from: 'elder.example@missionary.org',
        dateHeader: 'Sat, 1 Aug 2026 20:20:00 -0700',
        subject: '',
        text: ''
    });
    const existing = [{
        id: 'other',
        originalMessageId: null,
        originalFrom: 'elder.example@missionary.org',
        originalDate: '2026-08-01T20:20:00-07:00',
        subject: '',
        bodyHead100: ''
    }];
    assert.equal(findDuplicate(key, existing), null);
});

test('the text gate needs author, day, subject and body to all agree', () => {
    const base = {
        messageId: null,
        from: 'elder.example@missionary.org',
        dateHeader: 'Sat, 1 Aug 2026 20:20:00 -0700',
        subject: 'Week 34',
        text: 'We fixed a bike chain today.'
    };
    const existing = [{
        id: 'p1',
        originalMessageId: null,
        originalFrom: 'Elder.Example@missionary.org',
        originalDate: '2026-08-01T20:20:59-07:00',
        subject: 'Fwd: Week 34',
        bodyHead100: bodyHead100(base.text)
    }];

    assert.equal(findDuplicate(dedupeKey(base), existing).reason, 'text-match');

    // A different day is a different letter, even with everything else equal.
    const nextDay = { ...base, dateHeader: 'Sun, 2 Aug 2026 20:20:00 -0700' };
    assert.equal(findDuplicate(dedupeKey(nextDay), existing), null);

    const otherBody = { ...base, text: 'We taught a lesson today.' };
    assert.equal(findDuplicate(dedupeKey(otherBody), existing), null);
});
