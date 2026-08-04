// The hosted reader's entry point.
//
// Everything specific to running on the website lives here: working out which
// archive was asked for, fetching it through the authenticated API, and
// handling an expired session. The drawing is Reader.mount(), which the
// downloaded zip calls with exactly the same arguments.

/* global Reader */

(function () {
    'use strict';

    const elements = {
        state: document.getElementById('state'),
        list: document.getElementById('posts'),
        searchForm: document.getElementById('search'),
        searchInput: document.getElementById('q'),
        searchCount: document.getElementById('search-count')
    };

    const title = document.getElementById('site-title');

    // The slug is the first path segment. Everything else about the site --
    // including whether it exists at all -- is decided by the API.
    const slug = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[0] ?? '');

    const show = (message) => {
        elements.state.textContent = message;
        elements.state.hidden = false;
    };

    const photoSrc = (photoId, size) =>
        `/api/photo/${encodeURIComponent(slug)}/${encodeURIComponent(photoId)}/${size}.webp`;

    // One call for both owner actions. Returns null on success -- having
    // reloaded the page -- and a sentence the owner can read on failure.
    async function send(method, postId, body) {
        let response;
        try {
            response = await fetch(
                `/api/posts/${encodeURIComponent(slug)}/${encodeURIComponent(postId)}`,
                {
                    method,
                    redirect: 'manual',
                    headers: body ? { 'Content-Type': 'application/json' } : undefined,
                    body: body ? JSON.stringify(body) : undefined
                }
            );
        } catch {
            return 'Could not reach the server. Nothing was changed.';
        }

        if (response.status === 401 || response.type === 'opaqueredirect') {
            return 'Your session expired. Reload the page and sign in again.';
        }

        if (!response.ok) {
            // The API explains a 400 in its own words -- "not editable:
            // originalFrom" is more use than "something went wrong".
            const detail = await response.json().catch(() => null);
            return detail?.error
                ? `Refused: ${detail.error}`
                : `That did not work (${response.status}).`;
        }

        // Re-reading is what keeps the page honest: the server decides what a
        // letter now says, including what its sanitizer removed from an edit.
        window.location.reload();
        return null;
    }

    async function load() {
        if (!slug) {
            show('No archive was named in this address.');
            return;
        }

        let response;
        try {
            // `manual` because Static Web Apps answers an expired session with
            // a 302 to the login page, not a 401. Followed automatically, that
            // redirect lands on Microsoft's cross-origin sign-in page and fetch
            // reports an opaque failure that is indistinguishable from the
            // network being down. Left unfollowed, it is unmistakable.
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
            // 404 covers both "no such archive" and "not yours" -- the API
            // refuses to tell them apart, so neither can this message.
            show('This archive is not available to you.');
            return;
        }

        const payload = await response.json();
        title.textContent = payload.slug;
        document.title = `${payload.slug} — P-Day Letters`;

        const download = document.getElementById('download');
        if (download) {
            download.href = `/api/download/${encodeURIComponent(payload.slug)}/letters.zip`;
            download.hidden = false;
        }

        // Only owners get controls, and the API enforces that again on every
        // call -- this decides what to draw, not who is allowed to do it.
        const admin =
            payload.role === 'owner'
                ? {
                      patch: (postId, changes) => send('PATCH', postId, changes),
                      remove: (postId) => send('DELETE', postId),
                      confirmDelete: (post) =>
                          window.confirm(
                              `Remove "${post.subject || 'Untitled'}" from the site?\n\n` +
                                  'The original letter is kept in the archive, so this can be ' +
                                  'undone by re-forwarding it. To take a letter out of view ' +
                                  'while you decide, use Hide instead.'
                          )
                  }
                : null;

        Reader.mount({ posts: payload.posts, photoSrc, elements, admin });
    }

    load();
})();
