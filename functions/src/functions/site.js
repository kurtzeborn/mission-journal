import { app } from '@azure/functions';
import { blobStore, tableStore } from '../lib/clients.js';
import { jsonResponse as json, siteGate } from '../lib/api.js';
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
//
// **An operator deleting somebody else's archive has to say why, and this is
// the whole of what makes their path different.** There is deliberately no
// operator-only delete route: one code path means one retention story, one
// confirmation, one set of tests, and no chance of the two drifting into
// different promises about what "permanent" means. An operator reaches this
// endpoint exactly as an owner does, having resolved into `owner` above the
// ACL, and the only thing the gate adds is the flag that makes the reason
// mandatory.

const CONFIRM = 'type the archive name to confirm';
const WHY = 'say why you are deleting an archive that is not yours';

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

    // Trusted no further than any other string from a browser: it is written
    // to a table and read back by an operator, never rendered as markup, and
    // capped so a paste accident cannot fill a row.
    const reason = String(body.reason ?? '').trim().slice(0, 500);

    // An owner deleting their own family's archive owes nobody an explanation,
    // and demanding one would be this service asking a family to justify
    // leaving. An operator deleting a stranger's is the one action here that
    // destroys somebody else's only copy of something, and the reason is the
    // only part of it that cannot be reconstructed afterwards -- the slug, the
    // actor, the member count and the date are all in the record already.
    //
    // Enforced on the server for the same reason the typed name is: a rule
    // that lives only in the form is one a retried fetch never has to pass,
    // and an audit field that is optional in practice is worse than none,
    // because the empty ones then look like a choice somebody made.
    //
    // Not length-checked beyond being present. A minimum is theatre against
    // somebody who can type `x`, and the audience for this string is the
    // operator's own future self.
    if (gated.viaOperator && !reason) {
        return json(400, { error: WHY });
    }

    const result = await deleteSite({
        store,
        tables,
        slug: gated.slug,
        by: gated.principal.email,
        reason,
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
