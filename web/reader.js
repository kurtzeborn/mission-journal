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

    // The stored src carries the photo's id and size. Both are needed again
    // later -- the id to ask for the large rendition when somebody clicks,
    // the size to know which one is on screen -- so the parse lives here
    // rather than being repeated at each site.
    function photoRefOf(raw) {
        if (!raw || !raw.startsWith(API_PREFIX)) return null;

        const parts = raw.slice(API_PREFIX.length).split('/');
        if (parts.length !== 3) return null;

        return {
            raw,
            id: decodeURIComponent(parts[1]),
            size: parts[2].replace(/\.webp$/, '')
        };
    }

    // --- deferred pictures -------------------------------------------------
    //
    // A photograph inside a closed letter is not fetched at all. Its URL waits
    // in `data-src` until `setExpanded` opens the panel it is in.
    //
    // `loading="lazy"` alone does not do this, which is worth writing down
    // because it looks like it should. The sanitizer strips width and height
    // from stored markup, so an <img> that has not loaded yet is zero pixels
    // high; a hundred of them stack into a document shorter than the screen,
    // every one lands inside the browser's lazy threshold, and the archive is
    // fetched in a single burst. That was happening: one page load pulled
    // ninety full-size photographs, for one open letter that wanted five.

    const photoUrl = (img) => img.getAttribute('src') ?? img.getAttribute('data-src');

    // Writes to whichever of the two the image is currently using, so code
    // that re-points a photo need not know whether it has been opened yet.
    const setPhotoUrl = (img, url) =>
        img.setAttribute(img.hasAttribute('src') ? 'src' : 'data-src', url);

    function loadPhotos(root) {
        for (const img of root.querySelectorAll('img[data-src]')) {
            img.setAttribute('src', img.getAttribute('data-src'));
            img.removeAttribute('data-src');
        }
    }

    function repointPhotos(root, photoSrc) {
        for (const img of root.querySelectorAll('img')) {
            // getAttribute, not .src: the property resolves against the
            // document, so on file:// it would already have been mangled into
            // an absolute path that no longer starts with the prefix.
            const ref = photoRefOf(img.getAttribute('src'));
            if (!ref) continue;

            // Kept so an owner's edit can put back exactly what was stored.
            // On the website the repointed URL happens to be identical to the
            // stored one, so reading the edited markup straight back would
            // work today -- and would break silently the day photoSrc returns
            // anything else, because the server's sanitizer drops an <img>
            // whose src it does not recognize. That is how an edit deletes
            // every picture in a letter, and it is not worth risking twice.
            img.setAttribute('data-photo', ref.raw);

            // Two dozen letters carry roughly thirteen megabytes of full-size
            // WebP between them, and none of it is wanted until one is opened.
            img.removeAttribute('src');
            img.setAttribute('data-src', photoSrc(ref.id, ref.size));

            // For the pictures in a letter that is open: `data-src` decides
            // whether a photo loads, these decide when. Set here rather than
            // in the stored markup, which letters already in the archive would
            // not get without a re-render.
            img.setAttribute('loading', 'lazy');
            img.setAttribute('decoding', 'async');
        }
    }

    // --- the lightbox -----------------------------------------------------
    //
    // One dialog for the whole page, created the first time somebody asks for
    // it. Both the pictures inside a letter and the album beneath it open it,
    // which is the point: before this, an inline photo could not be enlarged
    // at all and an album thumbnail navigated away from the archive to a bare
    // image URL, leaving the reader to find their way back.
    //
    // Every photo click lands here, on the website as well as in the zip. The
    // slideshow is a different question -- "show me the photographs" rather
    // than "show me this one bigger" -- and is reached from its own button and
    // nowhere else, so that tapping a picture in a letter does not sweep the
    // letter away.
    //
    // A real <dialog> rather than a div pretending to be one. It gets focus
    // trapping, Escape, inertness of the page behind it and a backdrop for
    // free, all of which are tedious and easy to get subtly wrong by hand, and
    // none of which needs a server -- so it works from file:// like the rest.
    let lightbox = null;

    function ensureLightbox() {
        if (lightbox) return lightbox;

        const dialog = document.createElement('dialog');
        dialog.className = 'lightbox';

        const image = document.createElement('img');
        image.className = 'lightbox__image';
        image.alt = '';

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'lightbox__close';
        // A label, not an icon glyph: the archive renders from a folder with
        // no icon font, and a bare X is invisible to a screen reader anyway.
        close.textContent = 'Close';

        close.addEventListener('click', () => dialog.close());

        // Belt and braces over the dialog element's own Escape handling.
        // Escape is the one way out of a full-screen photo that everybody
        // already knows, and the cost of not relying on the browser for it is
        // two lines. If the browser handles it too, this closes an already
        // closing dialog, which is a no-op.
        dialog.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') dialog.close();
        });

        // Clicking away from the picture closes it, which is what every other
        // image viewer does. The test is against the dialog itself rather
        // than a backdrop element, because the ::backdrop pseudo-element
        // cannot receive a listener -- a click on the dark area is reported
        // as a click on the dialog box.
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });

        // Dropping the src on close stops a large photo from sitting in
        // memory, and stops the previous picture from flashing up for a frame
        // the next time the dialog opens.
        dialog.addEventListener('close', () => {
            image.removeAttribute('src');
        });

        dialog.append(image, close);
        document.body.append(dialog);

        lightbox = { dialog, image };
        return lightbox;
    }

    function openLightbox(src, alt) {
        const view = ensureLightbox();
        view.image.src = src;
        view.image.alt = alt ?? '';
        view.dialog.showModal();
    }

    // --- inline photos ----------------------------------------------------
    //
    // A photo the missionary pasted into the letter arrives as a plain <img>
    // and, left alone, renders full width: it breaks the column, pushes the
    // paragraphs apart, and says nothing about being clickable. Wrapping it
    // in a button gives it three things it cannot have on its own -- a float
    // the text can wrap around, a visible "View larger" affordance, and
    // keyboard access, since an <img> is not focusable and a click handler on
    // one is reachable by mouse only.
    //
    // The wrapper is presentation, so it is added here rather than stored.
    // Nothing that goes back to the server ever sees it: `open()` strips it
    // before the owner starts editing, and `markup()` strips it again from
    // the copy it sends, because a save that shipped these buttons into the
    // stored HTML would have them sanitized away on the round trip and take
    // the photos with them.
    const PHOTO_FRAME = 'photo';
    const PHOTO_ROW = 'photo-row';

    // Roughly three lines of the column beside a picture. Under this there is
    // not enough letter left to wrap and the float stops paying for itself.
    const FLOW_MIN = 250;

    // Characters of letter after each photo, up to the next photo or the end.
    //
    // A float is only worth having when there is prose to flow around it. Two
    // photos with a caption between them -- which is how most people paste a
    // burst of pictures -- put two floats side by side and squeeze the text
    // between them to about sixteen characters on a desktop, which is a ladder
    // of single words rather than a paragraph. Measuring first is what lets
    // the second picture opt out of floating instead of ruining the column.
    //
    // The walk steps over the frames' own contents, so that anything this file
    // ever puts inside one is counted as the frame rather than as the letter.
    // A photo must never be credited with room it does not have.
    function textAfter(root, frames) {
        const counts = frames.map(() => 0);
        if (!frames.length) return counts;

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
        );

        let at = -1;
        let node = walker.nextNode();
        while (node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.classList.contains(PHOTO_FRAME)) {
                    at += 1;
                    let next = walker.nextNode();
                    while (next && node.contains(next)) next = walker.nextNode();
                    node = next;
                    continue;
                }
            } else if (at >= 0) {
                counts[at] += node.data.trim().length;
            }
            node = walker.nextNode();
        }

        return counts;
    }

    function decoratePhotos(root, photoSrc) {
        for (const img of root.querySelectorAll('img[data-photo]')) {
            if (img.parentElement?.classList.contains(PHOTO_FRAME)) continue;

            const ref = photoRefOf(img.getAttribute('data-photo'));
            if (!ref) continue;

            const frame = document.createElement('button');
            frame.type = 'button';
            frame.className = PHOTO_FRAME;
            frame.dataset.large = photoSrc(ref.id, 'large');

            // The label is for assistive technology only -- sighted readers
            // get the zoom cursor, and a caption printed over every picture in
            // the archive was more clutter than invitation. It cannot simply
            // be dropped, though: this is a <button> whose only content is an
            // image with empty alt text, and without a name here a screen
            // reader announces it as "button" and stops.
            frame.setAttribute('aria-label', 'View larger');

            img.replaceWith(frame);
            frame.append(img);
        }

        // After the frames exist, not during: the measurement counts the text
        // between one frame and the next, so they all have to be in place.
        const frames = [...root.querySelectorAll(`.${PHOTO_FRAME}`)];
        const room = textAfter(root, frames);
        frames.forEach((frame, i) => {
            frame.classList.toggle('photo--block', room[i] < FLOW_MIN);
        });

        groupRuns(root, frames, room, photoSrc);
    }

    // Photos with nothing at all between them are a burst, not a sequence of
    // illustrations, and stacking them full width turns the end of a letter
    // into one picture per screen. Real letters do this constantly -- more
    // than half of them end with two to four photos and no text -- so the run
    // is collected into the same scrolling row the album at the foot of the
    // letter uses. The photos do not move relative to the words; the run just
    // stops being a column and becomes a line.
    //
    // Strictly no text, not "almost none". A caption is the one thing that
    // must not be swallowed, and the difference between a caption and a stray
    // non-breaking space is not something a character count can be trusted to
    // judge.
    function groupRuns(root, frames, room, photoSrc) {
        let start = 0;
        while (start < frames.length) {
            let end = start;
            while (end + 1 < frames.length && room[end] === 0) end += 1;
            if (end > start) tile(frames.slice(start, end + 1), photoSrc);
            start = end + 1;
        }
    }

    function tile(run, photoSrc) {
        // A span, not a div: these photos can be sitting inside a paragraph,
        // and a block element there is invalid HTML. The DOM would hold it and
        // it would even render, but nothing else in this file writes markup it
        // would be embarrassed to serialize.
        const row = document.createElement('span');
        row.className = PHOTO_ROW;

        // Everything from the first photo to the last comes out in one piece,
        // rather than the photos being lifted out and the rest left standing.
        // There is no text in there by definition, but there is plenty of
        // markup -- a paragraph around each photo is the common case and a
        // paragraph with <br> between them the next -- and every bit of it
        // still prints as blank space once the pictures have gone. A range is
        // what handles both without knowing which one it is looking at: it
        // splits whatever containers it has to and takes the span between the
        // two photos with it.
        const range = document.createRange();
        range.setStartBefore(run[0]);
        range.setEndAfter(run[run.length - 1]);
        range.extractContents();
        range.insertNode(row);

        for (const frame of run) {
            frame.classList.remove('photo--block');

            // The inline src is sized for a picture in the column, which is
            // several times more image than a tile this size can show. The
            // original is kept rather than recomputed: `data-photo` holds what
            // the stored letter said, which is not necessarily a URL this page
            // can display -- the offline archive resolves photos to relative
            // file paths -- so it is no good for putting things back.
            const img = frame.querySelector('img');
            const ref = photoRefOf(img?.getAttribute('data-photo'));
            if (ref) {
                img.dataset.column = photoUrl(img);
                setPhotoUrl(img, photoSrc(ref.id, 'thumb'));
            }

            row.append(frame);
        }

        // Splitting a container leaves the halves behind, and an empty
        // paragraph is still a blank line. They can only be on the two sides
        // of the row, because that is where the range was.
        prune(row, 'previousSibling');
        prune(row, 'nextSibling');
    }

    // Deliberately a list of things known to be packaging rather than a test
    // for emptiness. An <hr> has no text and no picture either, and sanitize.js
    // goes to some trouble to keep the ones a letter actually contains.
    const PACKAGING = /^(?:P|DIV|SPAN|FONT|BR|B|I|U|EM|STRONG)$/;

    function prune(row, side) {
        let node = row[side];
        while (
            node &&
            node.nodeType === Node.ELEMENT_NODE &&
            PACKAGING.test(node.tagName) &&
            !node.querySelector('img') &&
            !node.textContent.trim()
        ) {
            const next = node[side];
            node.remove();
            node = next;
        }
    }

    function undecoratePhotos(root) {
        // Rows first. Unwrapping puts the photos back in the flow as siblings,
        // which is not quite the markup they arrived in -- the empty wrappers
        // pruned above do not come back -- but they were empty, and an owner
        // who saves an edit is better off storing the flattened version than
        // the blank lines it was hiding.
        for (const row of root.querySelectorAll(`.${PHOTO_ROW}`)) {
            row.replaceWith(...row.childNodes);
        }

        for (const frame of root.querySelectorAll(`.${PHOTO_FRAME}`)) {
            const img = frame.querySelector('img');
            if (img) {
                if (img.dataset.column) {
                    setPhotoUrl(img, img.dataset.column);
                    delete img.dataset.column;
                }
                frame.replaceWith(img);
            } else {
                frame.remove();
            }
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
            decoratePhotos(body, photoSrc);
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

        // Delegated, so it survives the body being refilled on cancel.
        // Editing takes precedence: while the letter is open for editing a
        // click on a picture selects it so it can be deleted, and popping a
        // lightbox over the top of that would make the photo impossible to
        // remove.
        body.addEventListener('click', (event) => {
            if (body.getAttribute('contenteditable') === 'true') return;
            const frame = event.target.closest?.(`.${PHOTO_FRAME}`);
            if (!frame) return;
            openLightbox(frame.dataset.large, frame.querySelector('img')?.alt ?? '');
        });

        return body;
    }

    // Photos the letter already displays inline are not repeated underneath
    // it. Only the ones that arrived attached but unreferenced become an album
    // -- along with any an owner added afterwards, which are appended to the
    // same list and are meant to sit in the same row. A separate group for
    // them would draw a line through the letter's pictures on behalf of a
    // distinction the reader has no use for.
    //
    // One row, uniform tiles, scrolled sideways when it does not fit. A grid
    // that reflowed to the photos' own shapes looked like a pile rather than a
    // set -- a portrait next to a landscape next to a panorama, in rows of
    // whatever happened to fit -- and the eye reads a straight line of equal
    // squares as "here are the pictures" without having to work at it. The
    // cropping that costs is worth it: the full frame is one tap away.
    //
    // No scroll buttons. The links inside are focusable, so tabbing scrolls
    // the row on its own, and every touch device already knows how to swipe.
    function renderAlbum(post, photoSrc, admin) {
        const inline = post.bodyHtml ?? '';
        const loose = (post.photos ?? []).filter((photo) => !inline.includes(photo.id));
        if (!loose.length) return null;

        const album = document.createElement('ul');
        album.className = 'album';

        for (const photo of loose) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.href = photoSrc(photo.id, 'large');
            // An anchor whose only content is an image with empty alt text has
            // no accessible name at all. Same words as the inline frames use.
            link.setAttribute('aria-label', 'View larger');

            const img = document.createElement('img');
            img.dataset.src = photoSrc(photo.id, 'thumb');
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';

            link.append(img);
            item.append(link);

            // Only on the pictures an owner put here, and only for an owner.
            // A picture that came with the letter belongs to the letter, and
            // taking one of those out is what `Restore original` undoes -- so
            // it is not offered next to a thumbnail with nothing to warn about
            // it. `addedAt` is the whole of the distinction, and the server
            // makes it again on the way in.
            //
            // Drawn here and driven from the owner bar, which is where Save
            // and Cancel are. Pressing one of these does not remove anything;
            // it marks the tile, and the mark means nothing until the edit it
            // belongs to is saved. The id travels on the button because that
            // is the only thing the bar gets handed when one is clicked.
            //
            // Built visible and hidden a moment later by the owner bar's
            // `showEditing(false)`, which runs before any of this is in the
            // document. Hiding it here as well would be the same fact written
            // in two places, and the two would eventually disagree.
            if (admin && photo.addedAt) {
                const drop = document.createElement('button');
                drop.type = 'button';
                drop.className = 'album__remove';
                drop.dataset.photo = photo.id;
                drop.textContent = '×';
                drop.title = 'Remove this picture';
                drop.setAttribute('aria-label', 'Remove this picture');
                item.append(drop);
            }

            album.append(item);
        }

        // The href stays real -- it is what "open image in new tab" and a
        // JavaScript-less browser need -- but the ordinary click is taken over
        // by the lightbox, so a reader who wants a closer look at one photo
        // does not lose the letter to get it.
        album.addEventListener('click', (event) => {
            const link = event.target.closest?.('a');
            if (!link || !album.contains(link)) return;
            event.preventDefault();
            openLightbox(link.href, '');
        });

        return album;
    }

    // --- one letter -------------------------------------------------------
    //
    // Every letter is a disclosure: a heading that is also a button, and a
    // panel underneath it. Only the newest is open when the page loads.
    //
    // The archive this was built for runs to two dozen letters of a thousand
    // words each, and rendered flat it is a single unbroken column several
    // meters long -- you cannot see what is in it, and you cannot get to
    // October without scrolling past September. Collapsed, the whole mission
    // fits on one screen as a list of dates and subjects, which is the view
    // people actually asked for.
    //
    // Built from a real <button> and `hidden` rather than a <details>, for two
    // reasons. Search has to be able to open a letter from the outside, and
    // has to be able to count what is inside a closed one -- content in a
    // closed <details> is present but its layout is not, so scrolling to a hit
    // inside one lands in the wrong place. And the summary line wants the date
    // and a photo count next to the subject, which is fussier than a <summary>
    // is comfortable holding.
    function setExpanded(view, open) {
        view.item.classList.toggle('post--open', open);
        view.toggle.setAttribute('aria-expanded', String(open));
        view.panel.hidden = !open;
        // The only place a photograph in a letter starts loading. Closing does
        // not put them back: the bytes are in the cache by then, and dropping
        // the src would only make reopening flash.
        if (open) loadPhotos(view.panel);
        // A letter cannot be open inside a folded month. Everything that opens
        // one from the outside -- a digest link, a search hit, Expand all --
        // goes through here, so this is the only place that has to know.
        if (open && view.group) setFolded(view.group, false);
    }

    function renderPost(post, photoSrc, admin) {
        const item = document.createElement('li');
        item.className = 'post';
        // Read back by search, which finds a mark deep inside a letter and has
        // to get from there to the view that can open it.
        item.dataset.post = post.id;

        // Owners see held letters; readers never receive them at all. Dimmed
        // rather than badged: a full-width banner above every held letter
        // shouted at the owner about the ones they were not reading, and the
        // reason belongs beside the date with the rest of the summary.
        if (post.hidden) item.classList.add('post--hidden');

        const panel = document.createElement('div');
        panel.className = 'post__panel';
        // Ids have to be unique and they have to survive being written into an
        // attribute. Post ids are dates plus a short hash, so they already are.
        panel.id = `panel-${post.id}`;
        panel.hidden = true;

        // The heading wraps the button rather than the other way round: a
        // <button> may only contain phrasing content, so an <h2> inside one is
        // invalid, and screen readers navigating by heading would lose the
        // letters entirely.
        const subject = document.createElement('h2');
        subject.className = 'post__subject';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'post__toggle';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', panel.id);

        const date = document.createElement('span');
        date.className = 'post__date';
        date.textContent = formatDate(post.originalDate);

        const title = document.createElement('span');
        title.className = 'post__title';
        title.textContent = post.subject || 'Untitled';

        const meta = document.createElement('span');
        meta.className = 'post__meta';

        // Dimming says a letter is out of view; it cannot say why, and "why"
        // is the whole of what an owner needs to decide what to do about it.
        if (post.hidden) {
            const held = document.createElement('span');
            held.className = 'post__held';
            held.textContent = `Hidden — ${post.heldReason ?? 'by an owner'}`;
            meta.append(held);
        }

        const photoCount = (post.photos ?? []).length;
        if (photoCount) {
            const photos = document.createElement('span');
            photos.className = 'post__count';
            photos.textContent = photoCount === 1 ? '1 photo' : `${photoCount} photos`;
            meta.append(photos);
        }

        // Filled in by search, emptied when the box is cleared. It lives in
        // the summary line because the question a reader has while scanning a
        // filtered list is "which of these has what I asked for, and how
        // much", and that has to be answerable without opening anything.
        const hits = document.createElement('span');
        hits.className = 'post__hits';
        hits.hidden = true;
        meta.append(hits);

        toggle.append(date, title, meta);
        subject.append(toggle);

        const body = renderBody(post, photoSrc);
        panel.append(body);

        const album = renderAlbum(post, photoSrc, admin);
        if (album) panel.append(album);

        // Assembled before the owner controls are built, because those insert
        // the subject field next to the heading and `insertAdjacentElement`
        // needs the heading to already have a parent to insert alongside.
        item.append(subject, panel);

        if (admin) panel.append(renderAdmin(post, admin, { subject, body, photoSrc, album }));

        const view = { id: post.id, item, toggle, panel, body, title, hits };
        toggle.addEventListener('click', () => {
            setExpanded(view, toggle.getAttribute('aria-expanded') !== 'true');
        });

        return view;
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
        const { subject: heading, body, photoSrc, album } = view;

        // Wraps the row so that the rule separating the letter from its
        // controls sits above everything owner-only, the edited note included.
        const area = document.createElement('div');
        area.className = 'admin__area';

        const bar = document.createElement('div');
        bar.className = 'admin';

        // The row is five glyphs and a menu once the labels come off, which
        // reads as decoration until somebody hovers one of them.
        const label = document.createElement('span');
        label.className = 'admin__label';
        label.textContent = 'Owner tools:';

        // One status line for everything an owner does to this letter. Two of
        // them -- one above the pictures and one below -- would be a message
        // in whichever place the owner happened not to be looking.
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

        // A control with a glyph where its words were. The words themselves do
        // not go anywhere -- they stay as the name a screen reader reads out
        // and as the tooltip a pointer brings up -- so what is lost is only the
        // room five labels took up in a row that has to wrap on a phone.
        const icon = (label, glyph, extra) => {
            const el = button('', extra ? `admin__icon ${extra}` : 'admin__icon');
            el.title = label;
            el.setAttribute('aria-label', label);

            const mark = document.createElement('i');
            mark.className = `fa-solid ${glyph}`;
            mark.setAttribute('aria-hidden', 'true');

            el.append(mark);
            return el;
        };

        // A message ending in an ellipsis is one that has not finished yet,
        // and those are the ones worth animating: the dots come off the text
        // and the stylesheet draws them instead. Anything else has stopped
        // happening and is a sentence to be read, so it stays still.
        const say = (text) => {
            if (!text.endsWith('…')) {
                status.textContent = text;
                return;
            }

            // Kept rather than rebuilt, so a count ticking over from one
            // picture to the next does not restart the dots each time.
            let dots = status.querySelector('.waiting');
            if (!dots) {
                dots = document.createElement('span');
                dots.className = 'waiting';
                status.textContent = '';
                status.append(dots);
            }

            dots.textContent = text.slice(0, -1);
        };

        // A successful action reloads the page, so anything this puts on screen
        // is a failure the owner needs to read. The action is handed `say` as
        // well, for the ones long enough to have something worth reporting
        // before they are done.
        const run = async (working, action) => {
            say(working);
            say((await action(say)) ?? '');
        };

        // Hiding and unhiding are one button and want two glyphs: a bar across
        // the letter for taking it out of view, an open eye for putting it
        // back. One glyph for both would say what state the letter is in
        // without saying which way the button moves it.
        const hide = post.hidden ? icon('Unhide', 'fa-eye') : icon('Hide', 'fa-ban');
        const edit = icon('Edit', 'fa-pencil');
        const remove = icon('Delete', 'fa-trash');
        const save = icon('Save', 'fa-check', 'admin__button--primary');
        const cancel = icon('Cancel', 'fa-xmark');

        // Adding pictures.
        //
        // Deliberately not part of the Edit mode. Everything else in that mode
        // is one save of one document, which either sticks or does not; an
        // upload is several round trips that each either stick or do not, and
        // mixing the two would mean Cancel undoing some of what just happened
        // and none of the rest. So it sits beside Edit rather than inside it,
        // and each picture is committed on its own.
        //
        // Taking a picture off is inside Edit, which looks like the opposite
        // ruling and is the same one. A removal is an id in a list until Save
        // sends it, so nothing has happened for Cancel to fail to undo. An
        // upload cannot be deferred that way: the bytes have to reach the
        // server before anyone knows whether they were a picture.
        //
        // The <input> is the thing that opens the file picker -- a browser
        // will not open one from script without a real click on a real file
        // input -- so it is present and hidden rather than replaced by the
        // button. `accept` is a hint the picker uses to gray out documents;
        // the format allowlist that matters is on the server. The extensions
        // are spelled out beside `image/*` because Windows resolves that
        // wildcard through its registry, which has never heard of any of
        // them, and would otherwise gray out a phone's own photographs.
        const add = button('Add photos');
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = 'image/*,.heic,.heif,.webp,.avif';
        picker.multiple = true;
        picker.hidden = true;
        picker.setAttribute('aria-hidden', 'true');
        picker.tabIndex = -1;

        // Two places a picture can come from, behind one button, because to an
        // owner they are one errand -- side by side in the bar they read as two
        // separate features and crowd the row on a phone.
        //
        // The menu is built only when the page handed the Google call in. The
        // downloaded archive has no owner bar at all, and a site whose Google
        // credentials are not configured hands in nothing, so an entry that
        // could only ever fail is never offered -- and with one source left
        // there is nothing to choose between, so the plain button stands and
        // goes straight to the files.
        //
        // A <details> because the toggling, the keyboard handling and the
        // expanded state a screen reader announces come with the element. What
        // does not come with it is closing on a click elsewhere, which is
        // handled once for the whole page.
        const source = admin.addFromGoogle ? document.createElement('details') : null;
        let fromGoogle = null;
        let fromDevice = null;

        if (source) {
            source.className = 'admin__menu';

            const trigger = document.createElement('summary');
            trigger.className = 'admin__button admin__trigger';
            trigger.textContent = 'Add photos';

            const list = document.createElement('ul');
            list.className = 'admin__panel';

            const entry = (label) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'admin__item';
                item.textContent = label;

                const row = document.createElement('li');
                row.append(item);
                list.append(row);
                return item;
            };

            // "This device" rather than naming one. The same owners use this
            // from a phone and from a desk, and the file picker it opens is the
            // camera roll on one and a folder on the other.
            fromGoogle = entry('Google Photos');
            fromDevice = entry('This device');

            source.append(trigger, list);
        }

        // Offered only on a letter somebody has actually changed. On an
        // untouched one it would re-render the post into exactly what it
        // already says -- a fourth button, on every letter, for a no-op.
        const revert = post.editedAt ? icon('Restore original', 'fa-clock-rotate-left') : null;

        // Written on every edit and, until now, readable only by opening the
        // blob. It is not there to police owners, who are trusted; it is there
        // so "why does this letter not match the one in my inbox?" has an
        // answer years later when nobody remembers. Owner-only, like the rest
        // of this bar -- telling readers a letter was edited would advertise
        // the anonymisation it mostly exists to perform.
        const note = document.createElement('span');
        note.className = 'admin__note';
        if (post.editedAt) {
            // The reader's own zone, unlike the letter dates: this is a real
            // instant rather than a day the missionary wrote at the top of a
            // page, so there is nothing to preserve by pinning it to UTC.
            const when = new Date(post.editedAt);
            const on = Number.isNaN(when.getTime())
                ? ''
                : ` on ${when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`;
            note.textContent = `Edited by ${post.editedBy || 'an owner'}${on}.`;
        }

        // The subject stays a field of its own. It is a single line that has
        // to survive as one, and an editable heading invites a paragraph
        // break that the data model has nowhere to put.
        const field = document.createElement('input');
        field.type = 'text';
        field.className = 'admin__subject';
        field.setAttribute('aria-label', 'Subject');
        heading.insertAdjacentElement('afterend', field);

        // The crosses on the owner's own pictures, which are drawn with the
        // album and belong to this bar's idea of what is going on.
        //
        // They used to sit on the thumbnails permanently, and an owner reading
        // their own archive has a small dark × over the corner of every
        // picture they ever added -- on a page whose entire purpose is looking
        // at the pictures. Nothing else an owner can do to a letter is offered
        // before they have said they want to change it, and there is no reason
        // this one should be.
        const drops = album ? [...album.querySelectorAll('.album__remove')] : [];

        // Pictures the owner has crossed off but not yet saved.
        //
        // Marking rather than removing is what lets the crosses live inside
        // Edit at all. A removal that went to the server the moment it was
        // clicked would reload the page on the way back and take the half
        // written letter with it, and Cancel would undo the typing but not the
        // picture -- two things called "editing" that mean different amounts
        // of committed. Held here instead, they are undone by Cancel like
        // everything else and committed by Save with everything else.
        const dropped = new Set();

        const showEditing = (editing) => {
            for (const el of [hide, edit, remove, source ?? add]) el.hidden = editing;
            if (revert) revert.hidden = editing;
            for (const el of [save, cancel]) el.hidden = !editing;
            for (const el of drops) el.hidden = !editing;
            heading.hidden = editing;
            field.hidden = !editing;
            body.classList.toggle('post__body--editing', editing);
        };

        // Delegated, because the buttons themselves are the album's and it has
        // no business knowing what a pending edit is.
        album?.addEventListener('click', (event) => {
            const drop = event.target.closest?.('.album__remove');
            if (!drop) return;
            dropped.add(drop.dataset.photo);
            // The tile goes rather than dimming. The row is what the letter
            // will look like once this is saved, and a picture grayed out in
            // place is a question -- is it going, is it broken -- where an
            // absence is an answer. Cancel puts it back.
            drop.closest('li').hidden = true;
        });

        const restoreTiles = () => {
            dropped.clear();
            for (const el of drops) el.closest('li').hidden = false;
        };

        const open = () => {
            field.value = post.subject ?? '';

            // Take the presentation off before handing the letter over. The
            // photo frames are buttons, which behave badly inside an editable
            // region, and the search marks are not the owner's words -- if
            // either were left in place the owner would be editing something
            // the archive does not actually contain.
            undecoratePhotos(body);
            clearMarks(body);

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
            restoreTiles();
            showEditing(false);
            status.textContent = '';
        };

        const discard = () => {
            // Redrawn from the copy the page loaded rather than left as typed,
            // so Cancel means cancel.
            fillBody(body, post, photoSrc);
            // Refilling put the photos back in their deferred state, and this
            // letter is already open -- nothing is going to open it again.
            loadPhotos(body);
            close();
        };

        // What to send. Read from a clone so restoring the stored photo URLs
        // does not disturb what the owner is looking at, and so a failed save
        // leaves the page exactly as it was.
        const markup = () => {
            const scratch = body.cloneNode(true);

            // Belt and braces. `open()` has already taken both of these out of
            // the live body, but this is the one function whose output is
            // written to storage, and a frame or a mark that reached the
            // server would be stripped by the sanitizer on the way in -- which
            // for a frame means the photo inside it goes too.
            undecoratePhotos(scratch);
            clearMarks(scratch);

            for (const img of scratch.querySelectorAll('img[data-photo]')) {
                img.setAttribute('src', img.getAttribute('data-photo'));
                img.removeAttribute('data-photo');
                img.removeAttribute('data-src');
                img.removeAttribute('loading');
                img.removeAttribute('decoding');
            }
            return scratch.innerHTML;
        };

        const commit = () =>
            run('Saving…', () =>
                admin.patch(post.id, { subject: field.value, bodyHtml: markup() }, [...dropped])
            );

        hide.addEventListener('click', () =>
            run('Saving…', () => admin.patch(post.id, { hidden: !post.hidden }))
        );

        edit.addEventListener('click', open);
        cancel.addEventListener('click', discard);
        save.addEventListener('click', commit);

        add.addEventListener('click', () => picker.click());
        fromDevice?.addEventListener('click', () => {
            source.open = false;
            picker.click();
        });

        picker.addEventListener('change', () => {
            const files = [...picker.files];
            // Cleared straight away so choosing the same file twice still
            // fires a change event -- otherwise a failed upload cannot be
            // retried without picking something else in between.
            picker.value = '';
            if (!files.length) return;

            run('Adding pictures…', (say) => admin.addPhotos(post.id, files, say));
        });

        // Handed the status line for the same reason the upload above is: it
        // takes minutes and spends them in distinct states -- waiting on the
        // owner in Google's window, then counting pictures in.
        fromGoogle?.addEventListener('click', () => {
            source.open = false;
            run('Opening Google Photos…', (say) => admin.addFromGoogle(post.id, say));
        });

        // Awaited, because the answer now comes from a dialog drawn on the
        // page rather than from the browser stopping the world.
        remove.addEventListener('click', async () => {
            if (!(await admin.confirmDelete(post))) return;
            run('Deleting…', () => admin.remove(post.id));
        });

        revert?.addEventListener('click', async () => {
            if (!(await admin.confirmRestore(post))) return;
            run('Restoring…', () => admin.restore(post.id));
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
        // Add photos goes last so the glyphs stay one unbroken run: it is the
        // only control that kept its words, and in the middle it split them.
        bar.append(label, hide, edit, remove);
        if (revert) bar.append(revert);
        bar.append(save, cancel, source ?? add, picker, status);

        // Left off entirely on an unedited letter rather than left empty, so
        // the row has nothing above it to make room for.
        if (note.textContent) area.append(note);
        area.append(bar);
        return area;
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

    // --- the word cloud ---------------------------------------------------
    //
    // Two years of letters is a great many words and no shape at all. The
    // cloud is the shape: the places, the people and the things that kept
    // coming back, sized by how often. It is the only view of the archive
    // that is not a list of dates, and every word in it is a way into the
    // search -- which is what makes it more than an ornament.
    //
    // Counted here rather than on the server, on the same terms as the
    // search: the letters are already in memory and nothing has to leave the
    // device to be told what is in them. It works from file:// too.

    // The words that are in every letter because they are in every sentence.
    // Deliberately shorter than a proper stopword list -- these are somebody's
    // letters, not a corpus, and "home", "week" and "love" earn their place
    // even though a search engine would throw all three away.
    const NOISE = new Set(
        `a about after all also am an and any are as at be because been before
         being but by can could did do does doing done down each even ever
         every few for from get got had has have having he her here hers him
         his how i if in into is it its just like me more most much my no nor
         not now of off on once one only or other our out over own said same
         she should so some such than that the their them then there these
         they thing things this those though through to too under until up us
         very was we well were what when where which while who why will with
         would yet you your
         cant didnt dont hes im isnt its ive id ill shes thats theres theyre
         wasnt weve wont youre`
            .trim()
            .split(/\s+/)
    );

    // A pasted link is usually its own link text, so the URL is in the visible
    // words of the letter and not only in an href. Split on punctuation it
    // becomes the alphabetic runs of a Google Photos share id -- "egtkcgt",
    // "kxqodvf" -- which look like words, are counted like words, and are not
    // words. Anything with a scheme, an @ or a slash in it goes first.
    const LINKS = /\b(?:[a-z][\w+.-]*:\/\/|www\.|mailto:)\S*|\S+@\S+\.\S+|\S*\/\S*/gi;

    // Letters only, so years and house numbers stay out of it, and apostrophes
    // folded away so "don't" and "dont" are one word rather than two.
    const wordsIn = (text) =>
        text
            .replace(LINKS, ' ')
            .toLowerCase()
            .replace(/[\u2018\u2019]/g, "'")
            .split(/[^\p{L}']+/u)
            .map((word) => word.replace(/'/g, ''))
            .filter((word) => word.length > 2 && !NOISE.has(word));

    // Enough to fill a screen and read as a crowd. Past this the tail is words
    // that came up twice, and sixty of those say nothing the first sixty did
    // not already say louder.
    const MOST = 60;

    // Commonest first, which is the order wordcloud2 wants: it works outwards
    // from the middle, so whatever leads the list gets the best of the space.
    // Ties break on the word so the same archive draws the same cloud twice.
    function countWords(posts) {
        const tally = new Map();
        for (const post of posts) {
            for (const word of wordsIn(textOf(post))) {
                tally.set(word, (tally.get(word) ?? 0) + 1);
            }
        }

        return [...tally]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, MOST);
    }

    // Logarithmic. A word that came up four times as often is not four times as
    // interesting, and on a linear scale one runaway word flattens the other
    // fifty-nine into a single illegible size.
    function scale(words, box) {
        const counts = words.map(([, n]) => n);
        const most = Math.max(...counts);
        const least = Math.min(...counts);

        // Tied to the box rather than fixed, because the same type that reads
        // as a cloud on a laptop is a wall of headlines on a phone.
        const top = Math.max(20, Math.min(box.clientWidth, box.clientHeight) * 0.19);
        const floor = Math.max(11, top * 0.24);

        return (n) => {
            if (most <= least) return (top + floor) / 2;
            const step = (Math.log(n) - Math.log(least)) / (Math.log(most) - Math.log(least));
            return floor + step * (top - floor);
        };
    }

    // How many tones the stylesheet defines. Six is enough that a word rarely
    // sits next to its own color and few enough that they still read as a set.
    const TONES = 6;

    // Off the word rather than off its position, so a word keeps its color when
    // a resize repacks the cloud and lands it somewhere else entirely.
    function toneOf(word) {
        let hash = 0;
        for (let i = 0; i < word.length; i += 1) {
            hash = (hash * 31 + word.charCodeAt(i)) % 100003;
        }

        return hash % TONES;
    }

    // The library packs the words; everything the reader touches is still ours.
    // In DOM mode it emits a span per word, and each item on the list can carry
    // the attributes that span is given -- so the words come out of it already
    // labeled, focusable and carrying the word they stand for.
    function draw(view) {
        if (!view.words.length) return;

        const weight = scale(view.words, view.box);
        view.box.textContent = '';

        window.WordCloud(view.box, {
            list: view.words.map(([word, n]) => ({
                word,
                weight: n,
                attributes: {
                    'data-word': word,
                    role: 'button',
                    tabindex: '0',
                    'aria-label': `${word}, ${n} ${n === 1 ? 'time' : 'times'}`
                }
            })),
            weightFactor: weight,
            fontFamily: getComputedStyle(view.box).fontFamily,
            // Left to the stylesheet, so hover, focus and any future dark mode
            // are one rule rather than sixty inline colors.
            color: null,
            classes: (word) => `cloud__word cloud__word--${toneOf(word)}`,
            // The step the packing works in. Finer than this and laying out
            // sixty words takes long enough to see; coarser and the gaps show.
            gridSize: 6,
            rotateRatio: 0.3,
            rotationSteps: 2,
            minRotation: -Math.PI / 2,
            maxRotation: Math.PI / 2,
            shape: 'square',
            drawOutOfBound: false,
            shrinkToFit: true,
            backgroundColor: 'transparent'
        });
    }

    let cloud = null;

    function ensureCloud() {
        if (cloud) return cloud;

        const dialog = document.createElement('dialog');
        dialog.className = 'cloud';

        const title = document.createElement('h2');
        title.className = 'cloud__title';
        title.id = 'cloud-title';
        title.textContent = 'Word cloud';
        dialog.setAttribute('aria-labelledby', title.id);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'cloud__close';
        close.setAttribute('aria-label', 'Close the word cloud');
        close.textContent = '\u00d7';
        close.addEventListener('click', () => dialog.close());

        const head = document.createElement('div');
        head.className = 'cloud__head';
        head.append(title, close);

        // Said once here rather than on each of sixty words, where it would be
        // sixty times the noise for a screen reader and nothing at all for
        // everybody else.
        const note = document.createElement('p');
        note.className = 'cloud__note';
        note.textContent = 'What these letters keep coming back to. Pick a word to search for it.';

        const box = document.createElement('div');
        box.className = 'cloud__words';

        const take = (target) => {
            const word = target.closest?.('.cloud__word');
            if (!word) return;
            dialog.close();
            cloud.pick?.(word.dataset.word);
        };

        box.addEventListener('click', (event) => take(event.target));

        // The words are spans, because that is what the library makes. Giving
        // them a role and a tab stop is only half of a button -- this is the
        // other half.
        box.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (!event.target.closest?.('.cloud__word')) return;
            event.preventDefault();
            take(event.target);
        });

        dialog.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') dialog.close();
        });

        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) dialog.close();
        });

        // A packed layout is packed for a shape, so turning the phone or
        // dragging the window makes the old one wrong. Held off until the
        // dragging stops, because each pass walks sixty words.
        let settling = null;
        window.addEventListener('resize', () => {
            if (!dialog.open) return;
            clearTimeout(settling);
            settling = setTimeout(() => draw(cloud), 200);
        });

        dialog.append(head, note, box);
        document.body.append(dialog);

        cloud = { dialog, box, words: [], pick: null };
        return cloud;
    }

    function openCloud(posts, pick) {
        const view = ensureCloud();
        view.pick = pick;

        // Counted the first time somebody asks and not before. Most readers
        // never open it, and walking every letter on the way to drawing the
        // first one is a cost they should not pay. Kept afterwards because a
        // resize redraws from the same tally.
        if (!view.words.length) view.words = countWords(posts);

        // Opened first: the box has no width until it is on screen, and the
        // packing is measured in the pixels it actually has.
        view.dialog.showModal();
        draw(view);
    }

    // --- months -----------------------------------------------------------
    //
    // The contents and the list of letters are the same object at two zoom
    // levels. Rather than a menu holding a second copy of every subject line,
    // the months are headings in the list itself: folded, two years of letters
    // is two dozen rows that fit on one screen; unfolded, it is the list it
    // always was. Nothing has to be kept in step with anything, because there
    // is only one of it.
    //
    // Nothing is grouped until there are two months to tell apart. A single
    // heading over the whole archive is a row that says nothing.

    // Above this many letters the months arrive folded. Below it the archive
    // is already a screen or two of dates, and folding it would be hiding a
    // short list in order to save scrolling past a short list.
    const FOLD_ABOVE = 12;

    const monthName = (key) => {
        const [year, month] = key.split('-');
        return new Date(Date.UTC(+year, +month - 1, 1)).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            timeZone: 'UTC'
        });
    };

    const countLetters = (n) => `${n} ${n === 1 ? 'letter' : 'letters'}`;

    function setFolded(group, folded) {
        group.item.classList.toggle('month--folded', folded);
        group.toggle.setAttribute('aria-expanded', String(!folded));
        group.inner.hidden = folded;
    }

    // Returns the groups, or an empty list when the archive is not worth
    // grouping -- in which case the letters go straight into the list and
    // nothing else in this file behaves any differently.
    function groupByMonth(posts, views, list) {
        const groups = [];
        const byKey = new Map();

        for (const post of posts) {
            const key = String(post.originalDate ?? '').slice(0, 7);
            // One letter nobody can date would leave a heading with no month
            // to name, so the whole archive goes ungrouped rather than mostly.
            if (!/^\d{4}-\d{2}$/.test(key)) return [];

            if (!byKey.has(key)) {
                byKey.set(key, { key, views: [] });
                groups.push(byKey.get(key));
            }
            byKey.get(key).views.push(views.get(post.id));
        }

        if (groups.length < 2) return [];

        for (const group of groups) {
            group.item = document.createElement('li');
            group.item.className = 'month';

            group.inner = document.createElement('ol');
            group.inner.className = 'month__posts';
            group.inner.id = `month-${group.key}`;
            for (const view of group.views) group.inner.append(view.item);

            group.toggle = document.createElement('button');
            group.toggle.type = 'button';
            group.toggle.className = 'month__toggle';
            group.toggle.setAttribute('aria-expanded', 'true');
            group.toggle.setAttribute('aria-controls', group.inner.id);

            const name = document.createElement('span');
            name.className = 'month__name';
            name.textContent = monthName(group.key);

            group.count = document.createElement('span');
            group.count.className = 'month__count';
            group.count.textContent = countLetters(group.views.length);

            group.toggle.append(name, group.count);
            group.item.append(group.toggle, group.inner);
            list.append(group.item);

            for (const view of group.views) view.group = group;

            group.toggle.addEventListener('click', () => {
                setFolded(group, group.toggle.getAttribute('aria-expanded') === 'true');
            });
        }

        return groups;
    }

    // The resting state of the page: the newest letter open, everything else
    // shut. Applied on load and again whenever the search box is emptied, so
    // clearing a search puts the page back where it started rather than
    // leaving every letter the reader happened to visit hanging open.
    function collapseToNewest(views, groups = []) {
        for (const group of groups) setFolded(group, views.size > FOLD_ABOVE);

        // The newest letter is opened last on purpose: opening it unfolds the
        // month it is in, which is the one month that should not be shut.
        let first = true;
        for (const view of views.values()) {
            setExpanded(view, first);
            first = false;
        }
    }

    // A letter named in the address bar opens instead of the newest one.
    //
    // This exists for the digest email, which lists letters by subject and has
    // to be able to land somebody on the one they pressed. Without it every
    // link in that message goes to the top of the archive, and on a page where
    // letters are collapsed by default that means the reader arrives and has
    // to find, in a list of dates, the thing they had already chosen.
    //
    // The fragment names the panel rather than the letter, because the panel
    // has an id in the markup already and a second identifier for the same
    // thing is a second thing to keep in step. It also means the browser's own
    // scrolling does something sensible in the moment before this runs.
    //
    // Deliberately not a `hashchange` listener. The archive's own links are
    // buttons, so the only way the fragment changes after load is somebody
    // editing the address bar, and re-collapsing the page under a reader who
    // did that is worse than ignoring them.
    function openFromHash(views, groups = []) {
        const hash = String(location.hash || '');
        if (!hash.startsWith('#panel-')) return;

        // Ids are dates plus a short hash, so this is a lookup and never a
        // pattern -- an unknown value simply finds nothing and the page is
        // left as `collapseToNewest` made it.
        let id;
        try {
            id = decodeURIComponent(hash.slice('#panel-'.length));
        } catch {
            return;
        }

        const wanted = views.get(id);
        if (!wanted) return;

        revealPost(views, groups, wanted);
    }

    // Fold the archive down to one letter and put it on screen. Two things
    // arrive pointed at a single letter rather than at the archive -- a link
    // from a digest email, and the album -- and both want the page left in the
    // same state afterwards: exactly one month open, and it is this one's.
    function revealPost(views, groups, wanted, scroll = {}) {
        for (const group of groups) setFolded(group, views.size > FOLD_ABOVE);
        for (const view of views.values()) setExpanded(view, view === wanted);
        wanted.item.scrollIntoView(scroll);
    }

    // --- marking the words themselves -------------------------------------
    //
    // MiniSearch answers "which letters" and stops there. That was the whole
    // of search until now, and it left the reader who asked for a cousin's
    // name looking at four unopened letters of a thousand words each with no
    // idea where in them the name appears. These two functions add and remove
    // the <mark> elements that answer "where".
    //
    // Marking is done over the rendered DOM rather than by rebuilding the body
    // from bodyHtml with the matches wrapped, because the body may be carrying
    // an owner's unsaved edit and because a string replace over markup would
    // happily mark a word inside an attribute.

    // Only marks exact matches, and only prefixes of them. MiniSearch's fuzzy
    // matching can put a letter in the results on a near miss -- which is
    // wanted, place names are misspelled constantly -- and that letter will
    // then show as a result with nothing marked inside it. That is the honest
    // outcome: pretending to know which word was the near miss would mark the
    // wrong one.
    function termsPattern(query) {
        const terms = query
            .split(/[^\p{L}\p{N}']+/u)
            // One-character terms match somewhere in every letter ever
            // written, and marking them makes the page unreadable rather than
            // searchable.
            .filter((term) => term.length >= 2)
            .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

        if (!terms.length) return null;

        // Trailing word characters are swept in so a search for "guat" marks
        // the whole of "Guatemala", matching what prefix search just did when
        // it decided this letter was a result.
        return new RegExp(`(?:${terms.join('|')})[\\p{L}\\p{N}]*`, 'giu');
    }

    function markMatches(root, pattern) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const targets = [];

        // Collected first, replaced second. Replacing a text node while the
        // walker is standing on it invalidates the walk, and the replacement
        // contains text nodes that would then be walked into and marked again.
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            pattern.lastIndex = 0;
            if (pattern.test(node.nodeValue)) targets.push(node);
        }

        const marks = [];
        for (const text of targets) {
            const value = text.nodeValue;
            const parts = document.createDocumentFragment();
            let cursor = 0;

            pattern.lastIndex = 0;
            for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
                if (match.index > cursor) parts.append(value.slice(cursor, match.index));

                const mark = document.createElement('mark');
                mark.className = 'hit';
                mark.textContent = match[0];
                parts.append(mark);
                marks.push(mark);

                cursor = match.index + match[0].length;
            }

            if (cursor < value.length) parts.append(value.slice(cursor));
            text.replaceWith(parts);
        }

        return marks;
    }

    function clearMarks(root) {
        const marks = root.querySelectorAll('mark.hit');
        for (const mark of marks) mark.replaceWith(...mark.childNodes);

        // Marking splits one text node into three; clearing puts three back
        // where one was. Left unmerged, every keystroke fragments the letter a
        // little further and the next search has to walk the wreckage.
        if (marks.length) root.normalize();
    }

    // Drawn, not set in a font and not fetched. The downloaded archive is four
    // files in a folder and an icon font is not one of them.
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function magnifier() {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('width', '18');
        svg.setAttribute('height', '18');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.8');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('aria-hidden', 'true');

        const glass = document.createElementNS(SVG_NS, 'circle');
        glass.setAttribute('cx', '6.8');
        glass.setAttribute('cy', '6.8');
        glass.setAttribute('r', '4.6');

        const handle = document.createElementNS(SVG_NS, 'line');
        handle.setAttribute('x1', '10.4');
        handle.setAttribute('y1', '10.4');
        handle.setAttribute('x2', '14.2');
        handle.setAttribute('y2', '14.2');

        svg.append(glass, handle);
        return svg;
    }

    // Search runs entirely in the browser over the payload already in memory.
    // Nothing is sent back, which means a half-typed search for a grandchild's
    // name never leaves the device and there is no query log to protect. It is
    // also what lets the downloaded copy search at all, with no backend.
    function setUpSearch(posts, views, groups, elements) {
        const { searchForm, searchInput, searchCount } = elements;
        if (!searchForm || !searchInput) return null;

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

        // Built here rather than in the two page templates that host this
        // file. The site and the downloaded archive each carry their own copy
        // of the search form, and anything added to one has to be added by
        // hand to the other; making it here means there is one of it.
        //
        // The template's own label and input are moved into the row rather
        // than recreated, so the `for`/`id` pairing and the ids the tests and
        // app.js look up all survive the rearrangement.
        const fields = document.createElement('div');
        fields.className = 'search__fields';

        // The magnifier says what the box is for in the width of a glyph,
        // which is cheaper than the label it replaces -- a whole line of
        // vertical space, on a bar that never scrolls away.
        const icon = magnifier();
        icon.setAttribute('class', 'search__icon');

        // Always on screen once there is something to clear, rather than the
        // browser's own cancel button, which several of them only paint on
        // hover -- and a control that appears when the pointer arrives is no
        // control at all on a phone.
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'search__clear';
        clear.setAttribute('aria-label', 'Clear the search');
        clear.textContent = '×';
        clear.hidden = true;

        const label = searchForm.querySelector('.search__label');
        if (label) label.classList.add('visually-hidden');

        fields.append(...(label ? [label] : []), icon, searchInput, clear);

        const nav = document.createElement('div');
        nav.className = 'search__nav';
        nav.hidden = true;

        const stepper = (label, text) => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'search__step';
            el.setAttribute('aria-label', label);
            el.textContent = text;
            return el;
        };

        const previous = stepper('Previous match', '↑');
        const next = stepper('Next match', '↓');

        // One line where there were two. "3 of 3 letters match" above "9
        // matches" spent a quarter of a phone screen saying one thing twice.
        const position = searchCount ?? document.createElement('span');
        position.className = 'search__position';
        position.setAttribute('aria-live', 'polite');

        nav.append(position, previous, next);
        searchForm.append(fields, nav);

        let marks = [];
        let at = -1;
        let letters = 0;

        const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

        // Reads as a sentence at every stage, because it is the only line the
        // reader gets: how many were found, how far through them they are,
        // and how much of the archive they are spread across.
        const describe = () => {
            if (!searchInput.value.trim()) return '';
            if (!letters) return 'No letters match that.';

            const spread = `in ${count(letters, 'letter', 'letters')}`;
            if (!marks.length) return `Found ${spread}`;
            if (at < 0) return `${count(marks.length, 'match', 'matches')} ${spread}`;
            return `${at + 1} of ${count(marks.length, 'match', 'matches')} ${spread}`;
        };

        const reset = () => {
            for (const view of views.values()) {
                clearMarks(view.body);
                clearMarks(view.title);
                view.hits.hidden = true;
                view.hits.textContent = '';
                view.item.hidden = false;
            }
            for (const group of groups) {
                group.item.hidden = false;
                group.count.textContent = countLetters(group.views.length);
            }
            marks = [];
            at = -1;
            letters = 0;
        };

        // Moves the reader to a match, opening the letter it lives in. This is
        // the whole reason the letters collapse rather than hide: a hit in a
        // closed letter is still a hit, and stepping onto it is what opens it.
        const goTo = (wanted) => {
            if (!marks.length) return;

            const index = (wanted + marks.length) % marks.length;
            if (at >= 0 && marks[at]) marks[at].classList.remove('hit--current');
            at = index;

            const mark = marks[at];
            mark.classList.add('hit--current');

            const item = mark.closest('.post');
            const view = item && views.get(item.dataset.post);
            if (view) setExpanded(view, true);

            // 'center' rather than the default 'start': the search bar is
            // sticky, and a hit scrolled to the top of the viewport ends up
            // underneath it.
            mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
            position.textContent = describe();
        };

        const apply = () => {
            const query = searchInput.value.trim();
            reset();
            clear.hidden = !searchInput.value;

            if (!query) {
                nav.hidden = true;
                position.textContent = '';
                collapseToNewest(views, groups);
                return;
            }

            // Prefix and fuzzy matching both on: the audience types partial
            // words and misspells place names, and an archive this small can
            // afford a generous match far better than it can afford an empty
            // result.
            const matched = new Set(
                index.search(query, { prefix: true, fuzzy: 0.2 }).map((hit) => hit.id)
            );
            letters = matched.size;

            const pattern = termsPattern(query);

            // Walked in the order the letters are on the page, so stepping
            // forward through the matches always moves down the page.
            for (const view of views.values()) {
                const keep = matched.has(view.id);
                view.item.hidden = !keep;
                if (!keep) continue;

                const found = pattern
                    ? [...markMatches(view.title, pattern), ...markMatches(view.body, pattern)]
                    : [];
                marks.push(...found);

                if (found.length) {
                    view.hits.hidden = false;
                    view.hits.textContent =
                        found.length === 1 ? '1 match' : `${found.length} matches`;
                }
            }

            // Every month is opened, because a search is a question about the
            // whole archive and an answer folded away is not one. The heading
            // counts what is left rather than what the month holds, so a month
            // showing one letter does not claim to hold four, and a month
            // showing none goes with them.
            for (const group of groups) {
                setFolded(group, false);
                const showing = group.views.filter((view) => !view.item.hidden).length;
                group.count.textContent = countLetters(showing);
                group.item.hidden = showing === 0;
            }

            // The row carries the verdict as well as the stepper, so it stays
            // up to say that nothing matched.
            nav.hidden = false;
            previous.hidden = marks.length === 0;
            next.hidden = marks.length === 0;
            position.textContent = describe();
        };

        // Guarded so that a stray Escape on an empty box does not count as a
        // search being cleared: apply() would collapse the letter a digest
        // link just opened.
        const clearSearch = () => {
            if (!searchInput.value) return;
            searchInput.value = '';
            apply();
        };

        clear.addEventListener('click', () => {
            clearSearch();
            searchInput.focus();
        });

        // Escape leaves searching altogether rather than only emptying the
        // box: the query goes, the marks go, the months fold back to where
        // they were, and the field gives up focus.
        //
        // Bound to the document because by the time a reader wants out they
        // are usually a long way down the page looking at a match, and having
        // to scroll back to the box to press Escape in it is precisely what
        // Escape is for. Anything with its own use for the key keeps it: a
        // dialog closes, an edit in progress is discarded, and neither of
        // those should also wipe the search behind it.
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            if (!searchInput.value) return;
            if (document.querySelector('dialog[open]')) return;

            const focused = document.activeElement;
            const elsewhere =
                focused &&
                focused !== searchInput &&
                (focused.isContentEditable || focused.matches('input, textarea, select'));
            if (elsewhere) return;

            clearSearch();
            searchInput.blur();
        });

        // Up and down walk the matches, exactly as the two buttons do, so the
        // reader who has just typed can step through the answers without
        // going back to the mouse. Bound to the form rather than the document:
        // arrow keys scroll the page, and a reader who is not in the search
        // bar means them to.
        searchForm.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            if (!marks.length) return;

            event.preventDefault();
            goTo(event.key === 'ArrowDown' ? at + 1 : at < 0 ? -1 : at - 1);
        });

        // `at` is -1 until the reader steps for the first time, and stepping
        // back from nowhere means the last match rather than one before it.
        // Passing -2 through the wrap arrives at the second from the end,
        // which is a strange place to be sent and nothing on screen explains
        // why.
        previous.addEventListener('click', () => goTo(at < 0 ? -1 : at - 1));
        next.addEventListener('click', () => goTo(at + 1));

        searchInput.addEventListener('input', apply);

        // Enter from the search box is a request to see the next match, not to
        // reload the page with a query string the server has no opinion about.
        searchForm.addEventListener('submit', (event) => {
            event.preventDefault();
            goTo(at + 1);
        });

        searchForm.hidden = false;

        // Handed back so the word cloud can search for the word it was given.
        // It is the only thing outside this function that puts something in
        // the box, and it goes through the same path a person typing does.
        return {
            pick(word) {
                searchInput.value = word;
                apply();
                searchInput.focus();
                searchForm.scrollIntoView({ block: 'start', behavior: 'smooth' });
            }
        };
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
     * @param {object|null} [options.album] a slideshow over every photo in the
     *   archive. Absent in the downloaded archive, which has no video in it and
     *   should not carry a library this size for the half that is left.
     */
    function mount({ posts, photoSrc, elements, admin = null, help = null, album = null }) {
        const { list, state } = elements;

        if (!posts.length) {
            state.textContent = 'No letters have arrived yet.';

            // Passed in rather than written here. This file also runs inside a
            // downloaded archive, which has no site to link to and no address
            // worth naming, so an empty archive there says the first sentence
            // and stops. Somebody reading a zip on a plane cannot act on either.
            if (help) {
                state.append(` Forward one to ${help.address} and it will appear here. `);

                const link = document.createElement('a');
                link.href = help.href;
                link.textContent = 'If you forwarded one and nothing happened, here is why';
                state.append(link, '.');
            }

            state.hidden = false;
            return;
        }

        const views = new Map();
        for (const post of posts) {
            views.set(post.id, renderPost(post, photoSrc, admin));
        }

        // A <details> stays open until its own summary is clicked again, which
        // for a menu means carrying it down the page. One listener for the
        // whole reader rather than one per letter: an archive runs to hundreds
        // of them and every one draws a bar.
        document.addEventListener('click', (event) => {
            for (const menu of document.querySelectorAll('.admin__menu[open]')) {
                if (!menu.contains(event.target)) menu.open = false;
            }
        });

        // Either puts every letter into a month and the months into the list,
        // or hands back nothing and leaves the letters to go in flat.
        const groups = groupByMonth(posts, views, list);
        if (!groups.length) {
            for (const view of views.values()) list.append(view.item);
        }

        collapseToNewest(views, groups);
        openFromHash(views, groups);

        const search = setUpSearch(posts, views, groups, elements);

        // One control for the whole list, built here for the same reason the
        // search stepper is: there are two page templates hosting this file
        // and only one of this. It earns its place on the archives that are
        // read rather than scanned -- somebody catching up on a month wants
        // all of it open and does not want to click eight times to get there.
        if (posts.length > 1) {
            const toolbar = document.createElement('div');
            toolbar.className = 'toolbar';

            const all = document.createElement('button');
            all.type = 'button';
            all.className = 'button button--quiet button--compact';
            all.textContent = 'Expand all';

            all.addEventListener('click', () => {
                const opening = all.textContent === 'Expand all';
                // Folded first when shutting, because opening a letter
                // unfolds its month and doing the two in the other order
                // would undo half the work as it went.
                for (const group of groups) setFolded(group, !opening);
                for (const view of views.values()) setExpanded(view, opening);
                all.textContent = opening ? 'Collapse all' : 'Expand all';
            });

            // The far end of the row from Expand all, which sits over on the
            // right above the Expand buttons it works on. One rearranges the
            // list in front of you and the other opens a window over the top
            // of it, and a thumb reaching for one should not land on the other.
            const cloudButton = document.createElement('button');
            cloudButton.type = 'button';
            cloudButton.className = 'button button--quiet button--compact';
            cloudButton.textContent = 'Word cloud';
            cloudButton.addEventListener('click', () => openCloud(posts, search?.pick));

            toolbar.append(cloudButton, all);

            // Beside the word cloud rather than beside Expand all: both open a
            // window over the archive instead of rearranging it.
            if (album && posts.some((post) => post.photos?.length)) {
                const photos = document.createElement('button');
                photos.type = 'button';
                photos.className = 'button button--quiet button--compact';
                photos.textContent = 'Photo Album';
                // Handed an id and left to find the view, so the album holds
                // no reference to anything on the page.
                photos.addEventListener('click', () => album.open({
                    posts,
                    photoSrc,
                    reveal(id) {
                        const view = views.get(id);
                        if (view) revealPost(views, groups, view, { behavior: 'smooth' });
                    }
                }));

                toolbar.prepend(photos);
            }

            list.parentNode.insertBefore(toolbar, list);
        }

        state.hidden = true;
    }

    return { mount, formatDate };
})();
