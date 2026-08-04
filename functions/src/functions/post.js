import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { gate, hardened } from '../lib/api.js';
import { ROLE } from '../lib/acl.js';
import { applyEdit, commitPosts } from '../lib/edit.js';

let cachedStore = null;
const blobStore = () =>
    (cachedStore ??= createBlobStore({ accountName: process.env.STORAGE_ACCOUNT_NAME }));

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
async function ownerOnly(request) {
    const result = await gate({ store: blobStore(), request });
    if (result.denied) return result;

    // 403 rather than the gate's 404. A reader is genuinely entitled to this
    // site and already knows it exists, so saying "not yours to change"
    // discloses nothing, and a 404 here would send them hunting for a broken
    // link instead of telling them the truth.
    if (result.role !== ROLE.owner) return { denied: problem(403, 'owners only') };

    return result;
}

async function edit(request, context) {
    const gated = await ownerOnly(request);
    if (gated.denied) return gated.denied;

    let changes;
    try {
        changes = await request.json();
    } catch {
        return problem(400, 'body must be valid JSON');
    }

    const { postId } = request.params;
    let changed = [];

    const outcome = await commitPosts({
        store: blobStore(),
        slug: gated.slug,
        log: context,
        mutate: (posts) => {
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
        return outcome.error === 'not found'
            ? problem(404, 'no such post')
            : problem(400, outcome.error);
    }

    context.log('post.edited', { slug: gated.slug, postId, changed });
    return ok({ id: postId, changed });
}

async function remove(request, context) {
    const gated = await ownerOnly(request);
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
