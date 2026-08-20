// The gate every content endpoint passes through.
//
// Both endpoints need the same four things in the same order -- identity,
// a safe slug, a role, and the site's posts -- and any endpoint that got the
// order wrong would leak the existence of a site to someone with no claim on
// it. Doing it once means there is one place to audit.

import { createHash } from 'node:crypto';
import { validSlug } from './paths.js';
import { readPrincipal } from './principal.js';
import { resolveAccess, ROLE } from './acl.js';
import { isOperator } from './operators.js';

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

// The answer shape ten endpoints were each declaring for themselves, in two
// spellings that differed only in whitespace. Worth having once because it is
// a *policy* rather than a convenience: everything these routes return is
// either about one person or about one family's archive, and none of it may
// sit in a cache. A handler that forgets `no-store` inherits the hardening
// block's `max-age=3600` instead, which is exactly the wrong default here.
//
// `private` is redundant alongside `no-store` and is left off deliberately:
// two of the old copies had it and eight did not, and picking the shorter
// correct one is better than preserving a distinction that never meant
// anything.
export const jsonResponse = (status, body) => ({
    status,
    headers: hardened({
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8'
    }),
    jsonBody: body
});

/**
 * A request body, or an empty object.
 *
 * Malformed JSON is treated as an absent field rather than as an error of its
 * own, because every caller here goes on to validate the fields it wanted and
 * will refuse just as loudly for a missing one. Two ways to say "that request
 * made no sense" is one more than these routes need.
 */
export async function readBody(request) {
    try {
        return (await request.json()) ?? {};
    } catch {
        return {};
    }
}

/**
 * The validator for a `posts.json` response.
 *
 * Weak, and salted, because the bytes on the wire are a projection of the blob
 * rather than the blob itself: one version of the file is a different response
 * to an owner than to a reader, and a validator that ignored that would let a
 * demoted owner keep reading hidden posts out of their own cache.
 *
 * `viaOperator` is in the salt for the same reason, even though it changes no
 * letter -- it decides whether the page says out loud that somebody is reading
 * an archive they do not belong to. Two responses that differ only in that
 * flag must not share a validator, or an operator removed from a family's ACL
 * would keep revalidating into a cached body with the warning switched off.
 *
 * `deleted` is salted for a reason the flag above does not cover, and it is
 * the sharper of the two: deleting an archive does not touch `posts.json` at
 * all, so its blob ETag is unchanged and `viaOperator` was already true for an
 * operator reading somebody else's site. Without this, an operator who had the
 * page open before the deletion would revalidate into a 304 and be handed back
 * the copy with no notice on it -- at the one moment the notice is the whole
 * point.
 *
 * `site` is the last of them, and it closes a hole that predates the mission
 * dates: the response carries the archive's name, and nothing about renaming
 * an archive touches `posts.json`. A reader who had the page cached kept the
 * old name until the next letter happened to arrive -- days, in an archive
 * that gets one letter a week. The start date behind the count-up timer has
 * exactly the same shape, and would have been worse, because it is set once,
 * deliberately, by somebody who then goes to look at it.
 *
 * Hashed rather than included, because a display name is arbitrary text the
 * owner typed and this ends up in a response header. Eight hex characters is
 * a validator, not an identifier: it only has to change when the facts do.
 */
const salt = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);

export const contentEtag = (blobEtag, role, viaOperator = false, deleted = false, site = '') =>
    `W/"${String(blobEtag ?? '').replace(/[^A-Za-z0-9]/g, '')}.${role}${viaOperator ? '.op' : ''}${deleted ? '.del' : ''}${site ? `.${salt(site)}` : ''}"`;

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

