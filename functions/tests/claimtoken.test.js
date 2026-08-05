// Claim token tests.
//
// The token is the entire credential for taking ownership of a family's
// letters, so the tests here are mostly about what it must *refuse*.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { issueClaimToken, verifyClaimToken, claimTokenHash } from '../src/lib/claimtoken.js';

const KEY = 'a-signing-key-from-key-vault';
const LATER = '2026-10-02T12:00:00.000Z';
const at = (iso) => () => new Date(iso);
const NOW = at('2026-08-03T12:00:00.000Z');

const fresh = (slug = 'elder.example', expiresAt = LATER) =>
    issueClaimToken({ slug, key: KEY, expiresAt });

describe('issuing a claim token', () => {
    test('carries the slug and expiry back out again', () => {
        const { token } = fresh();
        const result = verifyClaimToken({ token, key: KEY, now: NOW });

        assert.equal(result.valid, true);
        assert.equal(result.slug, 'elder.example');
        assert.equal(result.expiresAt, LATER);
    });

    test('is safe to paste into a URL', () => {
        const { token } = fresh();
        assert.equal(token, encodeURIComponent(token), 'a token must survive a path segment');
        assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });

    test('never repeats, even for the same site and expiry', () => {
        const seen = new Set();
        for (let i = 0; i < 50; i++) seen.add(fresh().token);
        assert.equal(seen.size, 50, 'two people would otherwise share a claim link');
    });

    test('hands back the hash that gets stored, not the token', () => {
        const { token, hash } = fresh();
        assert.equal(hash, claimTokenHash(token));
        assert.equal(hash.length, 64);
        assert.ok(!hash.includes(token), 'the stored value must not contain the token');
    });

    test('refuses to mint without the things that make it meaningful', () => {
        assert.throws(() => issueClaimToken({ key: KEY, expiresAt: LATER }), /slug/);
        assert.throws(() => issueClaimToken({ slug: 'a', expiresAt: LATER }), /key/);
        assert.throws(() => issueClaimToken({ slug: 'a', key: KEY }), /expiresAt/);
    });
});

describe('verifying a claim token', () => {
    test('rejects a token signed with a different key', () => {
        const { token } = fresh();
        const result = verifyClaimToken({ token, key: 'some-other-key', now: NOW });

        assert.equal(result.valid, false);
        assert.equal(result.reason, 'bad-signature');
        assert.equal(result.slug, undefined, 'a forged token must not disclose a slug');
    });

    test('rejects a token whose slug has been edited', () => {
        const { token } = fresh();
        const [, signature] = token.split('.');
        const forged = Buffer.from(
            JSON.stringify({ slug: 'someone.else', exp: LATER, n: 'x' }),
            'utf8'
        ).toString('base64url');

        const result = verifyClaimToken({ token: `${forged}.${signature}`, key: KEY, now: NOW });
        assert.equal(result.valid, false);
        assert.equal(result.reason, 'bad-signature');
    });

    test('rejects a token whose expiry has been pushed out', () => {
        const { token } = fresh('elder.example', '2026-08-04T12:00:00.000Z');
        const [payload, signature] = token.split('.');
        const stretched = Buffer.from(
            JSON.stringify({
                ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
                exp: '2099-01-01T00:00:00.000Z'
            }),
            'utf8'
        ).toString('base64url');

        const result = verifyClaimToken({ token: `${stretched}.${signature}`, key: KEY, now: NOW });
        assert.equal(result.valid, false);
        assert.equal(result.reason, 'bad-signature');
    });

    test('reports an expired token as expired, and still names the site', () => {
        const { token } = fresh('elder.example', '2026-08-01T00:00:00.000Z');
        const result = verifyClaimToken({ token, key: KEY, now: NOW });

        assert.equal(result.valid, false);
        assert.equal(result.reason, 'expired');
        // The page has to be able to offer a fresh link, which means knowing
        // which pending site to send it for.
        assert.equal(result.slug, 'elder.example');
    });

    test('treats the moment of expiry as expired', () => {
        const { token } = fresh('elder.example', '2026-08-03T12:00:00.000Z');
        assert.equal(verifyClaimToken({ token, key: KEY, now: NOW }).reason, 'expired');
    });

    test('rejects rubbish without throwing', () => {
        for (const token of ['', '.', 'nodot', 'a.', '.b', 'a.b.c', null, undefined, '../../etc']) {
            const result = verifyClaimToken({ token, key: KEY, now: NOW });
            assert.equal(result.valid, false, `${token} must not verify`);
            assert.ok(result.reason, `${token} must give a reason`);
        }
    });

    test('rejects a signature of the wrong length without throwing', () => {
        // timingSafeEqual throws on a length mismatch, so this would be an
        // unhandled exception in a request handler if it were not guarded.
        const { token } = fresh();
        const [payload] = token.split('.');
        const result = verifyClaimToken({ token: `${payload}.AAAA`, key: KEY, now: NOW });

        assert.equal(result.valid, false);
        assert.equal(result.reason, 'bad-signature');
    });

    test('gives back the hash so the caller can check it was not already spent', () => {
        const { token, hash } = fresh();
        assert.equal(verifyClaimToken({ token, key: KEY, now: NOW }).hash, hash);
    });
});
