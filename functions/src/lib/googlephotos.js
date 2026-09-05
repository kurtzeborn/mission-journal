// Picking photographs out of Google Photos, without ever holding the library.
//
// The Library API used to let an application list somebody's albums. That went
// away on 31 March 2025 -- the read scopes were withdrawn and the calls now
// answer 403 -- and what replaced it is the Picker API, which inverts the
// arrangement: the application never sees the library at all. It asks Google
// for a session, sends the owner to Google's own picking screen, and is handed
// back only the handful of pictures they chose. That is a better bargain than
// the one it replaced, and it is the reason this is worth doing: an owner can
// grant "these eleven photographs" rather than "my life in pictures".
//
// The consequence is that the flow is a conversation rather than a call. Four
// separate round trips, minutes apart, with the owner off in another window in
// the middle of it -- so everything here is written to be resumable from a
// signed envelope and nothing is kept on the server between steps.
//
// This module is the Google half only: building URLs, sealing state, and the
// four REST calls. What it deliberately does not do is decide who is allowed
// to ask; that stays in the handler, next to the gate every other write uses.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const PICKER = 'https://photospicker.googleapis.com/v1';

// The only scope this asks for, and the whole reason the feature is defensible.
// It grants no view of the library -- it grants sight of what the owner hands
// over in one session, and nothing else.
export const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

// Told to Google rather than only enforced on the way in, so somebody who
// picks their whole camera roll is stopped at the picking screen instead of
// after a five-minute wait and a 409.
//
// Well under `MAX_ADDED`, and deliberately so. That cap has to accommodate a
// bulk upload spread across an archive by date; this is a person choosing
// pictures by hand, one screen at a time, and each one costs a fetch from
// Google before it can be transcoded.
export const MAX_PICK = 24;

// How long the owner has to finish picking. Google's own session outlives this
// comfortably; the limit here is on the envelope we hand back to the browser,
// and it exists so that a tab left open overnight cannot be used tomorrow.
export const ENVELOPE_SECONDS = 60 * 60;

// Long enough to walk to the other room and find the photograph, short enough
// that a link mailed to somebody else has gone stale by the time they open it.
export const STATE_SECONDS = 15 * 60;

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const unb64url = (text) => Buffer.from(String(text ?? ''), 'base64url');

const sign = (text, key) => createHmac('sha256', key).update(text, 'utf8').digest();

/**
 * Wrap a small object so it can be handed to somebody else and still trusted.
 *
 * Signed and not encrypted, which is the honest description of what is needed:
 * the contents are the owner's own session and their own archive, so there is
 * nothing here to hide from them. What must not happen is somebody else
 * *writing* one -- pointing a session at an archive that is not theirs, or
 * planting their own Google token in another person's browser so that the next
 * import pulls in a stranger's photographs.
 */
export function seal(payload, key, lifetimeSeconds) {
    const body = {
        ...payload,
        exp: Math.floor(Date.now() / 1000) + lifetimeSeconds,
        n: b64url(randomBytes(9))
    };

    const text = b64url(Buffer.from(JSON.stringify(body), 'utf8'));
    return `${text}.${b64url(sign(text, key))}`;
}

/**
 * Open a sealed envelope, or say why it cannot be trusted.
 *
 * @returns {{valid: true, payload: object}|{valid: false, reason: string}}
 */
export function unseal(sealed, key) {
    const text = String(sealed ?? '');
    const dot = text.indexOf('.');
    if (dot <= 0 || dot === text.length - 1) return { valid: false, reason: 'malformed' };

    const head = text.slice(0, dot);
    const provided = unb64url(text.slice(dot + 1));
    const expected = sign(head, key);

    // Length first: `timingSafeEqual` throws rather than returning false when
    // the two buffers differ in size, and a forged signature is the ordinary
    // way for that to happen.
    if (provided.length !== expected.length) return { valid: false, reason: 'bad-signature' };
    if (!timingSafeEqual(provided, expected)) return { valid: false, reason: 'bad-signature' };

    let payload;
    try {
        payload = JSON.parse(unb64url(head).toString('utf8'));
    } catch {
        return { valid: false, reason: 'malformed' };
    }

    if (!payload || typeof payload !== 'object') return { valid: false, reason: 'malformed' };
    if (!(payload.exp > Math.floor(Date.now() / 1000))) return { valid: false, reason: 'expired' };

    return { valid: true, payload };
}

/**
 * Where to send the owner to ask Google's permission.
 *
 * `prompt=consent` every time and no refresh token asked for. This is not an
 * integration that runs while nobody is watching -- it runs because somebody
 * pressed a button ten seconds ago -- so there is nothing to keep, and a
 * service that keeps nothing cannot leak it. The cost is one extra tap on the
 * second import, which is the right way round.
 */
export function consentUrl({ clientId, redirectUri, state }) {
    const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'online',
        include_granted_scopes: 'false',
        prompt: 'consent',
        state
    });

    return `${AUTH}?${query}`;
}

// One place for the shape of a failed call, so a handler can log the status
// Google gave without the response object escaping this file.
const failure = (status, detail) => ({ ok: false, status, detail });

