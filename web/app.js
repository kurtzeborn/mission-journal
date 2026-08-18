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

    // --- how long they have been out --------------------------------------
    //
    // A clock at the top of the archive, counting up from the day the mission
    // began. It is the one thing on this page that is not a letter, and it
    // earns the space because it answers the question every visiting relative
    // asks first and nobody wants to work out on their fingers.
    //
    // Only drawn when the owner has filled the date in, which most have not.
    // A counter reading zero, or a blank where a number belongs, is worse than
    // no counter at all.

    const DAY = 86400000;
    const HOUR = 3600000;
    const MINUTE = 60000;
    const SECOND = 1000;

    // Local midnight, deliberately not `new Date('2025-06-15')`. That form is
    // parsed as UTC, so a family in Utah would watch the day tick over at six
    // in the evening -- a bug nobody would report and everybody would notice.
    const startOfDay = (iso) => {
        const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
        if (!parts) return null;
        const when = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
        return Number.isNaN(when.getTime()) ? null : when;
    };

    // Days and a clock, rather than years and months. Months are the ambiguous
    // unit -- "one year, five months" is a different length depending on which
    // five -- and a mission is short enough that the day count stays a number
    // people can hold in their head.
    const spell = (ms) => {
        const days = Math.floor(ms / DAY);
        const rest = ms - days * DAY;
        const pad = (n) => String(n).padStart(2, '0');
        const clock = `${pad(Math.floor(rest / HOUR))}:${pad(Math.floor(rest / MINUTE) % 60)}:${pad(Math.floor(rest / SECOND) % 60)}`;
        return `${days} ${days === 1 ? 'day' : 'days'}, ${clock}`;
    };

    function countUp(startDate) {
        const box = document.getElementById('elapsed');
        const value = document.getElementById('elapsed-value');
        const from = startOfDay(startDate);
        if (!box || !value || !from) return;

        // Two years to the day, which is the longest a mission runs. Past that
        // the clock stops rather than being hidden: somebody who has come home
        // still served, and the archive is a record of it. Sisters serve
        // eighteen months and will see it stop early only if the owner also
        // fills in a return date, which nothing here reads yet.
        const until = new Date(from.getTime());
        until.setFullYear(until.getFullYear() + 2);

        // Returns true when there is nothing left to count.
        const tick = () => {
            const now = Date.now();
            // A start date in the future is a report date somebody typed
            // early. Nothing to show yet, and it appears on its own the day it
            // arrives without anybody reloading.
            if (now < from.getTime()) {
                box.hidden = true;
                return false;
            }

            value.textContent = spell(Math.min(now, until.getTime()) - from.getTime());
            box.hidden = false;
            return now >= until.getTime();
        };

        if (tick()) return;
        const timer = window.setInterval(() => {
            if (tick()) window.clearInterval(timer);
        }, SECOND);
    }

    // The version of the archive this page was drawn from. Sent back on every
    // write so the server can refuse one composed against a stale copy.
    let loadedEtag = null;

    // One call for both owner actions. Returns null on success -- having
    // reloaded the page -- and a sentence the owner can read on failure.
    async function send(method, postId, body, suffix = '') {
        const headers = {};
        if (body) headers['Content-Type'] = 'application/json';
        if (loadedEtag) headers['If-Match'] = loadedEtag;

        return call(method, postId, suffix, {
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
    }

    // The wire half of `send`, without the assumption that the body is JSON or
    // that the page has a version to defend. Pictures are sent as raw bytes,
    // and adding two in a row would fail on the second if it carried the ETag
    // the first one had just moved -- see the note on the API side.
    async function call(method, postId, suffix, init, reload = true) {
        let response;
        try {
            response = await fetch(
                `/api/posts/${encodeURIComponent(slug)}/${encodeURIComponent(postId)}${suffix}`,
                { method, redirect: 'manual', ...init }
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

        if (response.status === 413) {
            return 'That picture is too big. Nothing was changed.';
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
        if (reload) window.location.reload();
        return null;
    }

    // Pictures go up one at a time and the page is reloaded once at the end,
    // because each upload is its own commit and reloading between them would
    // throw away the rest of the selection. The first failure stops the run
    // and is reported with what did get through, since "three of five" is the
    // only honest thing to say and the owner needs to know which to retry.
    async function addPhotos(postId, files) {
        let done = 0;

        for (const file of files) {
            const failed = await call(
                'POST',
                postId,
                '/photos',
                {
                    headers: { 'Content-Type': file.type || 'application/octet-stream' },
                    body: file
                },
                false
            );

            if (failed) {
                if (!done) return failed;
                window.location.reload();
                return null;
            }
            done += 1;
        }

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
        document.title = `${heading} — Pday Letters`;

        countUp(payload.startDate);

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

        // Deleted, and not yet erased. Only ever sent to an operator, so this
        // draws whatever the server chose to disclose rather than deciding
        // anything itself.
        const deleted = payload.deleted;
        const deletedBanner = document.getElementById('deleted-banner');
        if (deletedBanner && deleted) {
            // The reader's own locale, matching /manage. An ISO timestamp is
            // the wrong thing to put in front of somebody deciding whether
            // there is still time to restore an archive.
            const shortDate = (value) => {
                const when = new Date(value);
                return Number.isNaN(when.getTime())
                    ? ''
                    : when.toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric'
                      });
            };

            const on = shortDate(deleted.purgeAfter);
            const by = deleted.deletedBy;

            // Assembled as text rather than markup, like everything else here,
            // and every part of it is optional: an operator deletion carries a
            // reason and an address, an owner's carries an address, and a row
            // written by an older build may carry neither. A sentence with a
            // hole in it is worse than a shorter sentence.
            const detail = document.getElementById('deleted-detail');
            const who = by ? ` by ${by}` : '';
            const when = shortDate(deleted.deletedAt);
            detail.textContent = on
                ? `Deleted${when ? ` on ${when}` : ''}${who}. Everything in it is erased on ${on}.`
                : `Deleted${when ? ` on ${when}` : ''}${who}.`;

            deletedBanner.hidden = false;
        }

        // Only owners get controls, and the API enforces that again on every
        // call -- this decides what to draw, not who is allowed to do it.
        const admin =
            payload.role === 'owner'
                ? {
                      patch: (postId, changes) => send('PATCH', postId, changes),
                      remove: (postId) => send('DELETE', postId),
                      restore: (postId) => send('POST', postId, null, '/restore'),
                      addPhotos,
                      removePhoto: (postId, photoId) =>
                          call('DELETE', postId, `/photos/${encodeURIComponent(photoId)}`, {}),
                      confirmDelete: (post) =>
                          window.confirm(
                              `Remove "${post.subject || 'Untitled'}" from the site?\n\n` +
                                  'The original letter is kept in the archive, so this can be ' +
                                  'undone by re-forwarding it. To take a letter out of view ' +
                                  'while you decide, use Hide instead.'
                          ),
                      // Names whose work is about to go, because it may not be
                      // this owner's -- an archive can have several, and
                      // there is no revision history to recover it from
                      // afterwards. Photos added here rather than emailed go
                      // with it: the letter is rebuilt from the message that
                      // arrived, and that message never had them.
                      confirmRestore: (post) =>
                          window.confirm(
                              `Put "${post.subject || 'Untitled'}" back to the letter that ` +
                                  'arrived?\n\n' +
                                  `This discards every change made to it${
                                      post.editedBy ? `, including ${post.editedBy}'s` : ''
                                  }, and any pictures added to it here. It cannot be undone.`
                          ),
                      // Asked only when the letter has been typed into, by the
                      // reader itself -- removing a picture is its own commit
                      // and reloads the page, and the edit in progress does
                      // not survive that. Says what is about to be lost rather
                      // than what is about to happen, because the picture
                      // going is the part the owner already asked for.
                      confirmPhotoDrop: () =>
                          window.confirm(
                              'Remove this picture now?\n\n' +
                                  'The letter reloads straight afterwards, so the changes you ' +
                                  'have not saved yet will be lost. Save first if you want to ' +
                                  'keep them.'
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

        // Up before the fetch and down whatever happens to it, including the
        // three paths below that draw nothing at all. A placeholder left
        // behind by a failed request is worse than the silence it replaced.
        const waiting = document.getElementById('switcher-wait');
        if (waiting) waiting.hidden = false;
        try {
            await drawSwitcher(box, list, except);
        } finally {
            if (waiting) waiting.hidden = true;
        }
    }

    async function drawSwitcher(box, list, except) {
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
