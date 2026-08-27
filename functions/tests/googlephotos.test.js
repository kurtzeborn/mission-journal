// The Google half of picking photographs: envelopes, URLs, and the one
// outbound address in this service that a third party gets to name.
//
// The four REST calls are not exercised here beyond their error handling --
// there is nothing to learn from asserting that a stubbed fetch returns what
// it was told to. What is worth pinning down is everything that decides
// whether an answer may be believed.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    consentUrl,
    createSession,
    fetchPicked,
    pickedItems,
    SCOPE,
    seal,
    sessionState,
    unseal
} from '../src/lib/googlephotos.js';

const KEY = 'a-signing-key-for-tests';

// Replaces global fetch for one call and puts it back afterwards, so a failing
// assertion cannot leave the rest of the suite talking to the internet.
async function withFetch(fake, body) {
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try {
        return await body();
    } finally {
        globalThis.fetch = real;
    }
}

const answers = (value, { status = 200, headers = {} } = {}) =>
    async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => value,
        text: async () => JSON.stringify(value),
        arrayBuffer: async () => Buffer.from(value).buffer,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null }
    });

describe('the sealed envelope', () => {
    test('comes back saying what went in', () => {
        const opened = unseal(seal({ slug: 'elder.example', postId: 'p1' }, KEY, 60), KEY);

        assert.equal(opened.valid, true);
        assert.equal(opened.payload.slug, 'elder.example');
        assert.equal(opened.payload.postId, 'p1');
    });

    test('is refused when it was signed with a different key', () => {
        const opened = unseal(seal({ slug: 'elder.example' }, KEY, 60), 'some-other-key');

        assert.deepEqual(opened, { valid: false, reason: 'bad-signature' });
    });

    test('is refused when the payload was edited under the signature', () => {
        // The attack this exists to stop: pointing a session that was consented
        // to for one archive at somebody else's.
        const sealed = seal({ slug: 'elder.example' }, KEY, 60);
        const [head, signature] = sealed.split('.');
        const payload = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
        payload.slug = 'someone.else';

        const forged = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signature}`;

        assert.equal(unseal(forged, KEY).valid, false);
    });

    test('is refused once it has run out', () => {
        assert.deepEqual(unseal(seal({}, KEY, -1), KEY), { valid: false, reason: 'expired' });
    });

    test('and nonsense is refused rather than thrown at', () => {
        for (const junk of ['', '.', 'no-dot-here', 'a.b', null, undefined]) {
            assert.equal(unseal(junk, KEY).valid, false);
        }
    });

    test('two envelopes over the same facts are different', () => {
        // A nonce, so the cookie from one import is not a valid cookie for the
        // next one and cannot be replayed out of a proxy log.
        const facts = { slug: 'elder.example', postId: 'p1' };

        assert.notEqual(seal(facts, KEY, 60), seal(facts, KEY, 60));
    });
});

describe('the consent URL', () => {
    const url = new URL(
        consentUrl({
            clientId: 'client-123',
            redirectUri: 'https://pdayletters.com/api/photos/google/return',
            state: 'sealed'
        })
    );

    test('asks for the picker scope and nothing else', () => {
        assert.equal(url.searchParams.get('scope'), SCOPE);
        assert.match(SCOPE, /photospicker\.mediaitems\.readonly$/);
    });

    test('asks for no refresh token, so there is nothing to keep', () => {
        assert.equal(url.searchParams.get('access_type'), 'online');
        assert.equal(url.searchParams.has('refresh_token'), false);
    });

    test('carries the state that says which letter this was for', () => {
        assert.equal(url.searchParams.get('state'), 'sealed');
        assert.equal(url.searchParams.get('response_type'), 'code');
    });
});

describe('opening a session', () => {
    test('hands back the picker address with autoclose on it', async () => {
        const result = await withFetch(
            answers({ id: 'sess-1', pickerUri: 'https://photos.google.com/pick/xyz' }),
            () => createSession({ token: 't' })
        );

        assert.equal(result.ok, true);
        assert.equal(result.id, 'sess-1');
        assert.equal(result.pickerUri, 'https://photos.google.com/pick/xyz/autoclose');
    });

    test('refuses an answer with no address in it', async () => {
        const result = await withFetch(answers({ id: 'sess-1' }), () => createSession({ token: 't' }));

        assert.equal(result.ok, false);
        assert.equal(result.status, 502);
    });

    test('passes Google\'s refusal through rather than inventing one', async () => {
        const result = await withFetch(
            answers({ error: 'nope' }, { status: 403 }),
            () => createSession({ token: 't' })
        );

        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
    });
});

describe('asking whether the owner has finished', () => {
    test('follows the interval Google recommends', async () => {
        const result = await withFetch(
            answers({ mediaItemsSet: false, pollingConfig: { pollInterval: '4.5s', timeoutIn: '300s' } }),
            () => sessionState({ token: 't', sessionId: 's' })
        );

        assert.equal(result.ready, false);
        assert.equal(result.pollSeconds, 4.5);
        assert.equal(result.timeoutSeconds, 300);
    });

    test('and falls back to its own when none is offered', async () => {
        const result = await withFetch(
            answers({ mediaItemsSet: true }),
            () => sessionState({ token: 't', sessionId: 's' })
        );

        assert.equal(result.ready, true);
        assert.equal(result.pollSeconds, 3);
    });
});

describe('what came back', () => {
    test('is flattened to the fields the rest of this needs', async () => {
        const result = await withFetch(
            answers({
                mediaItems: [
                    {
                        id: 'm1',
                        type: 'PHOTO',
                        mediaFile: {
                            baseUrl: 'https://lh3.googleusercontent.com/abc',
                            mimeType: 'image/jpeg',
                            filename: 'IMG_0001.jpg',
                            mediaFileMetadata: { width: 4032, height: 3024 }
                        }
                    }
                ]
            }),
            () => pickedItems({ token: 't', sessionId: 's' })
        );

        assert.deepEqual(result.items, [
            {
                id: 'm1',
                type: 'PHOTO',
                baseUrl: 'https://lh3.googleusercontent.com/abc',
                mimeType: 'image/jpeg',
                filename: 'IMG_0001.jpg',
                width: 4032,
                height: 3024
            }
        ]);
    });

    test('survives a media item with nothing on it', async () => {
        const result = await withFetch(
            answers({ mediaItems: [{ id: 'm1' }] }),
            () => pickedItems({ token: 't', sessionId: 's' })
        );

        assert.equal(result.items[0].baseUrl, '');
        assert.equal(result.items[0].width, 0);
    });
});

describe('fetching one picture', () => {
    const seen = [];
    const recording = (bytes, headers = {}) => async (url, init) => {
        seen.push({ url: String(url), init });
        return {
            ok: true,
            status: 200,
            headers: { get: (name) => headers[name.toLowerCase()] ?? null },
            arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
        };
    };

    test('asks for the original and carries the token', async () => {
        seen.length = 0;
        const result = await withFetch(recording(Buffer.from('jpeg')), () =>
            fetchPicked({
                token: 'tok',
                baseUrl: 'https://lh3.googleusercontent.com/abc',
                maxBytes: 1000
            })
        );

        assert.equal(result.ok, true);
        assert.equal(seen[0].url, 'https://lh3.googleusercontent.com/abc=d');
        assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');
    });

    // The one place in this service where an outbound address comes from
    // somewhere other than a constant. If Google's answer is ever tampered
    // with, this is what stops the Function App making the request.
    test('refuses an address that is not Google\'s', async () => {
        for (const bad of [
            'https://evil.example.com/steal',
            'http://lh3.googleusercontent.com/abc',
            'https://googleusercontent.com.evil.example/abc',
            'https://169.254.169.254/metadata',
            'not-a-url'
        ]) {
            const result = await withFetch(
                () => assert.fail(`fetched ${bad}`),
                () => fetchPicked({ token: 't', baseUrl: bad, maxBytes: 1000 })
            );

            assert.equal(result.ok, false, bad);
            assert.equal(result.status, 502, bad);
        }
    });

    test('accepts a regional Google host', async () => {
        seen.length = 0;
        const result = await withFetch(recording(Buffer.from('jpeg')), () =>
            fetchPicked({
                token: 't',
                baseUrl: 'https://lh5.eu.googleusercontent.com/abc',
                maxBytes: 1000
            })
        );

        assert.equal(result.ok, true);
    });

    test('stops on a declared length before pulling the body down', async () => {
        const result = await withFetch(
            recording(Buffer.alloc(4), { 'content-length': '99999' }),
            () => fetchPicked({ token: 't', baseUrl: 'https://lh3.googleusercontent.com/a', maxBytes: 10 })
        );

        assert.equal(result.status, 413);
    });

    test('and again after it, because the header was only a claim', async () => {
        const result = await withFetch(
            recording(Buffer.alloc(50)),
            () => fetchPicked({ token: 't', baseUrl: 'https://lh3.googleusercontent.com/a', maxBytes: 10 })
        );

        assert.equal(result.status, 413);
    });
});