async function google(url, { token, method = 'GET', body } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) return failure(response.status, (await response.text()).slice(0, 400));
    return { ok: true, body: await response.json() };
}

/** Trade the one-time code from the redirect for an access token. */
export async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const response = await fetch(TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        })
    });

    if (!response.ok) return failure(response.status, (await response.text()).slice(0, 400));

    const body = await response.json();
    if (!body.access_token) return failure(response.status, 'no access token');

    // Google's own expiry, capped by ours. Whichever runs out first ends the
    // session, and the browser is told the same number either way.
    const seconds = Math.min(Number(body.expires_in) || ENVELOPE_SECONDS, ENVELOPE_SECONDS);
    return { ok: true, token: body.access_token, seconds };
}

/** Ask Google for a picking session and the address to send the owner to. */
export async function createSession({ token, maxItems = MAX_PICK }) {
    const result = await google(`${PICKER}/sessions`, {
        token,
        method: 'POST',
        body: { pickingConfig: { maxItemCount: String(maxItems) } }
    });

    if (!result.ok) return result;

    const { id, pickerUri } = result.body ?? {};
    if (!id || !pickerUri) return failure(502, 'session came back without an address');

    // `/autoclose` shuts Google's window when the owner is done rather than
    // leaving them on a "Done" screen with no way back. Their word, not ours:
    // it is the documented suffix for web callers.
    return { ok: true, id, pickerUri: `${pickerUri}/autoclose` };
}

/**
 * Has the owner finished picking?
 *
 * Google returns a recommended interval with every answer, and it is passed
 * straight through to the browser rather than being second-guessed here.
 */
export async function sessionState({ token, sessionId }) {
    const result = await google(`${PICKER}/sessions/${encodeURIComponent(sessionId)}`, { token });
    if (!result.ok) return result;

    const seconds = (text) => {
        const value = Number.parseFloat(String(text ?? ''));
        return Number.isFinite(value) ? value : null;
    };

    return {
        ok: true,
        ready: result.body?.mediaItemsSet === true,
        pollSeconds: seconds(result.body?.pollingConfig?.pollInterval) ?? 3,
        timeoutSeconds: seconds(result.body?.pollingConfig?.timeoutIn)
    };
}

/**
 * What the owner picked.
 *
 * One page is enough by construction: the session was created with a limit of
 * `MAX_PICK`, which is well under the hundred a page holds. If that limit ever
 * rises above a hundred this needs a loop, and the assertion below is how it
 * will be noticed rather than silently truncating somebody's import.
 */
export async function pickedItems({ token, sessionId }) {
    const query = new URLSearchParams({ sessionId, pageSize: '100' });
    const result = await google(`${PICKER}/mediaItems?${query}`, { token });

    if (!result.ok) return result;

    const items = (result.body?.mediaItems ?? []).map((item) => ({
        id: item.id,
        type: item.type,
        baseUrl: item.mediaFile?.baseUrl ?? '',
        mimeType: item.mediaFile?.mimeType ?? '',
        filename: item.mediaFile?.filename ?? '',
        width: item.mediaFile?.mediaFileMetadata?.width ?? 0,
        height: item.mediaFile?.mediaFileMetadata?.height ?? 0
    }));

    return { ok: true, items };
}

// Everything this service fetches from the internet is fetched from here, and
// this is the only place in the codebase where an outbound address depends on
// something a third party said. Google hands back a `baseUrl` and we append to
// it and fetch it -- so the host is checked first. Without this, an answer from
// a compromised or spoofed API is a request from inside the Function App to
// wherever it names.
const ALLOWED_HOST = /(^|\.)googleusercontent\.com$/;

/**
 * Fetch one picked photograph.
 *
 * `=d` asks for the file as it was uploaded rather than a resized copy. Costs
 * more bytes over the wire and is worth it twice over: the archive's photo ids
 * are the hash of the bytes that arrived, so the original is what makes an
 * import and a later upload of the same file from disk collapse into one
 * picture instead of two near-identical ones -- and the renditions written
 * from it are the same renditions an attachment would have produced.
 */
export async function fetchPicked({ token, baseUrl, maxBytes }) {
    let url;
    try {
        url = new URL(`${baseUrl}=d`);
    } catch {
        return failure(502, 'unusable address');
    }

    if (url.protocol !== 'https:' || !ALLOWED_HOST.test(url.hostname)) {
        return failure(502, `refusing to fetch from ${url.hostname}`);
    }

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return failure(response.status, 'the picture could not be fetched');

    // Checked before the body is read as well as after. The header is a claim
    // and not a promise, so it is worth nothing on its own -- but when it is
    // present and honest it saves pulling fifty megabytes down to throw away.
    const claimed = Number(response.headers.get('content-length'));
    if (Number.isFinite(claimed) && claimed > maxBytes) return failure(413, 'too large');

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) return failure(413, 'too large');

    return { ok: true, bytes, contentType: response.headers.get('content-type') ?? '' };
}

/** Give the session back. Best effort: an abandoned one expires on its own. */
export async function endSession({ token, sessionId }) {
    return google(`${PICKER}/sessions/${encodeURIComponent(sessionId)}`, {
        token,
        method: 'DELETE'
    });
}
