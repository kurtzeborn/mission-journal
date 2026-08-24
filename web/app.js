// The hosted reader's entry point.
//
// Everything specific to running on the website lives here: working out which
// archive was asked for, fetching it through the authenticated API, and
// handling an expired session. The drawing is Reader.mount(), which the
// downloaded zip calls with exactly the same arguments.

/* global Reader, Confirm */

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

    // --- the clock ---------------------------------------------------------
    //
    // One line at the top of the archive. It is the only thing on this page
    // that is not a letter, and it earns the space because it answers the
    // question every visiting relative asks first and nobody wants to work out
    // on their fingers.
    //
    // It reads three ways, and the label is the only thing that says which:
    // `Serving` while it counts up, `Home in` once there is a return date to
    // count down to, `Served` after that date has passed. Each is a word or
    // two rather than a caption, because the label and the number are one
    // phrase -- "Home in 2m 24d, 06:11:02" -- and a phrase fits on a line of
    // a phone where a caption and a reading did not.
    //
    // Only drawn when somebody has filled a date in, which most have not.
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

    // Calendar units, not fixed-length ones. A month is anything from 28 days
    // to 31, so the months are counted by stepping the start date forward one
    // at a time and measuring what is left over, rather than dividing by an
    // average that matches no month there has ever been.
    const addMonths = (date, n) => {
        const out = new Date(date.getTime());
        out.setDate(1);
        out.setMonth(out.getMonth() + n);
        // The 31st of a thirty-day month is its 30th, not the 1st of the month
        // after, which is where setMonth on its own would land it.
        const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
        out.setDate(Math.min(date.getDate(), last));
        return out;
    };

    // Wall-clock milliseconds, which is not elapsed milliseconds twice a year.
    // The day has to roll over at local midnight or the reading is a day out
    // for half the year, on the same reasoning that makes startOfDay local.
    const wall = (from, to) =>
        to.getTime() - from.getTime() + (from.getTimezoneOffset() - to.getTimezoneOffset()) * MINUTE;

    const breakdown = (from, to) => {
        let months = Math.max(
            (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth(),
            0
        );
        while (months > 0 && wall(addMonths(from, months), to) < 0) months -= 1;

        const rest = Math.max(wall(addMonths(from, months), to), 0);
        return {
            years: Math.floor(months / 12),
            months: months % 12,
            days: Math.floor(rest / DAY),
            rest: rest % DAY
        };
    };

    // Single letters, because the whole reading has to sit on one line of a
    // phone beside its label. Units before the first one that has a number in
    // it are dropped -- "0y 0m 6d" is six days -- and the days are always kept
    // so the reading is never empty.
    const span = ({ years, months, days }) => {
        const units = [[years, 'y'], [months, 'm'], [days, 'd']];
        while (units.length > 1 && units[0][0] === 0) units.shift();
        return units.map(([n, unit]) => `${n}${unit}`).join(' ');
    };

    const spell = (from, to) => {
        const cut = breakdown(from, to);
        const pad = (n) => String(n).padStart(2, '0');
        const clock = `${pad(Math.floor(cut.rest / HOUR))}:${pad(Math.floor(cut.rest / MINUTE) % 60)}:${pad(Math.floor(cut.rest / SECOND) % 60)}`;
        return `${span(cut)}, ${clock}`;
    };

    function runClock(startDate, returnDate) {
        const box = document.getElementById('elapsed');
        const label = document.getElementById('elapsed-label');
        const value = document.getElementById('elapsed-value');
        const from = startOfDay(startDate);
        const home = startOfDay(returnDate);
        if (!box || !label || !value || (!from && !home)) return;

        // Two years to the day, which is the longest a mission runs. It is a
        // stand-in for a return date and nothing else, so it applies only
        // where there is no real one: past it the clock stops rather than
        // being hidden, because somebody who has come home still served.
        // Sisters serve eighteen months and will see it stop late unless the
        // owner fills the return date in.
        const until = from && new Date(from.getTime());
        if (until) until.setFullYear(until.getFullYear() + 2);

        const say = (word, reading) => {
            label.textContent = word;
            value.textContent = reading;
            box.hidden = false;
        };

        // Returns true when there is nothing left to count.
        const tick = () => {
            const now = Date.now();

            // A start date in the future is a report date somebody typed
            // early. Nothing to show yet, and it appears on its own the day it
            // arrives without anybody reloading.
            if (from && now < from.getTime()) {
                box.hidden = true;
                return false;
            }

            if (home && now < home.getTime()) {
                say('Home in', spell(new Date(now), home));
                return false;
            }

            if (home) {
                // A total, not a reading, so it loses the seconds and the
                // role that promises they are moving.
                if (!from) {
                    box.hidden = true;
                    return true;
                }
                value.removeAttribute('role');
                say('Served', span(breakdown(from, home)));
                return true;
            }

            say('Serving', spell(from, new Date(Math.min(now, until.getTime()))));
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

    // One call for both owner actions. Returns null on success and a sentence
    // the owner can read on failure. Reloads the page on the way out unless
    // the caller has more to do first.
    async function send(method, postId, body, suffix = '', reload = true) {
        const headers = {};
        if (body) headers['Content-Type'] = 'application/json';
        if (loadedEtag) headers['If-Match'] = loadedEtag;

        return call(
            method,
            postId,
            suffix,
            {
                headers,
                body: body ? JSON.stringify(body) : undefined
            },
            reload
        );
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

        // Prefixed differently from the rest, because the generic word for a
        // rejected request is "Refused" and on a picture that reads as a
        // judgment about what is in it. The only 415 an owner can provoke is
        // a file this site cannot decode.
        if (response.status === 415) {
            const detail = await response.json().catch(() => null);
            return `Upload failed: ${detail?.error ?? 'that file could not be read as a picture'}`;
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

    // Saving an edit: the letter, then the pictures crossed off during it.
    //
    // The order is not a preference. The letter is the only one of these that
    // carries an If-Match, and every photo removal moves the version it would
    // be holding -- send them the other way round and any edit that also
    // dropped a picture would come back a 412 against a copy that was current
    // when the owner pressed Save. They go one at a time rather than together
    // for the reason on `addPhotos` below: each is a read-modify-write of the
    // same list, and a handful in flight at once would spend the time
    // colliding and retrying.
    //
    // One reload, at the end. That is the whole point of collecting the
    // removals rather than sending each as it is clicked -- the old behavior
    // reloaded on every one, which cannot be done from inside an edit without
    // throwing the edit away.
    async function savePost(postId, changes, dropPhotos) {
        const failed = await send('PATCH', postId, changes, '', !dropPhotos.length);
        if (failed || !dropPhotos.length) return failed;

        for (const photoId of dropPhotos) {
            const stopped = await call(
                'DELETE',
                postId,
                `/photos/${encodeURIComponent(photoId)}`,
                {},
                false
            );

            // Deliberately not the sentence `call` produced. Every one of
            // those ends in some version of "nothing was changed", which was
            // true of a removal standing on its own and is a lie here -- the
            // letter went in a moment ago. Left on screen rather than reloaded
            // away, so the owner finds out that the two halves of one Save did
            // not both land.
            if (stopped) {
                return 'The letter was saved, but a picture could not be taken off it. Reload the page and try that part again.';
            }
        }

        window.location.reload();
        return null;
    }

    // Chrome reads File.type out of the Windows registry, which carries no
    // entry for .heic, .webp or .avif -- so on Windows the browser reports
    // nothing at all for three formats this site accepts, and the upload was
    // turned away as an unknown kind of file. The extension is the only other
    // thing we are told about it, and the server checks the bytes anyway.
    const TYPE_BY_EXTENSION = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        tif: 'image/tiff',
        tiff: 'image/tiff',
        bmp: 'image/bmp',
        heic: 'image/heic',
        heif: 'image/heif',
        avif: 'image/avif'
    };

    const typeOf = (file) =>
        file.type ||
        TYPE_BY_EXTENSION[String(file.name ?? '').split('.').pop().toLowerCase()] ||
        'application/octet-stream';

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
                    headers: { 'Content-Type': typeOf(file) },
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

        runClock(payload.startDate, payload.returnDate);

        const download = document.getElementById('download');
        if (download) {
            download.href = `/api/download/${encodeURIComponent(payload.slug)}/letters.zip`;
            download.hidden = false;
        }

        // The group these live in, which stays down on the refusal page: there
        // is no archive there for any of them to act on.
        const group = document.getElementById('menu-archive');
        if (group) group.hidden = false;

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

        // Owners only for the same reason, and for one more: making a book is
        // the act that puts a permanent object into the world with the
        // family's name on it.
        const book = document.getElementById('book');
        if (book && payload.role === 'owner') {
            book.href = `/book/${encodeURIComponent(payload.slug)}`;
            book.hidden = false;
        }

        // Not awaited: the letters are the point, and a menu entry that
        // appears a moment later costs nothing. Awaiting it would put a second
        // round trip in front of the content on every visit.
        showArchives(payload.slug);

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
                      patch: (postId, changes, dropPhotos = []) =>
                          savePost(postId, changes, dropPhotos),
                      remove: (postId) => send('DELETE', postId),
                      restore: (postId) => send('POST', postId, null, '/restore'),
                      addPhotos,
                      confirmDelete: (post) =>
                          Confirm.ask({
                              question: `Remove "${post.subject || 'Untitled'}" from the site?`,
                              detail:
                                  'The original letter is kept in the archive, so this can be ' +
                                  'undone by re-forwarding it. To take a letter out of view ' +
                                  'while you decide, use Hide instead.',
                              action: 'Delete'
                          }),
                      // Names whose work is about to go, because it may not be
                      // this owner's -- an archive can have several, and
                      // there is no revision history to recover it from
                      // afterwards. Photos added here rather than emailed go
                      // with it: the letter is rebuilt from the message that
                      // arrived, and that message never had them.
                      confirmRestore: (post) =>
                          Confirm.ask({
                              question: `Put "${
                                  post.subject || 'Untitled'
                              }" back to the letter that arrived?`,
                              detail: `This discards every change made to it${
                                  post.editedBy ? `, including ${post.editedBy}'s` : ''
                              }, and any pictures added to it here. It cannot be undone.`,
                              action: 'Restore original'
                          })
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
    async function showArchives(except) {
        const box = document.getElementById('archives');
        const list = document.getElementById('archives-list');
        const waiting = document.getElementById('archives-wait');
        if (!box || !list || !waiting) return;

        // The group goes up carrying the placeholder and comes down again
        // unless there turns out to be something to put in it. Nothing in the
        // masthead moves either way, because all of it is inside a panel that
        // is closed until somebody asks.
        box.hidden = false;
        waiting.hidden = false;
        try {
            box.hidden = !(await drawArchives(list, except));
        } finally {
            waiting.hidden = true;
        }
    }

    async function drawArchives(list, except) {
        let memberships;
        try {
            const response = await fetch('/api/memberships', { cache: 'no-store' });
            if (!response.ok) return false;
            memberships = (await response.json()).memberships;
        } catch {
            return false;
        }

        if (!Array.isArray(memberships)) return false;

        const others = memberships.filter((membership) => membership.slug !== except);
        // Nothing is drawn for the overwhelming majority, who have one archive
        // and would get an entry that can only tell them where they already
        // are.
        if (others.length === 0) return false;

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

        return true;
    }

    // The archive said no. Almost always this is the right person on the wrong
    // account -- an invitation accepted on one, the link opened on another --
    // so name the account and offer the way out, rather than a flat sentence
    // that leaves them with nothing to try.
    async function showDenied() {
        elements.state.hidden = true;

        // Every membership, none excluded: the slug in the address bar is by
        // definition not one of theirs.
        showArchives(null);

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
    // Twice over, because the trigger can only ever show it truncated and the
    // address is the whole point of saying it.
    //
    // Cosmetic, and deliberately silent on failure -- the letters are the point
    // and they have already loaded by the time anyone reads the masthead. The
    // menu itself is in the markup, so a failure here cannot take Sign out
    // down with it.
    const PROVIDER_ICONS = {
        aad: { glyph: 'fa-microsoft', name: 'Microsoft' },
        google: { glyph: 'fa-google', name: 'Google' }
    };

    async function showAccount() {
        const principal = await readPrincipal();
        if (!principal) return;

        // An unrecognized provider still gets the address, just without a mark.
        const provider = PROVIDER_ICONS[principal.identityProvider];
        if (provider) {
            document.getElementById('account-icon').classList.add('fa-brands', provider.glyph);
            document.getElementById('account-provider').textContent = `Signed in with ${provider.name}: `;
            document.getElementById('menu-provider').textContent = `Signed in with ${provider.name}`;
        }

        document.getElementById('account-email').textContent = principal.userDetails;
        document.getElementById('menu-address').textContent = principal.userDetails;
    }

    // A `details` stays open until its own summary is clicked again, which for
    // a menu means carrying it down the page.
    function closeMenuOnOutsideClick() {
        const menu = document.getElementById('menu');
        if (!menu) return;

        document.addEventListener('click', (event) => {
            if (menu.open && !menu.contains(event.target)) menu.open = false;
        });
    }

    load();
    showAccount();
    closeMenuOnOutsideClick();
})();
