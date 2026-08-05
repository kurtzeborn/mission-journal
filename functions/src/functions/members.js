import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { createMailer } from '../lib/mail.js';
import { hardened } from '../lib/api.js';
import { ROLE, resolveRole } from '../lib/acl.js';
import { readPrincipal } from '../lib/principal.js';
import { validSlug } from '../lib/paths.js';
import { listMembers, removeMember, setMemberRole } from '../lib/members.js';
import { inviteMember, listInvites, revokeInvite } from '../lib/invite.js';

// Managing who may read an archive.
//
// Deliberately not routed through `gate()`, which every other authorized
// endpoint uses. `gate` reads `rendered/{slug}/posts.json` and refuses when it
// is missing, which is right for endpoints that are about to return posts and
// wrong here: an archive claimed a minute ago may have nothing rendered yet,
// and "you cannot invite your family until the first letter finishes
// rendering" is a rule nobody would choose. So the identity-slug-role part of
// the gate is repeated here without the fourth step.
//
// Membership is disclosed to owners only. A reader is entitled to the letters,
// not to the list of every other relative's email address.

let cachedBlobs = null;
let cachedTables = null;
let cachedMailer = null;
const account = () => process.env.STORAGE_ACCOUNT_NAME;
const blobStore = () => (cachedBlobs ??= createBlobStore({ accountName: account() }));
const tableStore = () => (cachedTables ??= createTableStore({ accountName: account() }));
const mailer = () =>
    (cachedMailer ??= createMailer({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        token: process.env.CLOUDFLARE_API_TOKEN,
        allowlist: process.env.MAIL_ALLOWLIST
    }));

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const json = (status, body) => ({ status, headers: hardened(NO_STORE), jsonBody: body });

// Indistinguishable from "no such site", as everywhere else: a signed-in
// stranger must not be able to discover which slugs exist by asking.
const DENIED = { status: 404, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' };

async function ownerOf({ request, store }) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal) {
        return { denied: { status: 401, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' } };
    }

    const slug = validSlug(request.params.slug);
    if (!slug) return { denied: DENIED };

    const role = await resolveRole({ store, slug, principal });
    if (!role) return { denied: DENIED };

    // 403 rather than 404, matching post.js: a reader already knows the site
    // exists, so the honest answer discloses nothing and saves them hunting
    // for a broken link.
    if (role !== ROLE.owner) return { denied: json(403, { error: 'owners only' }) };

    return { slug, principal };
}

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
    'too many invitations today, try again tomorrow': 429
};

const refuse = (error) => json(STATUS[error] ?? 409, { error });

async function readBody(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

export async function list({ request, store, tables }) {
    const gated = await ownerOf({ request, store });
    if (gated.denied) return gated.denied;

    const members = await listMembers({ store, slug: gated.slug, actor: gated.principal.email });
    if (!members) return DENIED;

    const invites = await listInvites({ tables, slug: gated.slug });

    return json(200, { members, invites });
}

export async function invite({ request, context, store, tables, mail, key, baseUrl }) {
    if (!key) return json(503, { error: 'unavailable' });

    const gated = await ownerOf({ request, store });
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

export async function update({ request, context, store, tables }) {
    const gated = await ownerOf({ request, store });
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
    const gated = await ownerOf({ request, store });
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

const baseUrl = () => process.env.PUBLIC_BASE_URL || 'https://pdayletters.com';
const signingKey = (context) => {
    const key = process.env.CLAIM_TOKEN_KEY;
    if (!key) context.error?.('members: CLAIM_TOKEN_KEY is not configured; refusing to sign');
    return key || null;
};

app.http('members-list', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'members/{slug}',
    handler: (request) => list({ request, store: blobStore(), tables: tableStore() })
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
            key: signingKey(context),
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
