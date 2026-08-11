import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { gate, hardened, contentEtag, matchesEtag } from '../lib/api.js';
import { ROLE } from '../lib/acl.js';
import { deletionOf } from '../lib/deletion.js';
import { applyEdit, commitPosts } from '../lib/edit.js';

let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

let cachedTables = null;
const tableStore = () =>
    (cachedTables ??= createTableStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

const problem = (status, error) => ({
    status,
    headers: hardened({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    }),
    jsonBody: { error }
});

const ok = (body) => ({
    status: 200,
    headers: hardened({
        'Content-Type': 'application/json; charset=utf-8',
        // A moderation action has to be visible on the next read, and a cached
        // 200 from an earlier edit would tell the owner their change stuck
        // when it had not.
        'Cache-Control': 'no-store'
    }),
    jsonBody: body
});

// The read gate plus the one extra question these endpoints ask.
async function ownerOnly(request, context) {
    const result = await gate({ store: blobStore(), request, log: context });
    if (result.denied) return result;

    // 403 rather than the gate's 404. A reader is genuinely entitled to this
    // site and already knows it exists, so saying "not yours to change"
    // discloses nothing, and a 404 here would send them hunting for a broken
    // link instead of telling them the truth.
    if (result.role !== ROLE.owner) return { denied: problem(403, 'owners only') };

    return result;
}

// What the caller is asserting they were looking at when they decided to write.
//
// The ETag on `posts.json` already stops two writes from interleaving on the
// server, but it cannot see the older problem: a browser filling an edit form
// from a copy of the site that has since moved on, then saving it back whole
// and undoing whatever happened in between. That is not a race, it is a
// perfectly orderly write of stale data, and only the client knows it is stale.
//
// `deleted` is threaded through for one reason: it is part of the validator
// the archive page was issued, so computing one without it here would reject
// an operator's edit on a deleted archive as out of date when nothing about
// the letters had moved at all. The two places must salt identically or the
// salt becomes a source of phantom conflicts.
const stale = (request, blobEtag, viaOperator, deleted) => {
    const expected = request.headers.get('if-match');
    // Absent means the caller is not making the claim -- older clients, and
    // curl. Enforcing it only when offered keeps this from being a new way for
    // a write to fail mysteriously.
    return expected
        ? !matchesEtag(expected, contentEtag(blobEtag, ROLE.owner, viaOperator, deleted))
        : false;
};

const STALE = 'the page you edited is out of date';

async function edit(request, context) {
    const gated = await ownerOnly(request, context);
    if (gated.denied) return gated.denied;

    let changes;
    try {
        changes = await request.json();
    } catch {
        return problem(400, 'body must be valid JSON');
    }

    const { postId } = request.params;
    let changed = [];

    // Read once, outside the mutate callback, which `commitPosts` may run more
    // than once on an ETag collision. Skipped entirely unless the caller is an
    // operator, which is the only way to be editing a deleted archive.
    const deleted = gated.viaOperator
        ? Boolean(await deletionOf({ tables: tableStore(), slug: gated.slug }))
        : false;

    const outcome = await commitPosts({
        store: blobStore(),
        slug: gated.slug,
        log: context,
        mutate: (posts, blobEtag) => {
            if (stale(request, blobEtag, gated.viaOperator, deleted)) return { error: STALE };

            const index = posts.findIndex((post) => post.id === postId);
            if (index < 0) return { error: 'not found' };

            const result = applyEdit(posts[index], changes, {
                editor: gated.principal.email,
                slug: gated.slug
            });
            if (result.error) return result;

            changed = result.changed;
            const next = [...posts];
            next[index] = result.post;
            return { posts: next };
        }
    });

    if (outcome.error) {
        if (outcome.error === 'not found') return problem(404, 'no such post');
        if (outcome.error === STALE) return problem(412, STALE);
        return problem(400, outcome.error);
    }

    context.log('post.edited', { slug: gated.slug, postId, changed });
    return ok({ id: postId, changed });
}

async function remove(request, context) {
    const gated = await ownerOnly(request, context);
    if (gated.denied) return gated.denied;

    const { postId } = request.params;

    const outcome = await commitPosts({
        store: blobStore(),
        slug: gated.slug,
        log: context,
        mutate: (posts) => {
            const next = posts.filter((post) => post.id !== postId);
            // Idempotent on purpose: a repeated DELETE is a double-click or a
            // retry, and reporting 404 for the second one would make a
            // successful deletion look like a failure.
            return { posts: next, removed: next.length !== posts.length };
        }
    });

    if (outcome.error) return problem(404, 'no such site');

    // The post's photos are deliberately left in place. `photoIsVisible`
    // resolves a photo by scanning the posts, so dropping the record already
    // makes them unfetchable, and the blobs are content-addressed and may be
    // shared with another letter that quoted the same picture.
    context.log('post.deleted', { slug: gated.slug, postId, removed: outcome.removed });
    return ok({ id: postId, removed: outcome.removed });
}

app.http('editPost', {
    // As everywhere else, authorization is the ACL check inside the handler;
    // `anonymous` only means no Functions access key, which Static Web Apps
    // does not send when it forwards to a linked backend.
    authLevel: 'anonymous',
    methods: ['PATCH'],
    route: 'posts/{slug}/{postId}',
    handler: edit
});

app.http('deletePost', {
    authLevel: 'anonymous',
    methods: ['DELETE'],
    route: 'posts/{slug}/{postId}',
    handler: remove
});
