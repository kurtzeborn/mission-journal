import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { hardened, siteGate } from '../lib/api.js';
import { deleteSite } from '../lib/deletion.js';

// Deleting an archive.
//
// Owners only, and gated through `siteGate` rather than `gate` for the same
// reason renaming is: an archive with nothing rendered yet is exactly the one
// somebody is most likely to want rid of. A site created by a spam forward has
// no letters at all, and "you cannot delete this until it receives a letter"
// would be an absurd rule.
//
// **The typed confirmation is enforced here, not only in the browser.** A
// confirmation that lives entirely in JavaScript is a confirmation that a
// mistyped `curl`, a retried fetch, or a stray double-click does not have to
// pass. The client asks the human to type the slug; the server refuses the
// request unless the slug came back in the body. It is not a security control
// -- the caller is already an authenticated owner and could type anything --
// it is an accident control, and accidents are what this whole thirty-day
// design is built around.

let cachedBlobs = null;
let cachedTables = null;
const account = () => process.env.STORAGE_ACCOUNT_NAME;
const blobStore = () => (cachedBlobs ??= createBlobStore({ accountName: account() }));
const tableStore = () => (cachedTables ??= createTableStore({ accountName: account() }));

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status, body) => ({ status, headers: hardened(NO_STORE), jsonBody: body });

const CONFIRM = 'type the archive name to confirm';

export async function remove({ request, context, store, tables }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    let body = {};
    try {
        body = await request.json();
    } catch {
        return json(400, { error: CONFIRM });
    }

    // Compared after trimming, because the slug is being copied by hand from
    // the prompt beside the box and a trailing space is not a different
    // intention. Case is not folded: slugs are lowercase everywhere in this
    // service, and accepting `Elder.Example` here would be the only place that
    // is not true.
    if (String(body.confirm ?? '').trim() !== gated.slug) {
        return json(400, { error: CONFIRM });
    }

    const result = await deleteSite({
        store,
        tables,
        slug: gated.slug,
        by: gated.principal.email,
        // Operators are asked for one and owners are not -- see deletion.js.
        // Trusted no further than any other string from a browser: it is
        // written to a table and read back by an operator, never rendered as
        // markup, and capped so a paste accident cannot fill a row.
        reason: String(body.reason ?? '').slice(0, 500),
        log: context
    });

    if (result.error) return json(404, { error: 'no such site' });

    return json(200, { slug: result.slug, purgeAfter: result.purgeAfter, members: result.members });
}

app.http('site-delete', {
    authLevel: 'anonymous',
    methods: ['DELETE'],
    route: 'site/{slug}',
    handler: (request, context) =>
        remove({ request, context, store: blobStore(), tables: tableStore() })
});
