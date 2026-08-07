import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { hardened, siteGate } from '../lib/api.js';
import { readProfile, saveProfile } from '../lib/profile.js';

// Reading and changing what a site is called.
//
// Owners only, and gated the same way member management is -- through
// `siteGate` rather than `gate`, because renaming an archive must not wait for
// its first letter to render. The archive most likely to need a rename is the
// one claimed thirty seconds ago.

let cachedBlobs = null;
let cachedTables = null;
const account = () => process.env.STORAGE_ACCOUNT_NAME;
const blobStore = () => (cachedBlobs ??= createBlobStore({ accountName: account() }));
const tableStore = () => (cachedTables ??= createTableStore({ accountName: account() }));

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status, body) => ({ status, headers: hardened(NO_STORE), jsonBody: body });

// The refusals `saveProfile` can produce, and what each one is. Everything
// here is about the request rather than a conflict, except the last, which is
// the only one retrying can resolve.
const STATUS = {
    'a display name is required': 400,
    'the return date must be a date, like 2027-06-15': 400,
    'somebody else changed this first': 409
};

export async function read({ request, context, store }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    const { profile } = await readProfile({ store, slug: gated.slug });

    // `alternateSenders` is not returned. Nothing reads it and nothing here
    // can change it, so shipping it to a page that cannot show it would only
    // invite somebody to build the control before the routing exists.
    //
    // No ETag either. The write guards itself between its own read and its own
    // write, so a validator handed to the client would round-trip without
    // deciding anything -- a header that looks like a concurrency guarantee
    // and is not one.
    return json(200, {
        slug: gated.slug,
        displayName: profile.displayName ?? '',
        returnDate: profile.returnDate ?? ''
    });
}

export async function write({ request, context, store, tables }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    let body = {};
    try {
        body = await request.json();
    } catch {
        return json(400, { error: 'that was not valid JSON' });
    }

    const result = await saveProfile({
        store,
        tables,
        slug: gated.slug,
        displayName: body.displayName,
        returnDate: body.returnDate,
        log: context
    });

    if (result.error) return json(STATUS[result.error] ?? 409, { error: result.error });

    context.log('site.renamed', { slug: gated.slug, hasReturnDate: Boolean(result.profile.returnDate) });

    return json(200, {
        slug: gated.slug,
        displayName: result.profile.displayName,
        returnDate: result.profile.returnDate ?? ''
    });
}

app.http('profile-read', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'profile/{slug}',
    handler: (request, context) => read({ request, context, store: blobStore() })
});

app.http('profile-write', {
    authLevel: 'anonymous',
    methods: ['PUT'],
    route: 'profile/{slug}',
    handler: (request, context) =>
        write({ request, context, store: blobStore(), tables: tableStore() })
});
