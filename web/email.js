// Email settings.
//
// The one page in the service that is about a person rather than an archive,
// which is why it is `/email` and not `/settings`. See the note in the markup.
//
// It exists as much for the families who were here before any of this as for
// new ones: nothing on the way in asks the question, so everybody's answer is
// off until they come here, and a preference nobody can find is the same as a
// preference that is not offered. The account menu is how they find it.

/* global Page */

const { $, show, aimSignIn } = Page;

// A rejected fetch is the network, not the answer. Distinguished from a 401
// here because they need opposite pages: one says sign in, the other says we
// are broken, and showing the wrong one sends somebody to authenticate
// against an outage.
async function call(method, payload, path = '/api/preferences') {
    try {
        const response = await fetch(path, {
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
    aimSignIn();
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

// Lifting a block, not choosing a frequency, so the whole panel goes rather
// than being left on screen saying something that has stopped being true.
async function resume() {
    const button = $('resume');
    button.disabled = true;

    const result = await call('DELETE', null, '/api/preferences/suppression');

    if (result.status === 401) return offerSignIn();

    if (!result.ok) {
        button.disabled = false;
        $('resume-said').textContent = 'That did not work. Please try again in a moment.';
        return;
    }

    $('suppressed').hidden = true;
    $('digest-as').textContent = 'We can email this address again.';
}

async function start() {
    const result = await call('GET');

    if (result.status === 401) return offerSignIn();
    if (!result.ok) return show('failed');

    $('digest').value = result.body.digestFrequency ?? 'off';
    $('suppressed').hidden = !result.body.suppressed;
    $('digest-as').textContent = result.body.email ? `Signed in as ${result.body.email}.` : '';
    $('digest-form').addEventListener('submit', save);
    $('resume').addEventListener('click', resume);

    show('ready');
}

start();
