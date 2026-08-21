// Email settings.
//
// The one page in the service that is about a person rather than an archive,
// which is why it is `/email` and not `/settings`. See the note in the markup.
//
// It exists as much for the families who were here before any of this as for
// new ones: nothing on the way in asks the question, so everybody's answer is
// off until they come here, and a preference nobody can find is the same as a
// preference that is not offered. The account menu is how they find it.

const $ = (id) => document.getElementById(id);
const show = (id) => {
    for (const section of document.querySelectorAll('main > section')) section.hidden = true;
    $(id).hidden = false;
};

// A rejected fetch is the network, not the answer. Distinguished from a 401
// here because they need opposite pages: one says sign in, the other says we
// are broken, and showing the wrong one sends somebody to authenticate
// against an outage.
async function call(method, payload) {
    try {
        const response = await fetch('/api/preferences', {
            method,
            headers: payload ? { 'Content-Type': 'application/json' } : {},
            body: payload ? JSON.stringify(payload) : undefined
        });
        return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
    } catch {
        return { ok: false, status: 0, body: {} };
    }
}

function offerSignIn() {
    const back = encodeURIComponent(location.pathname);
    $('signin-aad').href = `/.auth/login/aad?post_login_redirect_uri=${back}`;
    $('signin-google').href = `/.auth/login/google?post_login_redirect_uri=${back}`;
    show('signin');
}

async function save(event) {
    event.preventDefault();

    const button = $('digest-submit');
    button.disabled = true;

    const result = await call('PUT', { digestFrequency: $('digest').value });

    // A session can lapse while the page is open, and this page is one
    // somebody might leave sitting. Sending them back through sign-in is
    // better than a save that quietly did nothing.
    if (result.status === 401) return offerSignIn();

    button.disabled = false;
    $('digest-as').textContent = result.ok
        ? 'Saved.'
        : 'That did not save. Please try again in a moment.';
}

async function start() {
    const result = await call('GET');

    if (result.status === 401) return offerSignIn();
    if (!result.ok) return show('failed');

    $('digest').value = result.body.digestFrequency ?? 'off';
    $('suppressed').hidden = !result.body.suppressed;
    $('digest-as').textContent = result.body.email ? `Signed in as ${result.body.email}.` : '';
    $('digest-form').addEventListener('submit', save);

    show('ready');
}

start();
