// The invitation page.
//
// Everything claim.js says about the token applies here without change: it
// arrives in the fragment, moves straight into `sessionStorage`, is stripped
// from the address bar, and only ever leaves in a POST body. The reasoning is
// the same and so is the shape, which is why this file reads like that one.
//
// What differs is who is standing here. A claimant has letters of their own
// waiting; an invitee has been sent a link by a relative and may reasonably
// wonder whether it is a scam. So this page leads with the name of the person
// who invited them.

const KEY = 'invite-token';

const $ = (id) => document.getElementById(id);
const show = (id) => {
    for (const section of document.querySelectorAll('main > section')) section.hidden = true;
    $(id).hidden = false;
};

function takeToken() {
    const fromHash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (fromHash) {
        sessionStorage.setItem(KEY, fromHash);
        history.replaceState(null, '', location.pathname);
        return fromHash;
    }
    return sessionStorage.getItem(KEY) ?? '';
}

const post = async (path, payload) => {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
};

async function signedInAs() {
    try {
        const response = await fetch('/.auth/me');
        if (!response.ok) return null;
        return (await response.json())?.clientPrincipal?.userDetails ?? null;
    } catch {
        return null;
    }
}

const FAILURES = {
    invalid: {
        title: 'This invitation cannot be used',
        detail: 'The link is incomplete, was withdrawn, or was not created by us.',
        help: 'Links break when they wrap across lines in an email. Try copying the whole link from the message. If that does not work, ask whoever invited you to send a new one.'
    },
    expired: {
        title: 'This invitation has expired',
        detail: 'Invitations stop working after two weeks.',
        help: 'Ask whoever invited you to send another. It takes them a few seconds.'
    },
    accepted: {
        title: 'This invitation has already been used',
        detail: 'Somebody has already accepted it, and an invitation only works once.',
        help: 'If that was you, sign in and the archive will be waiting. If not, ask for a new invitation.'
    },
    gone: {
        title: 'That archive is no longer there',
        detail: 'The invitation is good, but the archive it points at does not exist any more.',
        help: 'Ask whoever invited you what happened to it.'
    },
    unavailable: {
        title: 'Something is wrong on our end',
        detail: 'We cannot check invitations at the moment. This is not a problem with your link.',
        help: 'Please try again shortly.'
    },
    unauthenticated: {
        title: 'You are not signed in',
        detail: 'The sign-in did not carry through to us, so we could not tell who to add.',
        help: 'Sign in again from this page. Your invitation is still good.'
    }
};

// Same fallback and same reasoning as claim.js: an unmapped status is likelier
// to be our fault than the holder's, and telling them their link is broken
// sends them off to re-copy something that was never the problem.
function fail(status) {
    const copy = FAILURES[status] ?? FAILURES.unavailable;
    $('failed-title').textContent = copy.title;
    $('failed-detail').textContent = copy.detail;
    $('failed-help').textContent = copy.help;
    show('failed');
}

function renderReady(described, principal) {
    // `textContent` throughout. `invitedBy` is an address an owner typed and
    // `missionary` is a name somebody typed into the claim form, so both are
    // attacker-supplied as far as this page is concerned.
    const whose = described.missionary
        ? `${described.missionary}'s letters`
        : 'a missionary\u2019s letters';

    $('ready-lede').textContent =
        `${described.invitedBy || 'Somebody'} has invited you to read ${whose}.`;

    $('ready-role').textContent =
        described.role === 'owner'
            ? 'You have been invited as an owner, so you will be able to read the letters, edit them, and invite other people.'
            : 'You have been invited as a reader, so you will be able to read the letters and download them.';

    if (principal) {
        $('accept-form').hidden = false;
        $('accept-as').textContent = `You are signed in as ${principal}. This is the address that will get access.`;
    } else {
        const back = encodeURIComponent(location.pathname);
        $('signin-aad').href = `/.auth/login/aad?post_login_redirect_uri=${back}`;
        $('signin-google').href = `/.auth/login/google?post_login_redirect_uri=${back}`;
        $('signin-block').hidden = false;
    }

    show('ready');
}

async function submit(event, token) {
    event.preventDefault();
    $('accept-submit').disabled = true;
    show('working');

    const result = await post('/api/invite/accept', { token });

    if (!result.ok || result.body.status !== 'ok') {
        if (result.status === 401) {
            // The chooser, not a provider. This page offered both a moment ago;
            // picking one here would send half the people whose session lapsed
            // mid-acceptance to an account the invitation was never for. The
            // token is in `sessionStorage`, so dropping the query string on the
            // way back is deliberate rather than lossy.
            location.href = `/login.html?post_login_redirect_uri=${encodeURIComponent(location.pathname)}`;
            return;
        }
        fail(result.body.status);
        return;
    }

    sessionStorage.removeItem(KEY);

    // Straight into the archive. A confirmation page here would only be a
    // second button saying what the first one already did.
    location.href = `/${result.body.slug}/`;
}

async function start() {
    const token = takeToken();
    if (!token) return fail('invalid');

    const described = await post('/api/invite/describe', { token });
    if (!described.ok) return fail(described.body.status ?? 'unavailable');
    if (described.body.status !== 'ready') return fail(described.body.status);

    const principal = await signedInAs();
    renderReady(described.body, principal);

    $('accept-form').addEventListener('submit', (event) => submit(event, token));
}

start();
