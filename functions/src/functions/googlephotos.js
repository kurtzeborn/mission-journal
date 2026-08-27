// The four steps between "Add from Google Photos" and a picture on a letter.
//
// The owner leaves the site in the middle of this. That single fact shapes
// everything below: there is no request that spans the flow, so each step has
// to arrive knowing nothing and be told everything, and what it is told has to
// be worth trusting when it comes back from a browser that spent the last two
// minutes on somebody else's domain.
//
//   start    -> sign where we are and send them to Google to consent
//   return   -> trade the code for a token, open a picking session, send them
//               to Google's picker
//   session  -> the page they left behind asks "finished yet?"
//   import   -> one picked photograph, fetched here and stored like any other
//
// Two things are deliberately not done. Nothing is written to a table: the
// only state is a signed envelope in a cookie the browser carries, so an
// abandoned import leaves no row behind and there is no access token at rest
// anywhere in the service. And no refresh token is requested, so consent is
// asked for every time -- an extra tap on the second import, in exchange for a
// service that cannot be made to fetch somebody's photographs tomorrow.
//
// `return` is the one route here that the site's own sign-in does not guard,
// and it cannot be: the browser arrives on it as a redirect from Google, and
// Static Web Apps answers an unauthenticated call to `/api` by sending the
// browser to the login page and then bouncing it back with the query string
// stripped -- which discards the authorisation code the redirect existed to
// deliver. So the callback is opened, and its authority comes from the sealed
// state instead: minted at `start`, where a live owner was proven, and naming
// both the archive and the person. Nothing is written on that leg. The import
// still demands a real owner session, and now also demands that it belong to
// the same person who began the consent.

import { app } from '@azure/functions';
import { blobStore, signingKey } from '../lib/clients.js';
import { setting } from '../lib/settings.js';
import { hardened } from '../lib/api.js';
import { validSlug } from '../lib/paths.js';
import { attachPhoto, ownerOnly } from './post.js';
import { MAX_UPLOAD_BYTES } from '../lib/photos.js';
import {
    consentUrl,
    createSession,
    endSession,
    exchangeCode,
    ENVELOPE_SECONDS,
    fetchPicked,
    MAX_PICK,
    pickedItems,
    seal,
    sessionState,
    STATE_SECONDS,
    unseal
} from '../lib/googlephotos.js';

const COOKIE = 'mj_gphotos';

const problem = (status, error) => ({
    status,
    headers: hardened({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    }),
    jsonBody: { error }
});

const ok = (body, headers = {}) => ({
    status: 200,
    headers: hardened({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
    }),
    jsonBody: body
});

// The owner is in a popup when these run, so an error has to be readable where
// it lands rather than in a JSON body nobody will ever see. Plain text, no
// markup, and the window stays open so they can read it.
const said = (status, text) => ({
    status,
    headers: hardened({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
    }),
    body: text
});

const away = (url, headers = {}) => ({
    status: 302,
    headers: hardened({ Location: url, 'Cache-Control': 'no-store', ...headers })
});

const redirectUri = () => `${setting('PUBLIC_BASE_URL', 'https://pdayletters.com')}/api/photos/google/return`;

