// The operator's view of the archives nobody has claimed.
//
// A pending site is the quietest failure this service has. The letters are
// safe, the manifest is counting down, and the only thing standing between
// the two is an email that may never have arrived -- claim mail is sent once
// and once only, because a second link invalidates the first, and a send that
// fails is written to a log nobody is reading. That is not hypothetical: a
// `Reply-To` in the wrong half of the request refused every claim email this
// service sent for a fortnight, and the way it was found was somebody asking
// why an archive they had forwarded to had gone silent.
//
// So: a list of what is waiting, who it is waiting on, and one button.
//
// Offering again re-mints, which invalidates whatever link went out before.
// That is the correct trade here -- if the last one had worked, nobody would
// be pressing this -- but it is why the button names the address first.

import { app } from '@azure/functions';
import { blobStore, ingestConfig, mailer } from '../lib/clients.js';
import { jsonResponse as json, operatorGate } from '../lib/api.js';
import { listPending, pendingRecipient } from '../lib/pending.js';
import { claimManifest } from '../lib/claim.js';
import { offerClaim } from '../lib/offer.js';
import { validSlug } from '../lib/paths.js';

async function list(request, context) {
    const gated = operatorGate({ request, log: context });
    if (gated.denied) return gated.denied;

    return json(200, { pending: await listPending({ store: blobStore(), log: context }) });
}

async function offer(request, context) {
    const gated = operatorGate({ request, log: context });
    if (gated.denied) return gated.denied;

    const slug = validSlug(request.params.slug);
    if (!slug) return json(400, { error: 'not an archive' });

    const config = ingestConfig();
    if (!config.claimTokenKey) return json(503, { status: 'unavailable' });

    const store = blobStore();
    const manifest = await claimManifest(store, slug);
    if (!manifest || manifest.claimedAt) return json(200, { slug, status: 'gone' });

    const to = await pendingRecipient({ store, slug, manifest });
    if (!to) return json(200, { slug, status: 'no-recipient' });

    const result = await offerClaim({
        store,
        mailer: mailer(),
        slug,
        key: config.claimTokenKey,
        baseUrl: config.baseUrl,
        to,
        forwarded: !manifest.hasDirect,
        log: context
    });

    // The address is in the log because an operator pressed a button that
    // chose it for them, and "which address did it pick" is the first
    // question when the mail does not turn up. Everything else about a claim
    // -- the token, the link -- stays out, as it does everywhere else.
    context.log('pending: offered', {
        slug,
        to,
        by: gated.principal.email,
        status: result.status
    });

    return json(200, { slug, status: result.status });
}

app.http('pending-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'manage/pending',
    handler: list
});

app.http('pending-offer', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'manage/pending/{slug}/offer',
    handler: offer
});
