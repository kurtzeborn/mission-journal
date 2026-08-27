// The five steps of a Google Photos import, from this side of the seam.
//
// Google is stubbed throughout. What is being tested is not that the REST
// calls work -- there is nothing to learn from a fake that answers what it was
// told to -- but that the flow refuses everything it should: an owner who is
// not one, a cookie from somebody else's import, an address the browser tried
// to choose, and a video picked in good faith.
//
// The gate is the real gate and the store is the real memory store, so a
// change to what "owner" means fails here as loudly as it fails everywhere.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
    finishGoogle,
    importGoogle,
    pollGoogle,
    returnGoogle,
    startGoogle
} from '../src/functions/googlephotos.js';
import { seal, unseal } from '../src/lib/googlephotos.js';
import { memoryStore } from './memory-store.js';
import { ROLE } from '../src/lib/acl.js';

const SLUG = 'elder.example';
const POST = '2026-03-25-9CRE';
const MUM = 'mum@example.com';
const GRAN = 'gran@example.com';
const KEY = 'a-signing-key-for-tests';

const silent = { log() {}, info() {}, warn() {}, error() {} };

const header = (email) =>
    Buffer.from(JSON.stringify({ userDetails: email, identityProvider: 'aad' })).toString('base64');

const picture = () =>
    sharp({ create: { width: 900, height: 600, channels: 3, background: '#336699' } })
        .jpeg()
        .toBuffer();

function request({ as = MUM, query = {}, cookie = '', params = {}, body = {} } = {}) {
    const headers = {
        'x-ms-client-principal': as ? header(as) : null,
        cookie
    };

    return {
        method: 'GET',
        url: `https://pdayletters.com/api/photos/google/x`,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        query: new URLSearchParams(query),
        params,
        json: async () => body
    };
}

async function seeded(photos = []) {
    const store = memoryStore();
    store.acl(SLUG, [
        { email: MUM, role: ROLE.owner },
        { email: GRAN, role: ROLE.reader }
    ]);
    await store.writeBlob(
        'rendered',
        `${SLUG}/posts.json`,
        Buffer.from(
            JSON.stringify([{ id: POST, subject: 'Antigua at last', bodyHtml: '<p>Hola</p>', photos }]),
            'utf8'
        )
    );
    return store;
}

// Google, as far as these tests are concerned. Each entry is one URL fragment
// and the answer it produces; anything unmatched fails the test rather than
// falling through to a default, so a step that calls something unexpected is
// caught rather than quietly stubbed.
function stubGoogle(routes) {
    const calls = [];

    return async (url, init = {}) => {
        const address = String(url);
        calls.push({ url: address, method: init.method ?? 'GET' });

        for (const [fragment, answer] of Object.entries(routes)) {
            if (!address.includes(fragment)) continue;

            const value = typeof answer === 'function' ? answer(address, init) : answer;
            return {
                ok: value.status === undefined || value.status < 300,
                status: value.status ?? 200,
                headers: { get: (name) => value.headers?.[name.toLowerCase()] ?? null },
                json: async () => value.body,
                text: async () => JSON.stringify(value.body ?? {}),
                arrayBuffer: async () => {
                    const bytes = value.bytes ?? Buffer.alloc(0);
                    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
                }
            };
        }

        assert.fail(`nothing stubbed for ${address}`);
    };
}

async function withGoogle(routes, body) {
    const real = globalThis.fetch;
    globalThis.fetch = stubGoogle(routes);
    try {
        return await body();
    } finally {
        globalThis.fetch = real;
    }
}