// Path-scoped so it is not attached to every other call the site makes, and
// so every route that reads it sits under one prefix -- including the import,
// which is why that one lives here rather than beside the upload it mirrors.
// `Lax` because the one cross-site arrival that has to carry it, Google's
// redirect back, is a top-level navigation, which Lax allows. `None` would buy
// nothing here and would hand the cookie to every embedded request on the web.
const setCookie = (value, seconds) =>
    `${COOKIE}=${value}; Path=/api/photos/google; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;

const clearCookie = () => setCookie('', 0);

// The gate reads the slug off the route, and two of these endpoints have it
// somewhere else. Rebuilt by hand rather than spread: an `HttpRequest` keeps
// most of itself on the prototype, so a copy made with `...` arrives at the
// gate with no headers and no identity.
const wearing = (request, slug) => ({
    headers: request.headers,
    params: { slug },
    method: request.method,
    url: request.url
});

// Written by hand because there is no cookie parser in the runtime and one
// name is being looked for. Splitting on ';' and then on the first '=' is the
// whole of the format for a cookie we set ourselves.
function readCookie(request) {
    for (const part of String(request.headers.get('cookie') ?? '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
    }
    return '';
}

/**
 * Recover the session the owner started, or say why it is gone.
 *
 * Every step after the redirect goes through here, and every one of them can
 * be reached by a browser holding a cookie that has expired, been tampered
 * with, or belongs to an import that finished ten minutes ago.
 */
function envelope(request, context) {
    const key = signingKey('googlephotos', context);
    if (!key) return { error: problem(503, 'this site cannot talk to Google Photos just now') };

    const opened = unseal(readCookie(request), key);
    if (!opened.valid) {
        return { error: problem(410, 'that Google Photos session has ended; start again') };
    }

    return { session: opened.payload };
}

// --- step one: consent ----------------------------------------------------
//
// A GET rather than a POST because it ends in a redirect the browser has to
// follow as a navigation, and because the popup is opened by the click that
// made it -- a fetch and then a `window.open` would be eaten by the popup
// blocker on the phones this is mostly used from.

export async function startGoogle({ request, context, store }) {
    const clientId = setting('GOOGLE_CLIENT_ID');
    const key = signingKey('googlephotos', context);
    if (!clientId || !key) return said(503, 'This site is not set up to talk to Google Photos.');

    const slug = validSlug(request.query.get('slug'));
    const postId = String(request.query.get('postId') ?? '');
    if (!slug || !postId) return said(400, 'That link is missing something.');

    // Asked here and not only at the end: sending somebody to a Google consent
    // screen for an archive they cannot write to wastes their time and teaches
    // them the consent is meaningless.
    const gated = await ownerOnly(wearing(request, slug), context, store);
    if (gated.denied) return said(403, 'You cannot add pictures to that archive.');

    // This is the only point in the flow where a signed-in owner is provable,
    // so who they are is sealed in and carried the rest of the way.
    const state = seal({ slug, postId, who: gated.principal.email }, key, STATE_SECONDS);

    // Any cookie still on the browser belongs to the run before this one, and
    // it stays valid for the hour. Left alone, the page would poll that dead
    // session all the way through this pick and never see the new one become
    // ready, so the run is started from nothing rather than from whatever the
    // last attempt left behind.
    return away(consentUrl({ clientId, redirectUri: redirectUri(), state }), {
        'Set-Cookie': clearCookie()
    });
}

// --- step two: the way back -----------------------------------------------

export async function returnGoogle({ request, context }) {
    const clientId = setting('GOOGLE_CLIENT_ID');
    const clientSecret = setting('GOOGLE_CLIENT_SECRET');
    const key = signingKey('googlephotos', context);
    if (!clientId || !clientSecret || !key) {
        return said(503, 'This site is not set up to talk to Google Photos.');
    }

    // The owner pressing Cancel on Google's screen arrives here exactly like a
    // failure does, and is not one.
    if (request.query.get('error')) return said(200, 'Nothing was added. You can close this window.');

    // The whole of this leg's authority. Fifteen minutes old at most, signed
    // with a key only this service holds, and naming the archive, the letter
    // and the owner that were checked before the browser ever left.
    const opened = unseal(request.query.get('state'), key);
    if (!opened.valid) return said(400, 'That link has expired. Try again from the letter.');

    const { slug, postId, who } = opened.payload;

    const code = String(request.query.get('code') ?? '');
    if (!code) return said(400, 'Google did not say which pictures you meant.');

    const token = await exchangeCode({ code, clientId, clientSecret, redirectUri: redirectUri() });
    if (!token.ok) {
        context.error('googlephotos.exchange', { status: token.status, detail: token.detail });
        return said(502, 'Google would not confirm that sign-in. Try again.');
    }

    const session = await createSession({ token: token.token });
    if (!session.ok) {
        context.error('googlephotos.session', { status: session.status, detail: session.detail });
        return said(502, 'Google Photos could not open a picker. Try again.');
    }

    const sealed = seal(
        { slug, postId, who, sessionId: session.id, token: token.token },
        key,
        Math.min(token.seconds, ENVELOPE_SECONDS)
    );

    context.log('googlephotos.started', { slug, postId, session: session.id });
    return away(session.pickerUri, { 'Set-Cookie': setCookie(sealed, token.seconds) });
}

// --- step three: are they done? -------------------------------------------

export async function pollGoogle({ request, context }) {
    const { error, session } = envelope(request, context);
    if (error) return error;

    const state = await sessionState({ token: session.token, sessionId: session.sessionId });
    if (!state.ok) {
        context.error('googlephotos.poll', { status: state.status, detail: state.detail });
        return problem(502, 'Google Photos stopped answering. Try again.');
    }

    if (!state.ready) {
        return ok({ ready: false, pollSeconds: state.pollSeconds, timeoutSeconds: state.timeoutSeconds });
    }

    const picked = await pickedItems({ token: session.token, sessionId: session.sessionId });
    if (!picked.ok) {
        context.error('googlephotos.list', { status: picked.status, detail: picked.detail });
        return problem(502, 'Google Photos stopped answering. Try again.');
    }

    // Videos are dropped here rather than refused later. The picker will offer
    // them -- there is no configuration that hides them -- so an owner can pick
    // one in good faith, and the honest answer is to say how many were left
    // behind instead of failing the whole import or silently losing them.
    const photos = picked.items.filter((item) => item.type === 'PHOTO');

    return ok({
        ready: true,
        slug: session.slug,
        postId: session.postId,
        skipped: picked.items.length - photos.length,
        // Addresses stay here. The browser gets identifiers and enough to draw
        // a list, and the next step looks the address up again from Google.
        items: photos.slice(0, MAX_PICK).map((item) => ({
            id: item.id,
            filename: item.filename,
            width: item.width,
            height: item.height
        }))
    });
}

// --- step four: one picture -----------------------------------------------
//
// One request per photograph, which is what the existing upload button does
// and for the same reasons: a running count the owner can watch, a failure
// that costs one picture rather than all of them, and no request long enough
// to worry a Function host about.

export async function importGoogle({ request, context, store }) {
    const { error, session } = envelope(request, context);
    if (error) return error;

    const gated = await ownerOnly(request, context, store);
    if (gated.denied) return gated.denied;

    const { postId } = request.params;

    // The cookie says which archive the consent was given for. The route says
    // which archive is being written to. A mismatch means a cookie from one
    // import is being spent on another, so it is refused rather than resolved.
    if (session.slug !== gated.slug) {
        return problem(409, 'that Google Photos session belongs to another archive');
    }

    // The ownership question the open callback could not ask, asked here where
    // there is a real session to ask it of: this cookie may only be spent by
    // the person whose consent minted it, not by anyone who happens to hold it
    // and own the archive.
    if (session.who !== gated.principal.email) {
        return problem(409, 'that Google Photos session belongs to somebody else');
    }

    const body = await request.json().catch(() => ({}));
    const wanted = String(body?.mediaItemId ?? '');
    if (!wanted) return problem(400, 'no picture was named');

    // Listed again rather than trusting an address from the browser. This is
    // the only outbound fetch in the service whose target is not a constant,
    // and the way it stays safe is that the address always comes from Google
    // in the same breath as the identifier that selected it.
    const picked = await pickedItems({ token: session.token, sessionId: session.sessionId });
    if (!picked.ok) {
        context.error('googlephotos.list', { status: picked.status, detail: picked.detail });
        return problem(502, 'Google Photos stopped answering. Try again.');
    }

    const item = picked.items.find((entry) => entry.id === wanted && entry.type === 'PHOTO');
    if (!item) return problem(404, 'that picture is not in this selection');

    const fetched = await fetchPicked({
        token: session.token,
        baseUrl: item.baseUrl,
        maxBytes: MAX_UPLOAD_BYTES
    });

    if (!fetched.ok) {
        if (fetched.status === 413) return problem(413, 'that picture is too large to add');
        context.error('googlephotos.fetch', { status: fetched.status, detail: fetched.detail });
        return problem(502, 'that picture could not be fetched from Google Photos');
    }

    return attachPhoto({
        store,
        context,
        slug: gated.slug,
        postId,
        posts: gated.posts,
        bytes: fetched.bytes,
        via: 'google'
    });
}

// --- and putting it down --------------------------------------------------

export async function finishGoogle({ request, context }) {
    const { error, session } = envelope(request, context);

    // Nothing to give back, and nothing to apologise for -- the cookie is
    // cleared either way, which is the only part of this the caller needs.
    if (!error) await endSession({ token: session.token, sessionId: session.sessionId });

    return ok({ done: true }, { 'Set-Cookie': clearCookie() });
}

app.http('googlePhotosStart', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'photos/google/start',
    handler: (request, context) => startGoogle({ request, context, store: blobStore() })
});

app.http('googlePhotosReturn', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'photos/google/return',
    handler: (request, context) => returnGoogle({ request, context })
});

app.http('googlePhotosPoll', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'photos/google/session',
    handler: (request, context) => pollGoogle({ request, context })
});

app.http('googlePhotosFinish', {
    authLevel: 'anonymous',
    methods: ['DELETE'],
    route: 'photos/google/session',
    handler: (request, context) => finishGoogle({ request, context })
});

app.http('googlePhotosImport', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'photos/google/import/{slug}/{postId}',
    handler: (request, context) => importGoogle({ request, context, store: blobStore() })
});
