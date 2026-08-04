// The reader.
//
// Deliberately small and dependency-free apart from the vendored search index:
// no framework, no build step, no bundler. The whole archive arrives in one
// request and everything below is rendering.

import MiniSearch from '/vendor/minisearch.js';

const state = document.getElementById('state');
const list = document.getElementById('posts');
const title = document.getElementById('site-title');
const searchForm = document.getElementById('search');
const searchInput = document.getElementById('q');
const searchCount = document.getElementById('search-count');

// The slug is the first path segment. Everything else about the site --
// including whether it exists at all -- is decided by the API.
const slug = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[0] ?? '');

const show = (message) => {
    state.textContent = message;
    state.hidden = false;
};

// Dates arrive already expressed in the missionary's own offset and carry no
// timezone, so they are split rather than parsed. Handing the string to Date
// would re-interpret it in the reader's zone and shift the day for anyone
// reading from a different continent -- which is most of the audience.
function formatDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
    if (!match) return '';
    const [, year, month, day] = match;
    return new Date(Date.UTC(+year, +month - 1, +day)).toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'UTC'
    });
}

const photoSrc = (photoId, size) =>
    `/api/photo/${encodeURIComponent(slug)}/${encodeURIComponent(photoId)}/${size}.webp`;

function renderBody(post) {
    const body = document.createElement('div');
    body.className = 'post__body';

    if (post.bodyHtml) {
        // Assigned as markup on purpose. This HTML was sanitized server-side by
        // sanitize.js before it was ever stored -- scripts, event handlers,
        // remote images and the quoted header block are all gone by now. That
        // sanitizer is the security boundary; re-parsing here would only give
        // a second, weaker opinion.
        body.innerHTML = post.bodyHtml;
    } else {
        // A letter that never rendered still has its plain text. Set as text,
        // so it is escaped by the DOM rather than by us.
        body.textContent = post.bodyText ?? '';
    }
    return body;
}

// Photos that the letter already displays inline are not repeated underneath
// it. Only the ones that arrived attached but unreferenced become an album.
function renderAlbum(post) {
    const inline = post.bodyHtml ?? '';
    const loose = (post.photos ?? []).filter((photo) => !inline.includes(photo.id));
    if (!loose.length) return null;

    const album = document.createElement('ul');
    album.className = 'album';

    for (const photo of loose) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = photoSrc(photo.id, 'large');

        const img = document.createElement('img');
        img.src = photoSrc(photo.id, 'thumb');
        img.alt = '';
        img.loading = 'lazy';
        // Reserving the space stops the page from jumping as photos arrive.
        if (photo.width && photo.height) {
            img.width = photo.width;
            img.height = photo.height;
        }

        link.append(img);
        item.append(link);
        album.append(item);
    }
    return album;
}

function renderPost(post) {
    const item = document.createElement('li');
    item.className = 'post';

    // Owners see held letters; readers never receive them at all. The badge
    // exists so an owner can tell at a glance which is which.
    if (post.hidden) {
        const badge = document.createElement('p');
        badge.className = 'badge';
        badge.textContent = `Held for review — ${post.heldReason ?? 'unknown reason'}`;
        item.append(badge);
    }

    const date = document.createElement('p');
    date.className = 'post__date';
    date.textContent = formatDate(post.originalDate);

    const subject = document.createElement('h2');
    subject.className = 'post__subject';
    subject.textContent = post.subject || 'Untitled';

    item.append(date, subject, renderBody(post));

    const album = renderAlbum(post);
    if (album) item.append(album);

    if (post.linkedPhotoServices?.length) {
        const note = document.createElement('p');
        note.className = 'note';
        note.textContent = 'This letter links to a shared photo album.';
        item.append(note);
    }

    return item;
}

async function load() {
    if (!slug) {
        show('No archive was named in this address.');
        return;
    }

    let response;
    try {
        // `manual` because Static Web Apps answers an expired session with a
        // 302 to the login page, not a 401. Followed automatically, that
        // redirect lands on Microsoft's cross-origin sign-in page and fetch
        // reports an opaque failure that is indistinguishable from the network
        // being down. Left unfollowed, it is unmistakable.
        response = await fetch(`/api/content/${encodeURIComponent(slug)}/posts.json`, {
            redirect: 'manual'
        });
    } catch {
        show('Could not reach the archive. Check your connection and try again.');
        return;
    }

    if (response.status === 401 || response.type === 'opaqueredirect') {
        // The session expired mid-visit. Send them back through login and
        // return them to the page they were actually reading.
        window.location.assign(
            `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(window.location.pathname)}`
        );
        return;
    }

    if (!response.ok) {
        // 404 covers both "no such archive" and "not yours" -- the API refuses
        // to tell them apart, so neither can this message.
        show('This archive is not available to you.');
        return;
    }

    const payload = await response.json();
    title.textContent = payload.slug;
    document.title = `${payload.slug} — P-Day Letters`;

    if (!payload.posts.length) {
        show('No letters have arrived yet.');
        return;
    }

    list.append(...payload.posts.map(renderPost));
    state.hidden = true;
    setUpSearch(payload.posts);
}

// Search runs entirely in the browser over the payload already in memory.
// Nothing is sent back, which means a half-typed search for a grandchild's
// name never leaves the device and there is no query log to protect.
function setUpSearch(posts) {
    // The body is HTML by the time it reaches us. Parsed with the template
    // element rather than a regex, because a regex over markup would index
    // tag names and attribute values as if they were words in the letter.
    const textOf = (post) => {
        if (!post.bodyHtml) return post.bodyText ?? '';
        const scratch = document.createElement('template');
        scratch.innerHTML = post.bodyHtml;
        return scratch.content.textContent ?? '';
    };

    const index = new MiniSearch({
        fields: ['subject', 'body'],
        storeFields: ['id']
    });

    index.addAll(
        posts.map((post) => ({ id: post.id, subject: post.subject ?? '', body: textOf(post) }))
    );

    const nodes = new Map();
    for (const [i, post] of posts.entries()) nodes.set(post.id, list.children[i]);

    const apply = () => {
        const query = searchInput.value.trim();

        if (!query) {
            for (const node of nodes.values()) node.hidden = false;
            searchCount.textContent = '';
            return;
        }

        // Prefix and fuzzy matching both on: the audience types partial words
        // and misspells place names, and an archive this small can afford a
        // generous match far better than it can afford an empty result.
        const hits = new Set(
            index.search(query, { prefix: true, fuzzy: 0.2 }).map((hit) => hit.id)
        );

        for (const [id, node] of nodes) node.hidden = !hits.has(id);

        searchCount.textContent =
            hits.size === 0
                ? 'No letters match that.'
                : `${hits.size} of ${posts.length} letters match.`;
    };

    searchInput.addEventListener('input', apply);
    searchForm.addEventListener('submit', (event) => event.preventDefault());
    searchForm.hidden = false;
}

load();
