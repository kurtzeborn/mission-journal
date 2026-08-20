// The operator's view of the service: what is arriving, and what has been
// deleted and not yet erased.
//
// Two routes, both under `/manage`, both refusing anyone not on
// OPERATOR_EMAILS with a 404, and both audited by `operatorGate` before they
// do anything. They share a file because they share every one of those
// properties and because they are the two halves of one page.
//
// **`last-received` is the only view in the service that spans archives**, and
// therefore the only one that can notice ingest having stopped -- a failure
// that is silent by construction, since no letter arriving means no letter
// missing from any page. See flow.js.
//
// **The deletions half exists because there is no owner-facing undo, on
// purpose.** The confirmation on the settings page says the archive is gone
// and that nothing can bring it back, and a visible undo button would make
// that a lie -- families would start treating deletion as reversible, which is
// exactly the understanding this feature must not create. What actually exists
// is a thirty-day window in which the letters have not been destroyed yet, and
// somebody who is sorry can ask. A silent safety net, with a door only an
// operator can open. The mistake it is for is somebody deleting the wrong
// archive and realising an hour later, and the recovery path for it is a
// conversation, not a button.

import { app } from '@azure/functions';
import { blobStore, tableStore } from '../lib/clients.js';
import { jsonResponse as json, operatorGate } from '../lib/api.js';
import { pendingDeletions, restoreSite } from '../lib/deletion.js';
import { serviceFlow } from '../lib/flow.js';
import { validSlug } from '../lib/paths.js';

const account = () => process.env.STORAGE_ACCOUNT_NAME;

async function list(request, context) {
    const gated = operatorGate({ request, log: context });
    if (gated.denied) return gated.denied;

    return json(200, { deletions: await pendingDeletions({ tables: tableStore() }) });
}

export async function received(request, context, store = blobStore(), tables = tableStore()) {
    const gated = operatorGate({ request, log: context });
    if (gated.denied) return gated.denied;

    return json(200, await serviceFlow({ store, tables }));
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

app.http('last-received', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'manage/last-received',
    handler: received
});

app.http('deletions-restore', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'manage/deletions/{slug}/restore',
    handler: restore
});
