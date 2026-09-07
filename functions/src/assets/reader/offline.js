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

    // The slug is the fallback rather than the heading. A copy downloaded
    // before the name was packaged has none, and so does a site nobody has
    // named.
    const heading = archive.name || archive.slug;
    document.getElementById('site-title').textContent = heading;
    document.title = `${heading} — Pday Letters`;

    const mission = document.getElementById('site-mission');
    mission.textContent = archive.mission || '';
    mission.hidden = !mission.textContent;

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
