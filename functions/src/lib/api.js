// The gate every content endpoint passes through.
//
// Both endpoints need the same four things in the same order -- identity,
// a safe slug, a role, and the site's posts -- and any endpoint that got the
// order wrong would leak the existence of a site to someone with no claim on
// it. Doing it once means there is one place to audit.

import { validSlug } from './paths.js';
import { readPrincipal } from './principal.js';
import { resolveRole } from './acl.js';

// Applied to every response that carries archive bytes. The CSP is aimed at a
// direct hit on the API URL: these responses are consumed by fetch() and by
// <img>, never navigated to as documents, so everything is denied.
const HARDENING = {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer',
    // Private, because a shared cache holding one family's letters and serving
    // them to the next requester is the exact failure this service cannot have.
    // Photos and archives are content-addressed and safe to hold for an hour;
    // `posts.json` overrides this, because it changes.
    'Cache-Control': 'private, max-age=3600'
};

export const hardened = (headers = {}) => ({ ...HARDENING, ...headers });

/**
 * The validator for a `posts.json` response.
 *
 * Weak, and salted with the role, because the bytes on the wire are a
 * projection of the blob rather than the blob itself: one version of the file
 * is a different response to an owner than to a reader, and a validator that
 * ignored that would let a demoted owner keep reading hidden posts out of
 * their own cache.
 */
export const contentEtag = (blobEtag, role) =>
    `W/"${String(blobEtag ?? '').replace(/[^A-Za-z0-9]/g, '')}.${role}"`;

// Browsers echo back exactly what was sent, but proxies have been known to drop
// the weak marker, so neither side's punctuation is trusted.
const sameEtag = (a, b) => {
    const bare = (v) =>
        String(v ?? '')
            .trim()
            .replace(/^W\//i, '')
            .replace(/"/g, '');
    return Boolean(a) && bare(a) === bare(b);
};

export const matchesEtag = sameEtag;

export const notModified = (candidate, etag) =>
    sameEtag(candidate, etag)
        ? {
              status: 304,
              headers: hardened({ ETag: etag, 'Cache-Control': 'private, no-cache' })
          }
        : null;

// Deliberately indistinguishable from each other. A caller who is signed in
// but not entitled learns nothing about whether a slug exists, which keeps
// the site list from being enumerable one guess at a time.
const DENIED = { status: 404, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' };

/**
 * @returns {Promise<{denied: object}|{role: string, slug: string, posts: object[],
 *   principal: object, etag: string}>} the ETag is the one a write endpoint has
 *   to pass back on If-Match, so reading and writing cannot disagree about
 *   which version of posts.json was examined.
 */
export async function gate({ store, request }) {
    // 401 rather than 404: this one is safe to distinguish, because it says
    // only "you are not signed in", which the caller already knows. Static Web
    // Apps turns it into the login redirect.
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) {
        return {
            denied: {
                status: 401,
                headers: hardened({ 'Cache-Control': 'no-store' }),
                body: ''
            }
        };
    }

    const slug = validSlug(request.params.slug);
    if (!slug) return { denied: DENIED };

    const role = await resolveRole({ store, slug, principal });
    if (!role) return { denied: DENIED };

    // An archive with no letters in it yet is not a refusal. Everything the
    // 404 above protects has already been decided by this point -- the caller
    // holds a role on this slug, so they know it exists -- and the only thing
    // a missing `posts.json` tells them is that the first letter has not
    // arrived. Answering DENIED here sent a family who had just been granted
    // their own archive to a page saying it was not available to them, on the
    // one visit where they had done nothing wrong.
    //
    // The empty ETag is deliberate rather than absent: it gives the empty
    // state a validator of its own, so the browser stops re-fetching nothing,
    // and it necessarily differs from any real blob's, so the first letter
    // to arrive invalidates it.
    const blob = await store.readBlob('rendered', `${slug}/posts.json`);
    if (!blob) return { role, slug, posts: [], principal, etag: '' };

    const posts = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
    if (!Array.isArray(posts)) return { denied: DENIED };

    return { role, slug, posts, principal, etag: blob.etag };
}
