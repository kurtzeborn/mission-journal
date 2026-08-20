import { app } from '@azure/functions';
import { blobStore, tableStore } from '../lib/clients.js';
import { jsonResponse as json, siteGate } from '../lib/api.js';
import { readProfile, saveProfile } from '../lib/profile.js';
import { sitesBySlug } from '../lib/sites.js';

// Reading and changing what a site is called.
//
// Owners only, and gated the same way member management is -- through
// `siteGate` rather than `gate`, because renaming an archive must not wait for
// its first letter to render. The archive most likely to need a rename is the
// one claimed thirty seconds ago.

// The refusals `saveProfile` can produce, and what each one is. Everything
// here is about the request rather than a conflict, except the last, which is
// the only one retrying can resolve.
const STATUS = {
    'a display name is required': 400,
    'the start date must be a date, like 2025-06-15': 400,
    'the return date must be a date, like 2027-06-15': 400,
    'somebody else changed this first': 409
};

export async function read({ request, context, store, tables }) {
    const gated = await siteGate({ store, request, ownersOnly: true, log: context });
    if (gated.denied) return gated.denied;

    const { profile } = await readProfile({ store, slug: gated.slug });

    // An archive claimed before `profile.json` existed has no file at all --
    // the claim flow writes the `sites` row and stops -- so reading the blob
    // alone hands the owner an empty box with a placeholder in it. That is not
    // a blank field, it is a wrong one: the archive plainly has a name, it is
    // in the masthead they clicked through from, and a form that has forgotten
    // it invites somebody to retype it slightly differently.
    //
    // The row is not a guess at the name. It is the name every reader path
    // already displays, so falling back to it shows the owner what they will
    // see if they change nothing.
    //
    // Nothing is repaired here. A GET that writes is a GET that can fail for
    // reasons the reader cannot act on, and the file appears on its own the
    // first time this form is saved.
    let displayName = profile.displayName ?? '';
    if (!displayName) {
        const rows = await sitesBySlug({ tables, slugs: [gated.slug] });
        displayName = rows.get(gated.slug)?.missionaryDisplayName ?? '';
    }

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
        displayName,
        mission: profile.mission ?? '',
        // No row fallback for the dates. Only this form has ever written
        // either of them, so the file is the only place they can have come
        // from, and an empty field here is the truth rather than an omission.
        startDate: profile.startDate ?? '',
        returnDate: profile.returnDate ?? '',
        // Nothing on this page is *about* the profile, and it is here because
        // this is the page the delete control lives on. An operator deleting
        // somebody else's archive has to give a reason, and the form cannot
        // ask for one it does not know is required. Reading it off a second
        // endpoint would mean two calls answering the same question, which is
        // how the two answers eventually differ.
        viaOperator: gated.viaOperator
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
        mission: body.mission,
        startDate: body.startDate,
        returnDate: body.returnDate,
        log: context
    });

    if (result.error) return json(STATUS[result.error] ?? 409, { error: result.error });

    context.log('site.renamed', {
        slug: gated.slug,
        hasMission: Boolean(result.profile.mission),
        hasStartDate: Boolean(result.profile.startDate),
        hasReturnDate: Boolean(result.profile.returnDate)
    });

    return json(200, {
        slug: gated.slug,
        displayName: result.profile.displayName,
        mission: result.profile.mission ?? '',
        startDate: result.profile.startDate ?? '',
        returnDate: result.profile.returnDate ?? ''
    });
}

app.http('profile-read', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'profile/{slug}',
    handler: (request, context) =>
        read({ request, context, store: blobStore(), tables: tableStore() })
});

app.http('profile-write', {
    authLevel: 'anonymous',
    methods: ['PUT'],
    route: 'profile/{slug}',
    handler: (request, context) =>
        write({ request, context, store: blobStore(), tables: tableStore() })
});
