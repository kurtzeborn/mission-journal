// The claim page.
//
// The token arrives in the URL fragment and must stay out of everything that
// records URLs: the access log, App Insights, the Referer header, and the link
// scanner that fetches mail links before their recipient sees them. So it is
// read from `location.hash`, immediately moved into `sessionStorage`, and
// stripped from the address bar. Every request that carries it is a POST with
// the token in the body.
//
// `sessionStorage` rather than a variable because claiming requires signing
// in, and signing in means leaving the page entirely and coming back. The
// fragment would not reliably survive that round trip; a same-origin session
// value does.

const KEY = 'claim-token';

const $ = (id) => document.getElementById(id);
const show = (id) => {
    for (const section of document.querySelectorAll('main > section')) section.hidden = true;
    $(id).hidden = false;
};

function takeToken() {
    const fromHash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (fromHash) {
        sessionStorage.setItem(KEY, fromHash);
        // Out of the address bar, so it is not shoulder-read, bookmarked, or
        // pasted into a support conversation along with the rest of the URL.
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
        const details = (await response.json())?.clientPrincipal;
        return details?.userDetails ?? null;
    } catch {
        return null;
    }
}

// Every refusal says what to do next. A person on this page has letters they
// cannot reach and no relationship with anyone who could help, so a bare
// "invalid link" is the worst possible answer.
const FAILURES = {
    invalid: {
        title: 'This link cannot be used',
        detail: 'The link is incomplete or was not created by us.',
        help: 'Links break when they wrap across lines in an email. Try copying the whole link from the message and pasting it into your browser.'
    },
    expired: {
        title: 'This link has expired',
        detail: 'Claim links stop working after a while, for the same reason they are only sent to the people the letters were addressed to.',
        help: 'The next letter that arrives will bring a fresh link.'
    },
    superseded: {
        title: 'A newer link was sent',
        detail: 'This link was replaced when a more recent one was issued.',
        help: 'Look for the most recent message from us and use the link in that one.'
    },
    claimed: {
        title: 'This archive has already been set up',
        detail: 'Someone has already claimed it, and the letters have been published to them.',
        help: 'If that was not you, ask whoever set it up to add your email address as a reader.'
    },
    gone: {
        title: 'These letters are no longer waiting',
        detail: 'The archive was either set up already or the letters passed the date they are held until.',
        help: 'If letters are still arriving, a new link will come with the next one.'
    },
    owned: {
        title: 'This archive already has someone looking after it',
        detail: 'It was set up by another route while this link was on its way to you.',
        help: 'Ask whoever set it up to add your email address, and the letters will show up for you.'
    },
    unavailable: {
        title: 'Something is wrong on our end',
        detail: 'We cannot check links at the moment. This is not a problem with your link.',
        help: 'Please try again shortly.'
    },
    unauthenticated: {
        title: 'You are not signed in',
        detail: 'The sign-in did not carry through to us, so we could not tell who to give the archive to.',
        help: 'Sign in again from this page. Your link is still good.'
    }
};

// The fallback is `unavailable`, not `invalid`, and the difference is not
// cosmetic. An unmapped status is by definition one this page did not
// anticipate -- which makes it far likelier to be our fault than theirs -- and
// `invalid` tells the claimant their link is broken and suggests they re-copy
// it out of the email. That is a dead end dressed up as an instruction, and it
// is what a real claimant was actually shown when `unauthenticated` fell
// through this branch. `unavailable` says the true thing in that situation:
// something is wrong here, your link is fine, try again.
function fail(status) {
    const copy = FAILURES[status] ?? FAILURES.unavailable;
    $('failed-title').textContent = copy.title;
    $('failed-detail').textContent = copy.detail;
    $('failed-help').textContent = copy.help;
    show('failed');
}

