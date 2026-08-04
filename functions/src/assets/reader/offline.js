// The downloaded reader's entry point -- the offline counterpart of app.js.
//
// It is a different entry point rather than a different reader: everything
// that draws a letter or searches one lives in reader.js, which is the site's
// own file copied in unchanged. All this does is point that code at the folder
// it is sitting in instead of at an API.

/* global Reader */

(function () {
    'use strict';

    const archive = window.__ARCHIVE__ ?? { slug: '', posts: [], exportedAt: null };

    const elements = {
        state: document.getElementById('state'),
        list: document.getElementById('posts'),
        searchForm: document.getElementById('search'),
        searchInput: document.getElementById('q'),
        searchCount: document.getElementById('search-count')
    };

    document.getElementById('site-title').textContent = archive.slug;
    document.title = `${archive.slug} — P-Day Letters`;

    // Relative, with no leading slash: a leading slash on file:// resolves to
    // the root of the disk rather than to this folder.
    const photoSrc = (photoId, size) =>
        `photos/${encodeURIComponent(photoId)}/${size}.webp`;

    Reader.mount({ posts: archive.posts, photoSrc, elements });

    const colophon = document.getElementById('colophon');
    if (colophon && archive.exportedAt) {
        colophon.textContent = `Downloaded ${archive.exportedAt.slice(0, 10)}. ${archive.posts.length} letters.`;
    }
})();
