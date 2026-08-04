// Rendering and search for an archive of letters.
//
// This file is the whole reader, and it is deliberately ignorant of where the
// letters came from. The hosted site fetches them from the API; the downloaded
// zip has them embedded in a script tag beside it. Both then call mount() with
// the same shape, so the offline copy is not a second implementation that has
// to be kept in step -- it is this file, byte for byte, opened from a folder.
//
// A classic script rather than a module, for the same reason the vendored
// MiniSearch is the UMD build: browsers will not load ES modules over file://.
//
// No framework, no build step, no bundler.

/* global MiniSearch */

window.Reader = (function () {
    'use strict';

    // Dates arrive already expressed in the missionary's own offset and carry
    // no timezone, so they are split rather than parsed. Handing the string to
    // Date would re-interpret it in the reader's zone and shift the day for
    // anyone reading from a different continent -- which is most of the
    // audience.
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

    // Photo URLs are baked into bodyHtml by the server-side sanitizer as
    // absolute /api/photo/... paths, which resolve on the site and resolve
    // nowhere at all inside a downloaded folder. Rather than rewriting the
    // stored HTML -- which would make the exported posts.json differ from the
    // one the API serves, and give the two copies room to drift -- the img
    // elements are repointed here, after parsing, using whatever scheme the
    // caller supplied.
    const API_PREFIX = '/api/photo/';

    function repointPhotos(root, photoSrc) {
        for (const img of root.querySelectorAll('img')) {
            // getAttribute, not .src: the property resolves against the
            // document, so on file:// it would already have been mangled into
            // an absolute path that no longer starts with the prefix.
            const raw = img.getAttribute('src') ?? '';
            if (!raw.startsWith(API_PREFIX)) continue;

            const parts = raw.slice(API_PREFIX.length).split('/');
            if (parts.length !== 3) continue;

            const photoId = decodeURIComponent(parts[1]);
            const size = parts[2].replace(/\.webp$/, '');
            img.setAttribute('src', photoSrc(photoId, size));

            // Set here rather than in the stored markup, because the stored
            // markup for letters already in the archive would not get it
            // without a re-render. Two dozen letters carry roughly thirteen
            // megabytes of full-size WebP between them, and without this the
            // browser reaches for all of it before the reader can show a
            // single word. Images near the top still load immediately.
            img.setAttribute('loading', 'lazy');
            img.setAttribute('decoding', 'async');
        }
    }

    function renderBody(post, photoSrc) {
        const body = document.createElement('div');
        body.className = 'post__body';

        if (post.bodyHtml) {
            // Assigned as markup on purpose. This HTML was sanitized
            // server-side by sanitize.js before it was ever stored -- scripts,
            // event handlers, remote images and the quoted header block are all
            // gone by now. That sanitizer is the security boundary; re-parsing
            // here would only give a second, weaker opinion.
            body.innerHTML = post.bodyHtml;
            repointPhotos(body, photoSrc);
        } else {
            // A letter that never rendered still has its plain text. Set as
            // text, so it is escaped by the DOM rather than by us.
            body.textContent = post.bodyText ?? '';
        }
        return body;
    }

    // Photos the letter already displays inline are not repeated underneath
    // it. Only the ones that arrived attached but unreferenced become an album.
    function renderAlbum(post, photoSrc) {
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
            img.decoding = 'async';
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

    function renderPost(post, photoSrc) {
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

        item.append(date, subject, renderBody(post, photoSrc));

        const album = renderAlbum(post, photoSrc);
        if (album) item.append(album);

        if (post.linkedPhotoServices?.length) {
            const note = document.createElement('p');
            note.className = 'note';
            note.textContent = 'This letter links to a shared photo album.';
            item.append(note);
        }

        return item;
    }

    // The body is HTML by the time it reaches us. Parsed with the template
    // element rather than a regex, because a regex over markup would index tag
    // names and attribute values as if they were words in the letter.
    function textOf(post) {
        if (!post.bodyHtml) return post.bodyText ?? '';
        const scratch = document.createElement('template');
        scratch.innerHTML = post.bodyHtml;
        return scratch.content.textContent ?? '';
    }

    // Search runs entirely in the browser over the payload already in memory.
    // Nothing is sent back, which means a half-typed search for a grandchild's
    // name never leaves the device and there is no query log to protect. It is
    // also what lets the downloaded copy search at all, with no backend.
    function setUpSearch(posts, nodes, elements) {
        const { searchForm, searchInput, searchCount } = elements;
        if (!searchForm || !searchInput) return;

        const index = new MiniSearch({
            fields: ['subject', 'body'],
            storeFields: ['id']
        });

        index.addAll(
            posts.map((post) => ({
                id: post.id,
                subject: post.subject ?? '',
                body: textOf(post)
            }))
        );

        const apply = () => {
            const query = searchInput.value.trim();

            if (!query) {
                for (const node of nodes.values()) node.hidden = false;
                if (searchCount) searchCount.textContent = '';
                return;
            }

            // Prefix and fuzzy matching both on: the audience types partial
            // words and misspells place names, and an archive this small can
            // afford a generous match far better than it can afford an empty
            // result.
            const hits = new Set(
                index.search(query, { prefix: true, fuzzy: 0.2 }).map((hit) => hit.id)
            );

            for (const [id, node] of nodes) node.hidden = !hits.has(id);

            if (searchCount) {
                searchCount.textContent =
                    hits.size === 0
                        ? 'No letters match that.'
                        : `${hits.size} of ${posts.length} letters match.`;
            }
        };

        searchInput.addEventListener('input', apply);
        searchForm.addEventListener('submit', (event) => event.preventDefault());
        searchForm.hidden = false;
    }

    /**
     * Draw an archive and wire up its search.
     *
     * @param {object} options
     * @param {Array} options.posts   the presented posts, newest first
     * @param {Function} options.photoSrc  (photoId, size) => url
     * @param {object} options.elements    the page's list, state and search nodes
     */
    function mount({ posts, photoSrc, elements }) {
        const { list, state } = elements;

        if (!posts.length) {
            state.textContent = 'No letters have arrived yet.';
            state.hidden = false;
            return;
        }

        const nodes = new Map();
        for (const post of posts) {
            const node = renderPost(post, photoSrc);
            nodes.set(post.id, node);
            list.append(node);
        }

        state.hidden = true;
        setUpSearch(posts, nodes, elements);
    }

    return { mount, formatDate };
})();
