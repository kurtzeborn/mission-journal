import { app } from '@azure/functions';
import { blobStore, tableStore } from '../lib/clients.js';
import { sitesBySlug, siteFacts } from '../lib/sites.js';
import { deletionOf } from '../lib/deletion.js';
import { gate, hardened, contentEtag, notModified } from '../lib/api.js';
import { presentPosts } from '../lib/present.js';

// The whole site in one response. A family archive is a few hundred letters at
// most, so paging would add a moving part for no gain, and having the entire
// corpus client-side is what lets the reader's search run without a server.
async function handler(request, context) {
    const result = await gate({ store: blobStore(), request, log: context });
    if (result.denied) return result.denied;

    // Before the ETag rather than after, and for the same reason as the site
    // row below: the answer changes the validator -- see contentEtag. Only an
    // operator can reach a deleted archive at all, so this read is skipped for
    // every ordinary visitor, which is everyone.
    const deleted = result.viaOperator
        ? await deletionOf({ tables: tableStore(), slug: result.slug })
        : null;

    // Before the 304, which it did not used to be. Skipping it on a
    // revalidation saved a point read and cost correctness: the name and the
    // mission start date are in the body, so they belong in the validator, and
    // a validator that ignores them hands a reader back a cached copy with the
    // old name on it. One point read in the slug's own partition is what the
    // site row exists to make cheap, and this is the thing it was made cheap
    // for.
    const site = (await sitesBySlug({ tables: tableStore(), slugs: [result.slug] })).get(
        result.slug
    );

    const etag = contentEtag(
        result.etag,
        result.role,
        result.viaOperator,
        Boolean(deleted),
        siteFacts(site)
    );

    // `no-cache` rather than a lifetime. This file is the one thing here that
    // changes -- a letter arrives, an owner hides or edits one -- and a stale
    // copy is worse than merely out of date: it is what the owner's edit form
    // is filled from, so holding it made a second edit silently reinstate what
    // the first had removed. Revalidating costs a round trip and usually a 304.
    const fresh = { ETag: etag, 'Cache-Control': 'private, no-cache' };

    const unchanged = notModified(request.headers.get('if-none-match'), etag);
    if (unchanged) return unchanged;

    return {
        status: 200,
        headers: hardened({ 'Content-Type': 'application/json; charset=utf-8', ...fresh }),
        jsonBody: {
            slug: result.slug,
            // What the family calls the missionary, which is what the page is
            // titled with. Empty until somebody claims the site and types one,
            // so the client falls back to the slug rather than to nothing.
            name: site?.missionaryDisplayName ?? '',
            // The day the mission began, or empty. Sent to everyone who can
            // read the archive rather than to owners alone, because the page
            // counts up from it in front of the whole family; the settings
            // form that sets it stays owners-only.
            startDate: site?.missionStartDate ?? '',
            role: result.role,
            // Only ever true for the one or two addresses in OPERATOR_EMAILS,
            // and it drives a banner rather than a permission -- the operator
            // is already an owner by the time this is read. It is part of the
            // ETag salt above, because it is part of the body: a response with
            // the warning and one without must not share a validator.
            viaOperator: Boolean(result.viaOperator),
            // Present only when this archive has been deleted and not yet
            // erased, which only an operator can ever see. Null the rest of
            // the time rather than absent, so the client has one shape to
            // read and no reason to guess.
            deleted,
            posts: presentPosts(result.posts, result.role)
        }
    };
}

app.http('content', {
    // Authorization is the ACL check inside the handler. `anonymous` here means
    // no Functions access key, which is required: Static Web Apps forwards to a
    // linked backend without one, and the app is reachable only through it.
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'content/{slug}/posts.json',
    handler
});
