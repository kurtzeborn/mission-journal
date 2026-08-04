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

            // Kept so an owner's edit can put back exactly what was stored.
            // On the website the repointed URL happens to be identical to the
            // stored one, so reading the edited markup straight back would
            // work today -- and would break silently the day photoSrc returns
            // anything else, because the server's sanitizer drops an <img>
            // whose src it does not recognize. That is how an edit deletes
            // every picture in a letter, and it is not worth risking twice.
            img.setAttribute('data-photo', raw);
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

    // Separate from renderBody because cancelling an edit has to redraw the
    // letter from the copy the page loaded, throwing away whatever was typed.
    function fillBody(body, post, photoSrc) {
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
    }

    function renderBody(post, photoSrc) {
        const body = document.createElement('div');
        body.className = 'post__body';
        fillBody(body, post, photoSrc);
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

    function renderPost(post, photoSrc, admin) {
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

        const body = renderBody(post, photoSrc);
        item.append(date, subject, body);

        const album = renderAlbum(post, photoSrc);
        if (album) item.append(album);

        if (post.linkedPhotoServices?.length) {
            const note = document.createElement('p');
            note.className = 'note';
            note.textContent = 'This letter links to a shared photo album.';
            item.append(note);
        }

        if (admin) item.append(renderAdmin(post, admin, { subject, body, photoSrc }));

        return item;
    }

    // The only formatting on offer. Each produces a tag the sanitizer already
    // allows, so nothing an owner can type here is thrown away on save.
    const HOTKEYS = { b: 'bold', i: 'italic', u: 'underline' };

    // Owner controls.
    //
    // Drawn only when the caller supplied an `admin` object, which the hosted
    // page does for owners and the downloaded archive never does -- there is no
    // API behind a folder on a disk, so a Hide button there could only fail.
    //
    // The letter is edited where it sits rather than in a box of markup
    // beside it. The audience for these controls is a parent, not someone who
    // reads HTML, and the only edits anyone actually wants -- fix a typo, cut
    // a paragraph, take out a name, remove a photo -- are all things you do by
    // pointing at them. Formatting is left to the browser's own shortcuts
    // (Ctrl/Cmd+B, I, U); there is no toolbar to learn.
    //
    // Nothing here is a security boundary. Whatever the browser produces goes
    // to the server and through the same sanitizer as a stranger's forwarded
    // email, which is why a rich editor costs nothing in trust: every style,
    // class and font it might invent is stripped there, and the empty blocks
    // contenteditable scaffolds with are removed by the same pass that cleans
    // up after Outlook.
    function renderAdmin(post, admin, view) {
        const { subject: heading, body, photoSrc } = view;

        const bar = document.createElement('div');
        bar.className = 'admin';

        const status = document.createElement('span');
        status.className = 'admin__status';
        status.setAttribute('role', 'status');

        const button = (label, extra) => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = extra ? `admin__button ${extra}` : 'admin__button';
            el.textContent = label;
            return el;
        };

        // A successful action reloads the page, so anything this puts on screen
        // is a failure the owner needs to read.
        const run = async (working, action) => {
            status.textContent = working;
            status.textContent = (await action()) ?? '';
        };

        const hide = button(post.hidden ? 'Unhide' : 'Hide');
        const edit = button('Edit');
        const remove = button('Delete');
        const save = button('Save', 'admin__button--primary');
        const cancel = button('Cancel');

        // The subject stays a field of its own. It is a single line that has
        // to survive as one, and an editable heading invites a paragraph
        // break that the data model has nowhere to put.
        const field = document.createElement('input');
        field.type = 'text';
        field.className = 'admin__subject';
        field.setAttribute('aria-label', 'Subject');
        heading.insertAdjacentElement('afterend', field);

        const showEditing = (editing) => {
            for (const el of [hide, edit, remove]) el.hidden = editing;
            for (const el of [save, cancel]) el.hidden = !editing;
            heading.hidden = editing;
            field.hidden = !editing;
            body.classList.toggle('post__body--editing', editing);
        };

        const open = () => {
            field.value = post.subject ?? '';
            body.setAttribute('contenteditable', 'true');
            body.setAttribute('role', 'textbox');
            body.setAttribute('aria-multiline', 'true');
            body.setAttribute('aria-label', 'Letter');
            showEditing(true);

            // Ask for <b> and <i> rather than styled spans. The sanitizer
            // allows the tags and strips every style attribute, so a browser
            // that ignored this would drop the owner's formatting on save
            // without saying anything. Deprecated, hence the guard, but it is
            // the only control over this that exists.
            try {
                document.execCommand('styleWithCSS', false, false);
            } catch {
                // Not supported here; the browser's default is what we wanted.
            }

            body.focus();
        };

        const close = () => {
            body.removeAttribute('contenteditable');
            body.removeAttribute('role');
            body.removeAttribute('aria-multiline');
            body.removeAttribute('aria-label');
            showEditing(false);
            status.textContent = '';
        };

        const discard = () => {
            // Redrawn from the copy the page loaded rather than left as typed,
            // so Cancel means cancel.
            fillBody(body, post, photoSrc);
            close();
        };

        // What to send. Read from a clone so restoring the stored photo URLs
        // does not disturb what the owner is looking at, and so a failed save
        // leaves the page exactly as it was.
        const markup = () => {
            const scratch = body.cloneNode(true);
            for (const img of scratch.querySelectorAll('img[data-photo]')) {
                img.setAttribute('src', img.getAttribute('data-photo'));
                img.removeAttribute('data-photo');
                img.removeAttribute('loading');
                img.removeAttribute('decoding');
            }
            return scratch.innerHTML;
        };

        const commit = () =>
            run('Saving…', () =>
                admin.patch(post.id, { subject: field.value, bodyHtml: markup() })
            );

        hide.addEventListener('click', () =>
            run('Saving…', () => admin.patch(post.id, { hidden: !post.hidden }))
        );

        edit.addEventListener('click', open);
        cancel.addEventListener('click', discard);
        save.addEventListener('click', commit);

        remove.addEventListener('click', () => {
            if (!admin.confirmDelete(post)) return;
            run('Deleting…', () => admin.remove(post.id));
        });

        // Escape backs out of an edit begun by accident. Enter commits from
        // the subject line, where a newline has no meaning anyway; inside the
        // letter it starts a paragraph, as it should.
        field.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commit();
            }
        });

        for (const el of [field, body]) {
            el.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') discard();
            });
        }

        // Formatting is bound here rather than left to the browser, which
        // sounds like the same thing and is not. Some environments never fire
        // their own editing command for these chords at all -- measured, not
        // assumed -- and the ones that do have historically produced styled
        // spans instead of tags, which the sanitizer strips on the way in. In
        // both cases the owner presses the key, sees nothing wrong, saves, and
        // finds the formatting gone with nothing to explain it. Doing it
        // ourselves makes the result the same everywhere, and it is still the
        // shortcut people already know rather than a toolbar to learn.
        body.addEventListener('keydown', (event) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
            const command = HOTKEYS[event.key.toLowerCase()];
            if (!command) return;
            event.preventDefault();
            document.execCommand(command);
        });

        // Clicking a picture only puts the caret beside it -- measured, not
        // assumed -- so Delete does nothing and the owner is left prodding at
        // a photo that will not go away. Select the image itself instead. That
        // is what the pointer cursor promises, and taking a photo out is one
        // of the few edits anyone actually asks for.
        body.addEventListener('click', (event) => {
            if (event.target.tagName !== 'IMG') return;
            if (body.getAttribute('contenteditable') !== 'true') return;
            const range = document.createRange();
            range.selectNode(event.target);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        });

        showEditing(false);
        bar.append(hide, edit, remove, save, cancel, status);
        return bar;
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
     * @param {object|null} [options.admin] owner controls, when the caller has
     *   somewhere to send them. Absent in the downloaded archive.
     */
    function mount({ posts, photoSrc, elements, admin = null }) {
        const { list, state } = elements;

        if (!posts.length) {
            state.textContent = 'No letters have arrived yet.';
            state.hidden = false;
            return;
        }

        const nodes = new Map();
        for (const post of posts) {
            const node = renderPost(post, photoSrc, admin);
            nodes.set(post.id, node);
            list.append(node);
        }

        state.hidden = true;
        setUpSearch(posts, nodes, elements);
    }

    return { mount, formatDate };
})();