function renderReady(described, principal) {
    // Two different links land here, and the `claim@` one lands in two
    // different situations. The pending link goes to somebody who did not ask
    // for it and has to be convinced the letters are real -- hence the count
    // and the sample subjects. The `claim@` link answers a request its
    // recipient made minutes ago, and the site is usually already running
    // under a parent, in which case "letters are waiting", "set up the
    // archive" and "makes you its owner" are all simply untrue.
    const missionary = described.kind === 'missionary';
    // A third link, and the one whose holder was told the least. It reached
    // them via the missionary, who was asked to pass it on, so the page has to
    // say what it is for without any letters to point at -- there are none,
    // because the letter that started this was the one we could not accept.
    const relay = described.kind === 'relay';
    // Joining an archive that exists, rather than bringing one into being. The
    // server knows which, so the page does not have to hedge.
    const joining = missionary && Boolean(described.alreadyOwned);

    if (relay) {
        $('ready-title').textContent = 'Set up this archive';
        $('ready-lede').textContent =
            `${described.sender || 'A missionary'} passed this link on, which is how they say yes. ` +
            'Signing in below sets the archive up under the account you choose.';
        $('ready-owner-note').textContent =
            'Setting the archive up makes you its owner. Once you are in, forward the letters ' +
            'you have kept and they will go straight in — from any mail program, including the ' +
            'one that would not work before.';
    } else if (missionary) {
        $('ready-title').textContent = 'Your archive';
        $('ready-lede').textContent = joining
            ? 'You asked for access to your letters. Signing in below adds this archive to the account you choose.'
            : 'You asked for access to your letters. Signing in below sets the archive up under the account you choose.';
        $('ready-owner-note').textContent = joining
            ? 'Use a personal account rather than your missionary one, which stops working 60 days ' +
              'after you come home. Whoever looks after this archive today stays, and you are added alongside them.'
            : 'Use a personal account rather than your missionary one, which stops working 60 days ' +
              'after you come home. Setting the archive up makes you its owner.';
    } else {
        const count = described.messageCount ?? 0;
        $('ready-count').textContent = count === 1 ? '1 letter' : `${count} letters`;
        $('ready-sender').textContent = described.sender || 'a missionary';
    }

    const subjects = described.sampleSubjects ?? [];
    if (subjects.length) {
        const list = $('ready-subjects');
        list.textContent = '';
        for (const subject of subjects) {
            const item = document.createElement('li');
            item.textContent = subject;
            list.appendChild(item);
        }
        $('ready-subjects-block').hidden = false;
    }

    if (principal) {
        $('claim-form').hidden = false;

        // A site that has been running for months already has a name, and
        // asking for one from scratch invites an answer that quietly replaces
        // it. Showing the current value turns the question into one that can be
        // left alone -- and leaving it alone writes nothing, because the server
        // compares what comes back against what it sent.
        if (described.displayName) {
            $('display-name').value = described.displayName;
            $('display-name-label').textContent = 'The missionary is shown on the site as:';
        }

        $('claim-submit').textContent = joining ? 'Get access' : 'Set up the archive';
        $('claim-as').textContent = missionary
            ? `You are signed in as ${principal}. This address will be added as an owner.`
            : `You are signed in as ${principal}. This address will own the archive.`;    } else {
        // Come back to this page after signing in. The token is already in
        // sessionStorage, so it does not need to survive the redirect itself.
        const back = encodeURIComponent(location.pathname);
        $('signin-aad').href = `/.auth/login/aad?post_login_redirect_uri=${back}`;
        $('signin-google').href = `/.auth/login/google?post_login_redirect_uri=${back}`;
        $('signin-block').hidden = false;
    }

    show('ready');
}

async function submit(event, token, described) {
    event.preventDefault();
    $('claim-submit').disabled = true;

    if (described.alreadyOwned) {
        $('working-title').textContent = 'Getting you access\u2026';
        $('working-note').textContent = 'This only takes a moment.';
    }
    show('working');

    const result = await post('/api/claim/redeem', {
        token,
        displayName: $('display-name').value
    });

    if (!result.ok || result.body.status !== 'ok') {
        if (result.status === 401) {
            // The chooser, not a provider. This page offered both a moment ago;
            // picking one here would send half the people whose session lapsed
            // mid-claim to an account the invitation was never for. The token
            // is in `sessionStorage`, so dropping the query string on the way
            // back is deliberate rather than lossy.
            location.href = `/login.html?post_login_redirect_uri=${encodeURIComponent(location.pathname)}`;
            return;
        }
        fail(result.body.status);
        return;
    }

    sessionStorage.removeItem(KEY);

    const promoted = result.body.promoted ?? {};
    const published = promoted.promoted ?? 0;

    // A missionary joining a live archive has no backlog to publish, and "0
    // letters have been published" describes a failure that did not happen.
    if (published === 0) {
        $('done-title').textContent = 'You are in';
        $('done-summary').textContent =
            'This archive is linked to your account now, and new letters will appear as they arrive.';
    } else {
        $('done-summary').textContent =
            published === 1
                ? 'One letter has been published, and new ones will appear as they arrive.'
                : `${published} letters have been published, and new ones will appear as they arrive.`;
    }

    $('done-link').href = `/${result.body.slug}/`;
    show('done');
}

async function start() {
    const token = takeToken();
    if (!token) return fail('invalid');

    const described = await post('/api/claim/describe', { token });
    if (!described.ok) return fail(described.body.status ?? 'unavailable');
    if (described.body.status !== 'ready') return fail(described.body.status);

    const principal = await signedInAs();
    renderReady(described.body, principal);

    $('claim-form').addEventListener('submit', (event) => submit(event, token, described.body));
}

start();
