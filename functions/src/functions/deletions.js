// The operator's view of what has been deleted and not yet erased.
//
// There is no owner-facing undo, on purpose. The confirmation on the settings
// page says the archive is gone and that nothing here can bring it back, and a
// visible undo button would make that a lie -- families would start treating
// deletion as reversible, which is exactly the understanding this feature must
// not create. What actually exists is a thirty-day window in which the letters
// have not been destroyed yet, and somebody who is sorry can ask.
//
// So: a silent safety net, with a door only an operator can open. The mistake
// this is for is somebody deleting the wrong archive and realising an hour
// later, and the recovery path for it is a conversation, not a button.
//
// Both routes here refuse anyone not on OPERATOR_EMAILS with a 404, and both
// are audited by `operatorGate` before they do anything.

import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { hardened, operatorGate } from '../lib/api.js';
import { pendingDeletions, restoreSite } from '../lib/deletion.js';
import { validSlug } from '../lib/paths.js';

const account = () => process.env.STORAGE_ACCOUNT_NAME;

let cachedBlobs = null;
let cachedTables = null;
const blobStore = () => (cachedBlobs ??= createBlobStore({ accountName: account() }));
const tableStore = () => (cachedTables ??= createTableStore({ accountName: account() }));

const json = (status, body) => ({
    status,
    headers: hardened({
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8'
    }),
    jsonBody: body
});

async function list(request, context) {
    const gated = operatorGate({ request, log: context });
    if (gated.denied) return gated.denied;

    return json(200, { deletions: await pendingDeletions({ tables: tableStore() }) });
}

async function restore(request, context) {
    const gated = operatorGate({ request, log: context });
    if (gated.denied) return gated.denied;

    const slug = validSlug(request.params.slug);
    if (!slug) return json(400, { error: 'not a slug' });

    const result = await restoreSite({
        store: blobStore(),
        tables: tableStore(),
        slug,
        by: gated.principal.email,
        log: context
    });

    // `slug in use` is the dangerous one and the only reason this is not a
    // flat 404. Somebody has claimed the name again since the deletion, and
    // putting the old ACL back would hand a stranger's family access to
    // whatever is standing there now.
    if (result.error) return json(result.error === 'slug in use' ? 409 : 404, result);

    return json(200, result);
}

app.http('deletions-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'manage/deletions',
    handler: list
});

app.http('deletions-restore', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'manage/deletions/{slug}/restore',
    handler: restore
});