// The 401 the two gates below share. Safe to distinguish from a refusal,
// because it says only "you are not signed in", which the caller already
// knows. Static Web Apps turns it into the login redirect.
const UNAUTHENTICATED = {
    denied: { status: 401, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' }
};

// The path alone. The origin is constant and the query string is dropped
// rather than parsed: nothing behind these gates takes a token in the URL
// today, and a log line that would start carrying one the day something does
// is not a line worth writing.
const pathOf = (url) => {
    const text = String(url ?? '');
    try {
        return new URL(text).pathname;
    } catch {
        return text.split('?')[0];
    }
};

/**
 * The standing exception to private-by-default, made observable.
 *
 * Emitted from inside the gates rather than from each endpoint, because an
 * audit trail a caller has to remember to write is one an endpoint added next
 * year will not have. Every route that authorizes through here is covered by
 * construction.
 *
 * **Reads are logged, not only writes.** Reading a family's letters is the
 * privilege that matters most, and a write-only trail would miss exactly that
 * -- so the method is recorded rather than used to decide whether to record.
 *
 * `warn`, not `info`: this lands in App Insights `traces` rather than
 * `customEvents`, since nothing here takes a dependency on the SDK, and the
 * severity is the only thing that separates it from the ordinary chatter it
 * would otherwise be buried in.
 */
const auditOperator = ({ log, principal, slug, request, viaOperator }) => {
    if (!viaOperator) return;
    log?.warn?.('OperatorAction', {
        actor: principal?.email,
        slug,
        method: request?.method,
        route: pathOf(request?.url),
        at: new Date().toISOString()
    });
};

/**
 * The gate for routes that belong to nobody's archive.
 *
 * The two gates below both start from a slug and ask what this caller may do
 * with it. Operator tooling is the other shape: `/manage/deletions` is about
 * every archive at once, so there is no ACL to consult and the only question
 * is whether the caller is on the operator list.
 *
 * Refuses with 404 rather than 403, matching everything else here. A signed-in
 * stranger who pokes at `/api/manage/...` should not learn that the route
 * exists, and an operator who mistypes gets the same answer they would for any
 * other bad URL.
 *
 * Every call is audited, unconditionally -- there is no non-operator path
 * through here, so `viaOperator` is passed as true rather than derived.
 *
 * @returns {{denied: object}|{principal: object}}
 */
export function operatorGate({ request, log, env = process.env }) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) return UNAUTHENTICATED;

    if (!isOperator(principal.email, env)) return { denied: DENIED };

    auditOperator({ log, principal, slug: '', request, viaOperator: true });

    return { principal };
}

/**
 * Identity, slug, and role -- without requiring that anything be rendered yet.
 *
 * `gate` below reads `rendered/{slug}/posts.json`, which is right for an
 * endpoint about to return letters and wrong for one that manages the archive
 * itself. An archive claimed a minute ago has nothing rendered, and "you
 * cannot rename your site or invite your family until the first letter
 * arrives" is a rule nobody would choose.
 *
 * @param {boolean} [ownersOnly] refuse a reader with 403 rather than 404. A
 *   reader already knows the site exists, so the honest answer discloses
 *   nothing and saves them hunting for a broken link.
 * @returns {Promise<{denied: object}|{slug: string, role: string, principal: object,
 *   viaOperator: boolean}>}
 */
export async function siteGate({ store, request, ownersOnly = false, log }) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) return UNAUTHENTICATED;

    const slug = validSlug(request.params.slug);
    if (!slug) return { denied: DENIED };

    const { role, viaOperator } = await resolveAccess({ store, slug, principal });
    if (!role) return { denied: DENIED };

    if (ownersOnly && role !== ROLE.owner) {
        return {
            denied: {
                status: 403,
                headers: hardened({
                    'Cache-Control': 'no-store',
                    'Content-Type': 'application/json; charset=utf-8'
                }),
                jsonBody: { error: 'owners only' }
            }
        };
    }

    auditOperator({ log, principal, slug, request, viaOperator });

    return { slug, role, principal, viaOperator };
}

/**
 * @returns {Promise<{denied: object}|{role: string, slug: string, posts: object[],
 *   principal: object, etag: string, viaOperator: boolean}>} the ETag is the one
 *   a write endpoint has to pass back on If-Match, so reading and writing cannot
 *   disagree about which version of posts.json was examined.
 */
export async function gate({ store, request, log }) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) return UNAUTHENTICATED;

    const slug = validSlug(request.params.slug);
    if (!slug) return { denied: DENIED };

    const { role, viaOperator } = await resolveAccess({ store, slug, principal });
    if (!role) return { denied: DENIED };

    auditOperator({ log, principal, slug, request, viaOperator });

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
    if (!blob) return { role, slug, posts: [], principal, etag: '', viaOperator };

    const posts = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
    if (!Array.isArray(posts)) return { denied: DENIED };

    return { role, slug, posts, principal, etag: blob.etag, viaOperator };
}
