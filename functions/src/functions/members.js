import { app } from '@azure/functions';
import { blobStore, mailer, signingKey, tableStore } from '../lib/clients.js';
import { hardened, jsonResponse as json, siteGate } from '../lib/api.js';
import { setting } from '../lib/settings.js';
import { ROLE } from '../lib/acl.js';
import { listMembers, removeMember, setMemberRole } from '../lib/members.js';
import { inviteMember, listInvites, resendInvite, revokeInvite } from '../lib/invite.js';

// Managing who may read an archive.
//
// Deliberately not routed through `gate()`, which every other authorized
// endpoint uses. `gate` reads `rendered/{slug}/posts.json` and refuses when it
// is missing, which is right for endpoints that are about to return posts and
// wrong here: an archive claimed a minute ago may have nothing rendered yet,
// and "you cannot invite your family until the first letter finishes
// rendering" is a rule nobody would choose. `siteGate` is the same gate
// without that fourth step.
//
// Membership is disclosed to owners only. A reader is entitled to the letters,
// not to the list of every other relative's email address.

// Indistinguishable from "no such site", as everywhere else: a signed-in
// stranger must not be able to discover which slugs exist by asking.
const DENIED = { status: 404, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' };

const ownerOf = ({ request, store, context }) =>
    siteGate({ store, request, ownersOnly: true, log: context });

// Every refusal from the lib layer is a 409 except the ones that are really
// about the request itself. Kept as one table so the endpoints below stay free
// of policy -- the policy is in members.js, and this only translates it.
const STATUS = {
    'no such site': 404,
    'not a member': 404,
    'no such invitation': 404,
    'not an email address': 400,
    'unknown role': 400,
    'owners only': 403,
    // Not a 403: the caller is allowed to do this and will be allowed again
    // tomorrow. 429 is the answer that says so, and the one an owner's client
    // could sensibly act on.
    'too many invitations today, try again tomorrow': 429,
    // 403 rather than 409: this is not a conflict to be resolved, and no
    // amount of retrying by the owner will change it. The person at that
    // address said no, and the owner does not get a vote.
    'has asked us not to email them': 403
};

const refuse = (error) => json(STATUS[error] ?? 409, { error });

async function readBody(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

export async function list({ request, context, store, tables }) {
    const gated = await ownerOf({ request, store, context });
    if (gated.denied) return gated.denied;

    const members = await listMembers({ store, tables, slug: gated.slug, actor: gated.principal.email, log: context });
    if (!members) return DENIED;

    const invites = await listInvites({ tables, slug: gated.slug, log: context });

    return json(200, { members, invites });
}

export async function invite({ request, context, store, tables, mail, key, baseUrl }) {
    if (!key) return json(503, { error: 'unavailable' });

    const gated = await ownerOf({ request, store, context });
    if (gated.denied) return gated.denied;

    const { email, role } = await readBody(request);

    const result = await inviteMember({
        store,
        tables,
        mailer: mail,
        slug: gated.slug,
        actor: gated.principal.email,
        email,
        role: role === ROLE.owner ? ROLE.owner : ROLE.reader,
        key,
        baseUrl,
        log: context
    });

    if (result.error) return refuse(result.error);

    context.log('member.invited', { slug: gated.slug, role: result.role, delivery: result.delivery });
    return json(200, result);
}

// Its own route rather than a shape check on an existing one.
//
// `remove` sniffs whether its parameter is an address or an invitation id
// because to the owner those really are one list with one X button. Nothing
// like that applies here: only an invitation can be resent, so a separate
// route says so without anybody having to read a regular expression to find
// out what a request means.
export async function resend({ request, context, store, tables, mail, key, baseUrl }) {
    if (!key) return json(503, { error: 'unavailable' });

    const gated = await ownerOf({ request, store, context });
    if (gated.denied) return gated.denied;

    const result = await resendInvite({
        store,
        tables,
        mailer: mail,
        slug: gated.slug,
        actor: gated.principal.email,
        id: request.params.id,
        key,
        baseUrl,
        log: context
    });

    if (result.error) return refuse(result.error);

    context.log('member.invite-resent', { slug: gated.slug, delivery: result.delivery });
    return json(200, result);
}

export async function update({ request, context, store, tables }) {
    const gated = await ownerOf({ request, store, context });
    if (gated.denied) return gated.denied;

    const { role } = await readBody(request);

    const result = await setMemberRole({
        store,
        tables,
        slug: gated.slug,
        actor: gated.principal.email,
        email: request.params.email,
        role,
        log: context
    });

    if (result.error) return refuse(result.error);

    context.log('member.role-changed', { slug: gated.slug, role });
    return json(200, result);
}

export async function remove({ request, context, store, tables }) {
    const gated = await ownerOf({ request, store, context });
    if (gated.denied) return gated.denied;

    const target = request.params.email;

    // One route, two things it can name: somebody on the ACL, or an invitation
    // nobody has accepted. They are told apart by shape rather than by a
    // separate endpoint, because to the owner looking at the page they are one
    // list with one X button next to each row, and an invitation id is a
    // 64-character hex string that no address can be mistaken for.
    if (/^[0-9a-f]{64}$/.test(String(target))) {
        const revoked = await revokeInvite({ tables, slug: gated.slug, id: target });
        if (revoked.error) return refuse(revoked.error);
        context.log('member.invite-revoked', { slug: gated.slug });
        return json(200, revoked);
    }

    const result = await removeMember({
        store,
        tables,
        slug: gated.slug,
        actor: gated.principal.email,
        email: target,
        log: context
    });

    if (result.error) return refuse(result.error);

    context.log('member.removed', { slug: gated.slug });
    return json(200, result);
}

const baseUrl = () => setting('PUBLIC_BASE_URL', 'https://pdayletters.com');

app.http('members-list', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'members/{slug}',
    handler: (request, context) => list({ request, context, store: blobStore(), tables: tableStore() })
});

app.http('members-invite', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'members/{slug}',
    handler: (request, context) =>
        invite({
            request,
            context,
            store: blobStore(),
            tables: tableStore(),
            mail: mailer(),
            key: signingKey('members', context),
            baseUrl: baseUrl()
        })
});

app.http('members-resend', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'members/{slug}/{id}/resend',
    handler: (request, context) =>
        resend({
            request,
            context,
            store: blobStore(),
            tables: tableStore(),
            mail: mailer(),
            key: signingKey('members', context),
            baseUrl: baseUrl()
        })
});

app.http('members-update', {
    authLevel: 'anonymous',
    methods: ['PATCH'],
    route: 'members/{slug}/{email}',
    handler: (request, context) =>
        update({ request, context, store: blobStore(), tables: tableStore() })
});

app.http('members-remove', {
    authLevel: 'anonymous',
    methods: ['DELETE'],
    route: 'members/{slug}/{email}',
    handler: (request, context) =>
        remove({ request, context, store: blobStore(), tables: tableStore() })
});
