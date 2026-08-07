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

    // The version of the archive this page was drawn from. Sent back on every
    // write so the server can refuse one composed against a stale copy.
    let loadedEtag = null;

    // One call for both owner actions. Returns null on success -- having
    // reloaded the page -- and a sentence the owner can read on failure.
    async function send(method, postId, body) {
        const headers = {};
        if (body) headers['Content-Type'] = 'application/json';
        if (loadedEtag) headers['If-Match'] = loadedEtag;

        let response;
        try {
            response = await fetch(
                `/api/posts/${encodeURIComponent(slug)}/${encodeURIComponent(postId)}`,
                {
                    method,
                    redirect: 'manual',
                    headers,
                    body: body ? JSON.stringify(body) : undefined
                }
            );
        } catch {
            return 'Could not reach the server. Nothing was changed.';
        }

        if (response.status === 401 || response.type === 'opaqueredirect') {
            return 'Your session expired. Reload the page and sign in again.';
        }

        if (response.status === 412) {
            return 'This page is out of date — someone changed these letters after it loaded. Reload and try again; nothing was changed.';
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
                redirect: 'manual',
                // A normal reload revalidates the document but is happy to take
                // subresources from cache, which is how an owner's saved edit
                // came back looking like it had not happened. The response is
                // ETagged, so this is a 304 in the ordinary case.
                cache: 'no-cache'
            });
        } catch {
            show('Could not reach the archive. Check your connection and try again.');
            return;
        }

        if (response.status === 401 || response.type === 'opaqueredirect') {
            // The session expired mid-visit. Send them back through login and
            // return them to the page they were actually reading.
            //
            // Via the chooser, not straight at a provider: there are two now,
            // and guessing means occasionally offering someone the wrong one
            // and stranding them on an account no archive has ever heard of.
            window.location.assign(
                `/login.html?post_login_redirect_uri=${encodeURIComponent(window.location.pathname)}`
            );
            return;
        }

        if (!response.ok) {
            // 404 covers both "no such archive" and "not yours" -- the API
            // refuses to tell them apart, so neither can this message.
            await showDenied();
            return;
        }

        const payload = await response.json();
        loadedEtag = response.headers.get('ETag');

        // The name if the archive has one, the slug if it does not. A site
        // claimed before anybody typed a name still has to be called something,
        // and the slug is the one label that always exists.
        const heading = payload.name || payload.slug;
        title.textContent = heading;
        document.title = `${heading} — P-Day Letters`;

        const download = document.getElementById('download');
        if (download) {
            download.href = `/api/download/${encodeURIComponent(payload.slug)}/letters.zip`;
            download.hidden = false;
        }

        // Owners only, and hidden rather than disabled for everyone else: a
        // reader has no use for a page that would refuse them, and the API
        // refuses them again regardless.
        const people = document.getElementById('people');
        if (people && payload.role === 'owner') {
            people.href = `/people/${encodeURIComponent(payload.slug)}`;
            people.hidden = false;
        }

        const settings = document.getElementById('settings');
        if (settings && payload.role === 'owner') {
            settings.href = `/settings/${encodeURIComponent(payload.slug)}`;
            settings.hidden = false;
        }

        // Not awaited: the letters are the point, and a masthead control that
        // appears a moment later costs nothing. Awaiting it would put a second
        // round trip in front of the content on every visit.
        showSwitcher(payload.slug);

        // The standing exception to private-by-default, said out loud on the
        // page where it is being exercised. The server has already logged it;
        // this is for the operator, who is about to edit somebody else's
        // letters and needs to know that is what these controls now do.
        const banner = document.getElementById('operator-banner');
        if (banner && payload.viaOperator) banner.hidden = false;

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

        Reader.mount({
            posts: payload.posts,
            photoSrc,
            elements,
            admin,
            help: { href: '/faq#forward-did-nothing', address: 'post@pdayletters.com' }
        });
    }

    // One fetch shared by the masthead and the refusal panel. Both want the
    // same answer and they run concurrently, so asking twice would be two
    // round trips for one fact.
    let principalRequest = null;

    function readPrincipal() {
        principalRequest ??= (async () => {
            try {
                const response = await fetch('/.auth/me', { cache: 'no-store' });
                if (!response.ok) return null;
                return (await response.json()).clientPrincipal ?? null;
            } catch {
                return null;
            }
        })();
        return principalRequest;
    }

    // The other archives this account can read.
    //
    // There is deliberately no dashboard page, so this and the signed-in root
    // redirect are the whole of discovery. Between them: land on any archive
    // you belong to, reach every other one from there.
    //
    // `except` is the archive already on screen, which is left out when it is
    // one of theirs and passed as null on the refusal page, where every
    // membership is worth offering -- somebody who has just been told no is
    // exactly the person who needs to see where they *can* go.
    //
    // Silent on failure, like the account line: this is a way back to letters
    // that are already reachable, not a thing whose absence needs explaining.
    async function showSwitcher(except) {
        const box = document.getElementById('switcher');
        const list = document.getElementById('switcher-list');
        if (!box || !list) return;

        let memberships;
        try {
            const response = await fetch('/api/memberships', { cache: 'no-store' });
            if (!response.ok) return;
            memberships = (await response.json()).memberships;
        } catch {
            return;
        }

        if (!Array.isArray(memberships)) return;

        const others = memberships.filter((membership) => membership.slug !== except);
        // Nothing is drawn for the overwhelming majority, who have one archive
        // and would get a control that can only tell them where they already
        // are.
        if (others.length === 0) return;

        for (const membership of others) {
            const item = document.createElement('li');
            const link = document.createElement('a');
            link.href = `/${encodeURIComponent(membership.slug)}/`;
            // textContent, not innerHTML: the display name was typed by
            // whoever claimed that archive, so it is somebody else's text
            // being drawn on this page.
            link.textContent = membership.missionaryDisplayName || membership.slug;
            item.appendChild(link);
            list.appendChild(item);
        }

        box.hidden = false;
    }

    // The archive said no. Almost always this is the right person on the wrong
    // account -- an invitation accepted on one, the link opened on another --
    // so name the account and offer the way out, rather than a flat sentence
    // that leaves them with nothing to try.
    async function showDenied() {
        elements.state.hidden = true;

        // Every membership, none excluded: the slug in the address bar is by
        // definition not one of theirs.
        showSwitcher(null);

        // Signing out returns them here, where the missing session turns into
        // the ordinary 401 redirect to the chooser. One mechanism, already
        // built, rather than a second hand-assembled round trip through login.
        document.getElementById('denied-switch').href =
            `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(window.location.pathname)}`;

        // Only claimed when known. Telling somebody which account they are on
        // and being wrong about it is worse than not saying.
        const principal = await readPrincipal();
        if (principal?.userDetails) {
            document.getElementById('denied-email').textContent = principal.userDetails;
            document.getElementById('denied-who').hidden = false;
        }

        document.getElementById('denied').hidden = false;
    }

    // Which account is this page answering for. Worth saying out loud: the
    // archive is matched on email address, so someone signed in with the wrong
    // one of their accounts sees a refusal with no clue why.
    //
    // Cosmetic, and deliberately silent on failure -- the letters are the point
    // and they have already loaded by the time anyone reads the masthead.
    const PROVIDER_ICONS = {
        aad: { glyph: 'fa-microsoft', name: 'Microsoft' },
        google: { glyph: 'fa-google', name: 'Google' }
    };

    async function showAccount() {
        const box = document.getElementById('account');
        if (!box) return;

        const principal = await readPrincipal();
        if (!principal) return;

        // An unrecognised provider still gets the address, just without a mark.
        const provider = PROVIDER_ICONS[principal.identityProvider];
        if (provider) {
            document.getElementById('account-icon').classList.add('fa-brands', provider.glyph);
            document.getElementById('account-provider').textContent = `Signed in with ${provider.name}: `;
        }

        document.getElementById('account-email').textContent = principal.userDetails;
        box.hidden = false;
    }

    load();
    showAccount();
})();
