// The operator's view of the letters that never got in.
//
// Three doors out of a rejection, in the order they should be tried:
//
//   **Retry** runs the letter through the ordinary rules again. Nothing is
//   forced -- if it fails it fails the same way. This exists because the rules
//   change: the header-only DKIM acceptance turned a fortnight of refused
//   forwards into letters that would sail through, and without this the only
//   way to find that out was to ask a family to send their mail again.
//
//   **Advise again** clears the once-only suppression and re-sends the nudge.
//   For somebody who was told the wrong thing, or told it so long ago that the
//   mail is buried.
//
//   **Bypass** starts the archive anyway. See classify.js for what that costs
//   and what fences it has.
//
// All three are gated on OPERATOR_EMAILS and answer 404 to everybody else, so
// this file's routes do not exist for anyone who should not have them. All
// three also re-read `inbox/{ulid}.raw`, which the account expires after
// thirty days -- past that there is nothing to act on, which is why the rows
// are kept for exactly as long.

import { app } from '@azure/functions';
import { blobStore, ingestConfig, mailer, tableStore } from '../lib/clients.js';
import { jsonResponse as json, operatorGate } from '../lib/api.js';
import { runIngest } from '../lib/ingest.js';
import { listRejections } from '../lib/rejections.js';
import { forgetNudge, nudgeOnce, NUDGE } from '../lib/nudge.js';
import { readAcl } from '../lib/acl.js';
import { validSlug, validUlid } from '../lib/paths.js';

// A rejection is answered once the slug is somewhere rather than nowhere --
// either claimed, or holding letters and waiting to be. Both are what the
// buttons on this page are trying to bring about, so both retire the row.
const settledIn = (store) => async (slug) =>
    Boolean(await readAcl(store, slug)) ||
    Boolean(await store.readBlob('pending', `${slug}/claim.json`));

async function list(request, context) {
    const gated = operatorGate({ request, log: context });
    if (gated.denied) return gated.denied;

    const store = blobStore();
    return json(200, {
        rejections: await listRejections({ tables: tableStore(), settled: settledIn(store) })
    });
}

// The path parameters are the whole of the input, and both reach storage, so
// both are validated rather than trusted -- an operator is authenticated, not
// infallible, and a slug is still a blob path however it got here.
function target(request) {
    const slug = validSlug(request.params.slug);
    const ulid = validUlid(request.params.ulid);
    return slug && ulid ? { slug, ulid } : null;
}

function replayer(bypass) {
    return async function replay(request, context) {
        const gated = operatorGate({ request, log: context });
        if (gated.denied) return gated.denied;

        const where = target(request);
        if (!where) return json(400, { error: 'not a message' });

        // Run in the request rather than back onto the `ingest` queue. The
        // operator needs the verdict, and a bypass flag riding through a queue
        // would be a privileged instruction sitting in a message that nothing
        // downstream could tell apart from an ordinary one.
        const result = await runIngest({
            ulid: where.ulid,
            store: blobStore(),
            tables: tableStore(),
            mailer: mailer(),
            config: ingestConfig(),
            log: context,
            bypass: bypass ? gated.principal.email : ''
        });

        context.log('rejections: replayed', {
            slug: where.slug,
            ulid: where.ulid,
            bypass,
            by: gated.principal.email,
            status: result.status,
            reason: result.reason ?? null
        });

        return json(200, { slug: where.slug, ulid: where.ulid, ...result });
    };
}

async function advise(request, context) {
    const gated = operatorGate({ request, log: context });
    if (gated.denied) return gated.denied;

    const where = target(request);
    if (!where) return json(400, { error: 'not a message' });

    const to = String(request.query.get('to') ?? '').trim();
    const kind = request.query.get('kind') === NUDGE.rebuilt ? NUDGE.rebuilt : NUDGE.attach;
    if (!to.includes('@')) return json(400, { error: 'not an address' });

    const tables = tableStore();
    await forgetNudge({ tables, to, slug: where.slug, kind });

    // Deliberately without `askUrl`. That link lets a forwarder write to the
    // missionary through us, and it is issued when a letter arrives, signed
    // against that letter. Re-sending advice is not the arrival of anything.
    const result = await nudgeOnce({
        tables,
        mailer: mailer(),
        to,
        author: String(request.query.get('author') ?? ''),
        slug: where.slug,
        baseUrl: ingestConfig().baseUrl,
        kind,
        log: context
    });

    context.log('rejections: advised again', {
        slug: where.slug,
        kind,
        by: gated.principal.email,
        status: result.status
    });

    return json(200, { slug: where.slug, kind, status: result.status });
}

app.http('rejections-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'manage/rejections',
    handler: list
});

app.http('rejections-retry', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'manage/rejections/{slug}/{ulid}/retry',
    handler: replayer(false)
});

app.http('rejections-bypass', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'manage/rejections/{slug}/{ulid}/bypass',
    handler: replayer(true)
});

app.http('rejections-advise', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'manage/rejections/{slug}/{ulid}/advise',
    handler: advise
});

export { list, replayer, advise, settledIn };