// The settings the handlers read. Restored afterwards so a suite that runs
// after this one does not inherit a configured Google application.
const before = {};
test.before(() => {
    for (const name of ['CLAIM_TOKEN_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
        before[name] = process.env[name];
    }
    process.env.CLAIM_TOKEN_KEY = KEY;
    process.env.GOOGLE_CLIENT_ID = 'client-123';
    process.env.GOOGLE_CLIENT_SECRET = 'secret-456';
});

test.after(() => {
    for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

const cookieFor = (payload) => `mj_gphotos=${seal(payload, KEY, 600)}`;

const session = (over = {}) =>
    cookieFor({ slug: SLUG, postId: POST, who: MUM, sessionId: 'sess-1', token: 'tok', ...over });

describe('setting out', () => {
    test('an owner is sent to Google with the archive sealed into the state', async () => {
        const store = await seeded();
        const response = await startGoogle({
            request: request({ query: { slug: SLUG, postId: POST } }),
            context: silent,
            store
        });

        assert.equal(response.status, 302);

        const url = new URL(response.headers.Location);
        assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
        assert.match(url.searchParams.get('scope'), /photospicker/);

        // This is the only leg where a signed-in owner is provable, so the
        // state has to carry everything the open callback cannot re-establish.
        const state = unseal(url.searchParams.get('state'), KEY);
        assert.equal(state.valid, true);
        assert.equal(state.payload.slug, SLUG);
        assert.equal(state.payload.postId, POST);
        assert.equal(state.payload.who, MUM);
    });

    // Asked before the consent screen rather than only after it. Sending
    // somebody to grant access for an archive they cannot write to teaches
    // them the consent means nothing.
    test('a reader never reaches the consent screen', async () => {
        const store = await seeded();
        const response = await startGoogle({
            request: request({ as: GRAN, query: { slug: SLUG, postId: POST } }),
            context: silent,
            store
        });

        assert.equal(response.status, 403);
    });

    test('and a signed-out browser gets nothing', async () => {
        const store = await seeded();
        const response = await startGoogle({
            request: request({ as: null, query: { slug: SLUG, postId: POST } }),
            context: silent,
            store
        });

        assert.equal(response.status, 403);
    });

    test('a link with no letter on it is refused', async () => {
        const store = await seeded();
        const response = await startGoogle({
            request: request({ query: { slug: SLUG } }),
            context: silent,
            store
        });

        assert.equal(response.status, 400);
    });
});

describe('coming back', () => {
    const routes = {
        'oauth2.googleapis.com/token': { body: { access_token: 'tok', expires_in: 3599 } },
        'photospicker.googleapis.com/v1/sessions': {
            body: { id: 'sess-1', pickerUri: 'https://photos.google.com/pick/xyz' }
        }
    };

    const returning = (over = {}) =>
        withGoogle(routes, () =>
            returnGoogle({
                request: request({
                    // No principal at all, which is how this leg really
                    // arrives: a redirect from Google carries no site session.
                    as: over.as ?? null,
                    query: {
                        code: 'one-time',
                        state: seal({ slug: SLUG, postId: POST, who: MUM }, KEY, 600),
                        ...over.query
                    }
                }),
                context: silent
            })
        );

    test('the owner is handed on to the picker with the session in a cookie', async () => {
        const response = await returning();

        assert.equal(response.status, 302);
        assert.equal(response.headers.Location, 'https://photos.google.com/pick/xyz/autoclose');

        const cookie = response.headers['Set-Cookie'];
        assert.match(cookie, /^mj_gphotos=/);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /Secure/);
        assert.match(cookie, /SameSite=Lax/);
        // Never sent with an ordinary page load, and never to any route but
        // the five that make up this flow.
        assert.match(cookie, /Path=\/api\/photos\/google/);
    });

    // Signed in or not makes no difference here, which is the point: Static
    // Web Apps challenging this route strips the query string, so the code
    // never arrives and the leg has to work without a session.
    test('and gets there without being signed in to the site at all', async () => {
        const cookie = (await returning()).headers['Set-Cookie'];
        const opened = unseal(cookie.split(';')[0].replace('mj_gphotos=', ''), KEY);

        assert.equal(opened.valid, true);
        assert.equal(opened.payload.who, MUM);
        assert.equal(opened.payload.sessionId, 'sess-1');
    });

    test('a state that was not signed here is refused', async () => {
        const response = await returnGoogle({
            request: request({
                as: null,
                query: { code: 'x', state: seal({ slug: SLUG, who: MUM }, 'other-key', 600) }
            }),
            context: silent
        });

        assert.equal(response.status, 400);
        assert.equal(response.headers['Set-Cookie'], undefined);
    });

    test('and so is one that has gone stale', async () => {
        const response = await returnGoogle({
            request: request({
                as: null,
                query: { code: 'x', state: seal({ slug: SLUG, who: MUM }, KEY, -1) }
            }),
            context: silent
        });

        assert.equal(response.status, 400);
    });

    test('and pressing Cancel on Google says so rather than failing', async () => {
        const response = await returnGoogle({
            request: request({ as: null, query: { error: 'access_denied' } }),
            context: silent
        });

        assert.equal(response.status, 200);
        assert.match(response.body, /Nothing was added/);
    });
});

describe('waiting for the picking to finish', () => {
    const listed = {
        'v1/mediaItems': {
            body: {
                mediaItems: [
                    {
                        id: 'm1',
                        type: 'PHOTO',
                        mediaFile: {
                            baseUrl: 'https://lh3.googleusercontent.com/one',
                            filename: 'IMG_1.jpg',
                            mediaFileMetadata: { width: 4032, height: 3024 }
                        }
                    },
                    {
                        id: 'm2',
                        type: 'VIDEO',
                        mediaFile: { baseUrl: 'https://lh3.googleusercontent.com/two', filename: 'VID.mp4' }
                    }
                ]
            }
        }
    };

    test('says not yet, and how long to wait', async () => {
        const response = await withGoogle(
            { 'v1/sessions/': { body: { mediaItemsSet: false, pollingConfig: { pollInterval: '2s' } } } },
            () => pollGoogle({ request: request({ cookie: session() }), context: silent })
        );

        assert.equal(response.jsonBody.ready, false);
        assert.equal(response.jsonBody.pollSeconds, 2);
    });

    // Videos can be picked -- the picker offers them and there is no setting
    // that hides them -- so they are counted and left behind rather than
    // failing the import or disappearing without a word.
    test('and then lists the photographs, saying how many videos it left', async () => {
        const response = await withGoogle(
            { 'v1/sessions/': { body: { mediaItemsSet: true } }, ...listed },
            () => pollGoogle({ request: request({ cookie: session() }), context: silent })
        );

        assert.equal(response.jsonBody.ready, true);
        assert.equal(response.jsonBody.skipped, 1);
        assert.deepEqual(
            response.jsonBody.items.map((item) => item.id),
            ['m1']
        );
    });

    // The addresses are the part a browser must never be handed: they are what
    // the next step fetches, and a fetch to an address the caller chose is the
    // one shape of this feature that would be dangerous.
    test('without handing the browser any address to fetch', async () => {
        const response = await withGoogle(
            { 'v1/sessions/': { body: { mediaItemsSet: true } }, ...listed },
            () => pollGoogle({ request: request({ cookie: session() }), context: silent })
        );

        assert.equal(JSON.stringify(response.jsonBody).includes('googleusercontent'), false);
    });

    test('a browser with no session of its own is told to start again', async () => {
        const response = await pollGoogle({ request: request(), context: silent });

        assert.equal(response.status, 410);
    });

    test('and so is one holding a cookie somebody else wrote', async () => {
        const forged = `mj_gphotos=${seal({ slug: SLUG, sessionId: 's', token: 'stolen' }, 'other-key', 600)}`;
        const response = await pollGoogle({ request: request({ cookie: forged }), context: silent });

        assert.equal(response.status, 410);
    });
});

describe('importing one picture', () => {
    const picked = (bytes) => ({
        'v1/mediaItems': {
            body: {
                mediaItems: [
                    {
                        id: 'm1',
                        type: 'PHOTO',
                        mediaFile: {
                            baseUrl: 'https://lh3.googleusercontent.com/one',
                            filename: 'IMG_1.jpg',
                            mediaFileMetadata: { width: 900, height: 600 }
                        }
                    }
                ]
            }
        },
        'googleusercontent.com/one=d': { bytes }
    });

    const importing = (store, over = {}) =>
        withGoogle(picked(over.bytes), () =>
            importGoogle({
                request: request({
                    as: over.as ?? MUM,
                    cookie: over.cookie ?? session(),
                    params: { slug: SLUG, postId: POST },
                    body: { mediaItemId: over.mediaItemId ?? 'm1' }
                }),
                context: silent,
                store
            })
        );

    test('lands on the letter exactly as an upload does', async () => {
        const store = await seeded();
        const response = await importing(store, { bytes: await picture() });

        assert.equal(response.status, 200);
        assert.equal(response.jsonBody.added, true);

        const posts = JSON.parse(
            Buffer.from((await store.readBlob('rendered', `${SLUG}/posts.json`)).bytes).toString('utf8')
        );

        // `addedAt` and nothing else: no filename, no Google identifier, and
        // no trace of which owner's account it came out of. `photos` is
        // projected to every reader verbatim.
        assert.deepEqual(Object.keys(posts[0].photos[0]).sort(), ['addedAt', 'height', 'id', 'width']);
        assert.match(posts[0].photos[0].id, /^p_[0-9a-f]{12}$/);
    });

    test('a reader cannot spend an owner\'s session', async () => {
        const store = await seeded();
        const response = await importing(store, { as: GRAN, bytes: await picture() });

        assert.equal(response.status, 403);
    });

    // The cookie says which archive the consent was for and the route says
    // which one is being written to. They have to be the same archive.
    test('a session for one archive cannot be spent on another', async () => {
        const store = await seeded();
        const response = await importing(store, {
            cookie: session({ slug: 'someone.else' }),
            bytes: await picture()
        });

        assert.equal(response.status, 409);
    });

    // The check that pays for the open callback. Two owners of the same
    // archive are both allowed to write to it, so the slug test above would
    // let one of them spend the other's consent; this one will not.
    test('and one owner cannot spend another owner\'s consent', async () => {
        const store = await seeded();
        store.acl(SLUG, [
            { email: MUM, role: ROLE.owner },
            { email: GRAN, role: ROLE.owner }
        ]);

        const response = await importing(store, {
            as: GRAN,
            cookie: session({ who: MUM }),
            bytes: await picture()
        });

        assert.equal(response.status, 409);
    });

    test('naming something that was not picked gets nothing', async () => {
        const store = await seeded();
        const response = await importing(store, { mediaItemId: 'never-picked', bytes: await picture() });

        assert.equal(response.status, 404);
    });

    test('and bytes that are not a picture are refused, not stored', async () => {
        const store = await seeded();
        const response = await importing(store, { bytes: Buffer.from('this is not a jpeg') });

        assert.equal(response.status, 415);
    });
});

describe('putting the session down', () => {
    test('gives it back to Google and clears the cookie', async () => {
        const seen = [];
        const real = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            seen.push({ url: String(url), method: init.method });
            return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
        };

        let response;
        try {
            response = await finishGoogle({ request: request({ cookie: session() }), context: silent });
        } finally {
            globalThis.fetch = real;
        }

        assert.equal(seen[0].method, 'DELETE');
        assert.match(seen[0].url, /sessions\/sess-1$/);
        assert.match(response.headers['Set-Cookie'], /Max-Age=0/);
    });

    // Called on every path out, including the ones where there was never a
    // session to end. Clearing the cookie is the part the browser needs.
    test('and says so even when there was nothing to give back', async () => {
        const response = await finishGoogle({ request: request(), context: silent });

        assert.equal(response.status, 200);
        assert.match(response.headers['Set-Cookie'], /Max-Age=0/);
    });
});
