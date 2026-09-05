import { app } from '@azure/functions';
import { blobStore, mailer, tableStore } from '../lib/clients.js';
import { jsonResponse as json, siteGate } from '../lib/api.js';
import { isPhotoType, MAX_UPLOAD_BYTES, overSizeClaim } from '../lib/photos.js';
import { readProfile } from '../lib/profile.js';
import {
    chooseCover,
    CLOTHS,
    coverFile,
    coverOf,
    saveCover,
    storeCoverPicture
} from '../lib/cover.js';
import {
    BOOKS,
    bookName,
    latestBook,
    proofName,
    readBook,
    requestBook,
    runBook,
    STATE
} from '../lib/publish.js';
import { setting } from '../lib/settings.js';

const CONFIG = 'config';

// Long enough to survive a slow phone starting on a hundred-megabyte PDF,
// short enough that a URL later found in a browser history is already dead.
const LINK_MINUTES = 15;

// What the page is allowed to know about a build. The stored status also
// carries who asked for it, and that is nobody else's business -- two owners
// share a site, and neither needs the other's address handed back by an
// endpoint the browser polls every few seconds.
const forThePage = (status) => ({
    id: status.id,
    state: status.state,
    requestedAt: status.requestedAt,
    builtAt: status.builtAt,
    pages: status.pages,
    letters: status.letters,
    missing: status.missing ?? [],
    // Whether there is any point showing an order button. Not a fact about
    // this build at all, but the page has to learn it somewhere, and the
    // alternative -- a button whose only possible answer is "printing is not
    // switched on yet" -- is a control that exists to apologize.
    printing: Boolean(setting('PEECHO_API_KEY')),
    // The message from a failed build, which is written by us and says things
    // like "there are no letters to print yet". Shown rather than swallowed:
    // a build that failed for a reason the owner can fix is the common case,
    // and "something went wrong" makes it unfixable.
    error: status.error
});

// Both read endpoints answer for the newest book when no id is given, so a
// page that has just been opened finds a build somebody else started -- or
// one this owner started on their phone -- without being told which to ask
// about.
const wanted = ({ store, slug, id }) =>
    id ? readBook({ store, slug, id }) : latestBook({ store, slug });

/**
 * Ask for a book.
 *
 * Owners only, which is a product decision rather than a security one: a
 * reader could be handed the same PDF they can already assemble from the
 * archive export. But publishing is the act that puts a permanent object into
 * the world with the family's name on it, and that belongs to whoever holds
 * the site.
 */
export async function publish({ request, context, store }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    const result = await requestBook({
        store,
        slug: gated.slug,
        principal: gated.principal,
        log: context
    });

    if (result.error === 'incomplete') {
        return json(409, {
            error: 'this site needs a name before it can be printed',
            missing: result.missing
        });
    }

    // Not a failure the page should shout about: somebody pressed the button
    // twice, or two owners pressed it at once. Hand back the build already
    // running and let the page show its progress, which is what they wanted.
    if (result.error === 'building') {
        return json(202, { id: result.id, state: STATE.building, missing: [] });
    }

    return json(202, { id: result.id, state: STATE.building, missing: result.missing });
}

/**
 * How the build is going.
 */
export async function progress({ request, context, store }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    const found = await wanted({ store, slug: gated.slug, id: request.params.id });
    if (!found) return json(404, { error: 'no book has been asked for yet' });

    return json(200, forThePage(found));
}

/**
 * One of the two renditions of a finished book.
 *
 * Redirected to storage rather than served down this connection, for the same
 * reason the archive export is: holding a response open for the length of
 * somebody's download outlasts the platform's window and cannot be resumed.
 *
 * Both are owners only and both are behind a link that dies in a quarter of
 * an hour, but for different reasons. The print file is a press-ready object
 * with nothing written across it. The proof is only a review copy, and the
 * short link is there so a URL later found in a browser history is already
 * dead rather than because the file is precious.
 */
async function handOver({ request, context, store, pick, rendition }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    const found = await wanted({ store, slug: gated.slug, id: request.params.id });
    if (found?.state !== STATE.ready) {
        return json(404, { error: 'there is no finished book to look at' });
    }

    const url = await store.readUrl(BOOKS, pick(gated.slug, found.id), {
        minutes: LINK_MINUTES
    });

    context.log?.('book.fetched', { slug: gated.slug, id: found.id, rendition });

    return {
        status: 302,
        headers: hardened({
            Location: url,
            // The link expires, so nothing may keep this response. Without it
            // a browser reuses a dead redirect and the download fails with an
            // XML error from storage that means nothing to anyone.
            'Cache-Control': 'no-store'
        })
    };
}

/**
 * The print file: full resolution, unmarked, the thing that gets bound.
 */
export const deliver = (args) => handOver({ ...args, pick: bookName, rendition: 'book' });

/**
 * The review copy: the same book, at screen resolution, marked on every page.
 *
 * This is the only rendition that is ever put in front of a browser, and the
 * distinction is the point of there being two. What the owner approves has to
 * be the book they will receive, and what they can save off the screen has to
 * be no use to anybody else's printer.
 */
export const review = (args) => handOver({ ...args, pick: proofName, rendition: 'proof' });

/**
 * What the cover looks like, and what else it could look like.
 *
 * The palette comes down the wire rather than being written into the page,
 * because the hexes are also what gets drawn into the PDF and two copies of a
 * color is one copy too many. It costs a few hundred bytes on a page that is
 * already fetching a book status.
 *
 * The name and the mission come with it so the page can show what the cover
 * will actually say. They are also the answer to whether the mission is
 * missing, which this page prompts about -- one request rather than the two
 * it used to take.
 */
