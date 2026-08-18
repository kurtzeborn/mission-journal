import { app } from '@azure/functions';
import { createBlobStore } from '../lib/store.js';
import { createTableStore } from '../lib/tables.js';
import { gate, hardened, contentEtag, matchesEtag } from '../lib/api.js';
import { ROLE } from '../lib/acl.js';
import { deletionOf } from '../lib/deletion.js';
import { sitesBySlug, siteFacts } from '../lib/sites.js';
import { applyEdit, commitPosts } from '../lib/edit.js';
import { isPhotoType, storePhoto, MAX_UPLOAD_BYTES } from '../lib/photos.js';
import { runRender } from '../lib/render.js';

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
async function ownerOnly(request, context, store = blobStore()) {
    const result = await gate({ store, request, log: context });
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
// salt becomes a source of phantom conflicts. `site` is here for exactly that
// reason and no other -- an owner editing a letter has no interest in the
// archive's name or its mission dates, but the validator they were handed was
// salted with both.
const stale = (request, blobEtag, viaOperator, deleted, site) => {
    const expected = request.headers.get('if-match');
    // Absent means the caller is not making the claim -- older clients, and
    // curl. Enforcing it only when offered keeps this from being a new way for
    // a write to fail mysteriously.
    return expected
        ? !matchesEtag(expected, contentEtag(blobEtag, ROLE.owner, viaOperator, deleted, site))
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

    // Read for the salt alone, and only when the caller is actually asserting
    // what they were looking at. An edit sent without If-Match is not making
    // the claim, so there is nothing to check it against and no reason to pay
    // for the lookup.
    const site = request.headers.get('if-match')
        ? siteFacts((await sitesBySlug({ tables: tableStore(), slugs: [gated.slug] })).get(gated.slug))
        : '';

    const outcome = await commitPosts({
        store: blobStore(),
        slug: gated.slug,
        log: context,
        mutate: (posts, blobEtag) => {
            if (stale(request, blobEtag, gated.viaOperator, deleted, site)) return { error: STALE };

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

// Put a letter back the way it arrived.
//
// Destructive and deliberately so: it is the only way anyone reaches what the
// missionary originally wrote, and it reaches it by *rewriting the rendered
// post from `raw/`* rather than handing anybody the `.eml`. The text comes
// back through the sanitizer and the ordinary read path, exactly like a newly
// ingested letter, so nothing in the storage rules bends to accommodate it.
//
// Run in the request rather than queued. A restore is destructive and the
// owner has just been asked to confirm it, so "it is happening somewhere,
// probably" is the wrong answer to give them -- and the work is bounded by one
// message's photos, which are content-addressed and rewrite the same blobs.
async function restore(request, context) {
    const gated = await ownerOnly(request, context);
    if (gated.denied) return gated.denied;

    const { postId } = request.params;
    const store = blobStore();

    const current = await store.readBlob('rendered', `${gated.slug}/posts.json`);
    if (!current) return problem(404, 'no such site');

    const posts = JSON.parse(Buffer.from(current.bytes).toString('utf8'));
    const post = posts.find((entry) => entry.id === postId);
    if (!post) return problem(404, 'no such post');

    // The path is written at ingest and never edited -- it is not in the
    // editable set -- so parsing it back is cheaper than carrying the message
    // id twice on every post.
    const msgId = /^raw\/[^/]+\/([^/]+)\/message\.eml$/.exec(post.sourceRawPath ?? '')?.[1];
    if (!msgId) return problem(409, 'this letter has no original to restore from');

    const outcome = await runRender({
        message: { slug: gated.slug, msgId, postId },
        store,
        restore: true,
        log: context
    });

    // The raw message is gone, which means the site was deleted underneath
    // this. Nothing to say beyond that there is no original any more.
    if (outcome.status !== 'rendered') {
        return problem(409, 'the original letter is no longer in the archive');
    }

    context.log('post.restored', { slug: gated.slug, postId, photos: outcome.photos });
    return ok({ id: postId, restored: true });
}

// Pictures an owner adds to a letter themselves.
//
// One picture per request, raw bytes in the body with a content type on it --
// no multipart, because there is exactly one field and parsing a form to find
// it would be work done for nothing. The browser sends the `File` object
// straight through.
//
// Everything about the picture is decided by the same code that handles an
// attachment: the same format allowlist, the same EXIF stripping, the same
// renditions, the same content-addressed id. The only difference in the stored
// record is `addedAt`, and it is there to answer two questions -- whether a
// re-render may drop this picture, and whether an owner may.
//
// **No address is recorded on the photo.** `photos` is projected to every
// reader verbatim, and an archive can have several owners; stamping one of
// their email addresses onto a picture would publish it.
//
// **And no `If-Match`.** Every other write here replaces a document the
// browser composed from a copy of the site, which is why they carry the
// staleness claim. These two do not: one appends an entry whose id is the hash
// of the bytes, the other names a single id to drop. Neither can undo an edit
// it never saw, and enforcing it would break the ordinary case of adding two
// pictures in a row -- the first one moves the ETag the second was holding.
const TOO_MANY = 'this letter already has as many added pictures as it can hold';
const MAX_ADDED = 24;

export async function addPhoto({ request, context, store }) {
    const gated = await ownerOnly(request, context, store);
    if (gated.denied) return gated.denied;

    const { postId } = request.params;

    // Checked before a byte is decoded. `sharp` sniffs the container itself,
    // so this is not the security boundary -- it is how a browser that sent a
    // PDF gets told what went wrong instead of "that picture could not be
    // read".
    if (!isPhotoType(request.headers.get('content-type'))) {
        return problem(415, 'that is not a kind of picture this site can show');
    }

    const bytes = Buffer.from(await request.arrayBuffer());
    if (!bytes.length) return problem(400, 'no picture was sent');
    if (bytes.length > MAX_UPLOAD_BYTES) {
        return problem(413, 'that picture is too large to add');
    }

    // Read from the copy the gate already loaded. Both of these are refusals,
    // and refusing before spending a transcode on bytes that cannot be stored
    // is the whole reason to look.
    const existing = (gated.posts ?? []).find((post) => post.id === postId);
    if (!existing) return problem(404, 'no such post');
    if ((existing.photos ?? []).filter((photo) => photo.addedAt).length >= MAX_ADDED) {
        return problem(409, TOO_MANY);
    }

    // Before `commitPosts`, never inside it: its `mutate` is called
    // synchronously and may be called more than once, so a transcode in there
    // would return a promise the error check would sail straight past.
    const stored = await storePhoto({ store, slug: gated.slug, bytes });
    if (!stored) return problem(415, 'that picture could not be read');

    const photo = { ...stored, addedAt: new Date().toISOString() };
    let added = false;

    const outcome = await commitPosts({
        store,
        slug: gated.slug,
        log: context,
        mutate: (posts) => {
            const index = posts.findIndex((post) => post.id === postId);
            if (index < 0) return { error: 'not found' };

            const photos = posts[index].photos ?? [];
            // The id is the hash of the bytes, so adding a picture the letter
            // already carries is a no-op rather than a duplicate -- and that
            // covers the double-click as well as the honest mistake.
            if (photos.some((entry) => entry.id === photo.id)) return { posts };

            if (photos.filter((entry) => entry.addedAt).length >= MAX_ADDED) {
                return { error: TOO_MANY };
            }

            added = true;
            const next = [...posts];
            next[index] = { ...next[index], photos: [...photos, photo] };
            return { posts: next };
        }
    });

    if (outcome.error) {
        if (outcome.error === 'not found') return problem(404, 'no such post');
        return problem(409, outcome.error);
    }

    context.log('post.photoAdded', { slug: gated.slug, postId, photo: photo.id, added });
    return ok({ id: postId, photo: photo.id, added });
}

// Taking one back out.
//
// Only pictures that were added here. A picture that came with the letter is
// part of what the missionary sent, and removing one of those is a restore
// away from being unrecoverable -- so it stays under `Restore original`, which
// asks first and says what it is about to discard.
//
// The renditions are left in `rendered/`, exactly as a deleted post's are:
// they are content-addressed, so another letter quoting the same picture is
// pointing at the same blob, and a photo nothing lists is already unfetchable
// because `photoIsVisible` resolves ids by scanning the posts.
const NOT_YOURS = 'that picture came with the letter';

export async function removePhoto({ request, context, store }) {
    const gated = await ownerOnly(request, context, store);
    if (gated.denied) return gated.denied;

    const { postId, photoId } = request.params;

    let removed = false;

    const outcome = await commitPosts({
        store,
        slug: gated.slug,
        log: context,
        mutate: (posts) => {
            const index = posts.findIndex((post) => post.id === postId);
            if (index < 0) return { error: 'not found' };

            const photos = posts[index].photos ?? [];
            const target = photos.find((entry) => entry.id === photoId);
            // Idempotent on the way out, same as deleting a post: a repeated
            // request is a double-click, and a 404 for the second one would
            // make a successful removal look like a failure.
            if (!target) return { posts };
            if (!target.addedAt) return { error: NOT_YOURS };

            removed = true;
            const next = [...posts];
            next[index] = {
                ...next[index],
                photos: photos.filter((entry) => entry.id !== photoId)
            };
            return { posts: next };
        }
    });

    if (outcome.error) {
        if (outcome.error === 'not found') return problem(404, 'no such post');
        if (outcome.error === NOT_YOURS) return problem(403, NOT_YOURS);
        return problem(400, outcome.error);
    }

    context.log('post.photoRemoved', { slug: gated.slug, postId, photo: photoId, removed });
    return ok({ id: postId, photo: photoId, removed });
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

app.http('addPostPhoto', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'posts/{slug}/{postId}/photos',
    handler: (request, context) => addPhoto({ request, context, store: blobStore() })
});

app.http('removePostPhoto', {
    authLevel: 'anonymous',
    methods: ['DELETE'],
    route: 'posts/{slug}/{postId}/photos/{photoId}',
    handler: (request, context) => removePhoto({ request, context, store: blobStore() })
});

app.http('deletePost', {
    authLevel: 'anonymous',
    methods: ['DELETE'],
    route: 'posts/{slug}/{postId}',
    handler: remove
});

app.http('restorePost', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'posts/{slug}/{postId}/restore',
    handler: restore
});
