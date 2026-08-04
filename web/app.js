// The reader.
//
// Deliberately small and dependency-free: no framework, no build step, no
// bundler. The whole archive arrives in one request and everything below is
// rendering. Search comes later and will be added the same way.

const state = document.getElementById('state');
const list = document.getElementById('posts');
const title = document.getElementById('site-title');

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
        response = await fetch(`/api/content/${encodeURIComponent(slug)}/posts.json`);
    } catch {
        show('Could not reach the archive. Check your connection and try again.');
        return;
    }

    if (response.status === 401) {
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
}

load();