export async function cover({ request, context, store }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    const { profile } = await readProfile({ store, slug: gated.slug });

    return json(200, {
        ...coverOf(profile),
        // The same fallback the book uses when nobody has named the archive.
        title: profile.displayName || gated.slug,
        mission: profile.mission ?? '',
        cloths: Object.entries(CLOTHS).map(([name, colors]) => ({ name, ...colors }))
    });
}

/**
 * Choose one.
 *
 * Saved on its own rather than sent with the request to print, so a color
 * survives being chosen and then thought better of before the button is
 * pressed -- and so the next book, a year later, is bound like the first.
 */
export async function chooseTheCover({ request, context, store }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    let body = {};
    try {
        body = await request.json();
    } catch {
        return json(400, { error: 'that was not valid JSON' });
    }

    const chosen = chooseCover({ cloth: body.cloth, picture: body.picture });
    if (chosen.error) return json(400, { error: chosen.error });

    const saved = await saveCover({ store, slug: gated.slug, cover: chosen.cover });
    if (saved.error) return json(409, { error: saved.error });

    context.log('book.coverChosen', {
        slug: gated.slug,
        cloth: chosen.cover.cloth,
        picture: chosen.cover.picture ? 'yes' : 'no'
    });

    return json(200, saved.cover);
}

/**
 * Upload a picture for the front board.
 *
 * The same allowlist and the same ceiling as a picture added to a letter,
 * checked here before a byte is decoded so that a browser sending a PDF is
 * told what it did wrong.
 */
export async function putCoverPicture({ request, context, store }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    if (!isPhotoType(request.headers.get('content-type'))) {
        return json(415, { error: 'that is not a kind of picture this site can print' });
    }

    if (overSizeClaim(request.headers)) {
        return json(413, { error: 'that picture is too large to use' });
    }

    const bytes = Buffer.from(await request.arrayBuffer());
    if (!bytes.length) return json(400, { error: 'no picture was sent' });
    if (bytes.length > MAX_UPLOAD_BYTES) {
        return json(413, { error: 'that picture is too large to use' });
    }

    const stored = await storeCoverPicture({ store, slug: gated.slug, bytes });
    if (stored.error) return json(415, { error: stored.error });

    context.log('book.coverUploaded', { slug: gated.slug, bytes: bytes.length });

    return json(200, { picture: stored.picture });
}

/**
 * The uploaded picture, so the chooser can show what was uploaded.
 *
 * Owners only, like everything else on this page. It is not in `rendered/`
 * and the photo endpoint would refuse it anyway: that one only serves
 * pictures that belong to a letter somebody may read.
 */
export async function getCoverPicture({ request, context, store }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    const blob = await store.readBlob(CONFIG, coverFile(gated.slug));
    if (!blob) return json(404, { error: 'no picture has been uploaded' });

    return {
        status: 200,
        headers: hardened({ 'Content-Type': 'image/webp', 'Cache-Control': 'no-store' }),
        body: blob.bytes
    };
}

app.http('book-request', {
    // `anonymous` is the Functions access key, not the identity check: Static
    // Web Apps forwards to a linked backend without one. The identity check is
    // the principal header the gate reads, and it is not optional here.
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'book/{slug}',
    handler: (request, context) => publish({ request, context, store: blobStore() })
});

// Registered before the status route because that one ends in an optional
// segment and would otherwise swallow these two.
app.http('book-download', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'book/{slug}/{id}/letters.pdf',
    handler: (request, context) => deliver({ request, context, store: blobStore() })
});

app.http('book-proof', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'book/{slug}/{id}/proof.pdf',
    handler: (request, context) => review({ request, context, store: blobStore() })
});

app.http('book-cover-read', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'book/{slug}/cover',
    handler: (request, context) => cover({ request, context, store: blobStore() })
});

app.http('book-cover-write', {
    authLevel: 'anonymous',
    methods: ['PUT'],
    route: 'book/{slug}/cover',
    handler: (request, context) => chooseTheCover({ request, context, store: blobStore() })
});

app.http('book-cover-picture', {
    authLevel: 'anonymous',
    methods: ['GET', 'POST'],
    route: 'book/{slug}/cover.webp',
    handler: (request, context) =>
        request.method === 'POST'
            ? putCoverPicture({ request, context, store: blobStore() })
            : getCoverPicture({ request, context, store: blobStore() })
});

app.http('book-status', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'book/{slug}/{id?}',
    handler: (request, context) => progress({ request, context, store: blobStore() })
});

app.storageQueue('book', {
    queueName: 'book',
    connection: 'STORAGE',
    handler: (message, context) =>
        runBook({
            // The host parses the payload for us only when it is already an
            // object; a string arrives verbatim, exactly as in the render
            // trigger.
            message: typeof message === 'string' ? JSON.parse(message) : message,
            store: blobStore(),
            // Both only so the owner can be told how it went. This is the one
            // place in the book pipeline that sends anything: the request
            // endpoint answers a person who is looking at the page, and the
            // page polls. By the time the build ends they may be anywhere.
            tables: tableStore(),
            mailer: mailer(),
            baseUrl: setting('PUBLIC_BASE_URL', 'https://pdayletters.com'),
            log: context
        })
});
