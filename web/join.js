// The landing page for an in-person QR invitation.
//
// The scanned code is checked immediately while the owner's Quick Join window
// is open, then kept in `sessionStorage` across the sign-in round trip so a
// visitor already in flight can finish even if the owner closes the window.

/* global Page */

const CODE_KEY = 'qr-invite-code';
const READY_KEY = 'qr-invite-ready';
const JOIN_AFTER_SIGNIN_KEY = 'qr-invite-join-after-signin';
const EMAIL_PROMPT_AFTER_JOIN_KEY = 'email-notification-prompt-after-join';

const { $, show, takeToken, aimSignIn } = Page;

const codeOf = (ready) => ready?.token || ready?.ticket || '';

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
        title: 'This QR code cannot be used',
        detail: 'The code is incomplete or was not created by Pday Letters.',
        help: 'Ask the archive owner to reopen Quick join.'
    },
    expired: {
        title: 'This QR code has expired',
        detail: 'The temporary invitation window has timed out.',
        help: 'Ask the archive owner to reopen Quick join and scan the new code.'
    },
    closed: {
        title: 'These invitations have ended',
        detail: 'The archive owner closed the QR invitation or opened a new one.',
        help: 'Ask them to open Quick join again.'
    },
    gone: {
        title: 'That archive is no longer there',
        detail: 'The invitation is valid, but its archive is unavailable.',
        help: 'Ask the archive owner what happened to it.'
    },
    unauthenticated: {
        title: 'You are not signed in',
        detail: 'The sign-in did not carry through, so we could not add you.',
        help: 'Sign in again from this page.'
    },
    unavailable: {
        title: 'Something is wrong on our end',
        detail: 'We cannot check this invitation right now.',
        help: 'Please try again shortly.'
    }
};

function fail(status) {
    const copy = FAILURES[status] ?? FAILURES.unavailable;
    $('failed-title').textContent = copy.title;
    $('failed-detail').textContent = copy.detail;
    $('failed-help').textContent = copy.help;
    sessionStorage.removeItem(CODE_KEY);
    sessionStorage.removeItem(READY_KEY);
    sessionStorage.removeItem(JOIN_AFTER_SIGNIN_KEY);
    show('failed');
}

function renderReady(ready, principal) {
    const code = codeOf(ready);
    const whose = ready.missionary
        ? `${ready.missionary}'s letters`
        : 'a missionary\u2019s letters';
    $('ready-lede').textContent =
        `${ready.invitedByName || ready.invitedBy || 'An archive owner'} is inviting people here to read ${whose}.`;

    if (principal) {
        if (code && sessionStorage.getItem(JOIN_AFTER_SIGNIN_KEY) === code) {
            void accept(null, ready);
            return;
        }
        $('accept-form').hidden = false;
        $('accept-as').textContent = `You are signed in as ${principal}. This account will get access.`;
    } else {
        aimSignIn();
        for (const id of ['signin-aad', 'signin-google']) {
            $(id).addEventListener('click', () => {
                sessionStorage.setItem(JOIN_AFTER_SIGNIN_KEY, code);
            });
        }
        $('signin-block').hidden = false;
    }
    show('ready');
}

async function accept(event, ready) {
    event?.preventDefault();
    $('accept-submit').disabled = true;
    show('working');

    const code = codeOf(ready);
    const result = await post('/api/qr-invite/accept', { token: code, ticket: code });
    if (!result.ok || result.body.status !== 'ok') {
        if (result.status === 401) {
            sessionStorage.setItem(JOIN_AFTER_SIGNIN_KEY, code);
            location.href = `/login.html?post_login_redirect_uri=${encodeURIComponent(location.pathname)}`;
            return;
        }
        fail(result.body.status);
        return;
    }

    sessionStorage.removeItem(READY_KEY);
    sessionStorage.removeItem(JOIN_AFTER_SIGNIN_KEY);
    sessionStorage.setItem(EMAIL_PROMPT_AFTER_JOIN_KEY, result.body.slug);
    location.href = `/${result.body.slug}/`;
}

async function start() {
    if (location.hash.startsWith('#') && location.hash.length > 1) {
        sessionStorage.removeItem(READY_KEY);
        sessionStorage.removeItem(JOIN_AFTER_SIGNIN_KEY);
    }

    let ready;
    const stored = sessionStorage.getItem(READY_KEY);
    if (stored) {
        try {
            ready = JSON.parse(stored);
        } catch {
            sessionStorage.removeItem(READY_KEY);
        }
    }

    if (!ready) {
        const token = takeToken(CODE_KEY);
        if (!token) return fail('invalid');

        const exchanged = await post('/api/qr-invite/exchange', { token });
        if (!exchanged.ok || exchanged.body.status !== 'ready') {
            return fail(exchanged.body.status ?? 'unavailable');
        }
        ready = { token, ...exchanged.body };
        sessionStorage.removeItem(CODE_KEY);
        sessionStorage.setItem(READY_KEY, JSON.stringify(ready));
    }

    const principal = await signedInAs();
    renderReady(ready, principal);
    $('accept-form').addEventListener('submit', (event) => accept(event, ready));
}

start();
