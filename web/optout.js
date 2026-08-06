// The opt-out page.
//
// The same shape as invite.js -- token out of the fragment, into
// sessionStorage, stripped from the address bar, only ever leaves in a POST
// body -- and for one of the same reasons and one different one.
//
// The same reason: a token in a query string is in a server log before anybody
// has decided it should be.
//
// The different one: this page must not act on being loaded. Whoever is
// standing here was mailed a link, and the things that fetch mailed links
// before a person reads them are numerous and automated. If arriving were
// enough, a scanner would decide, and the person the message was for would
// stop hearing from us without ever knowing why.

const KEY = 'optout-token';

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
    // A rejected fetch is the network, not the answer. Left to propagate it
    // strands the page on whichever section was showing at the time, and this
    // is a page somebody is on because they are already annoyed with us.
    try {
        const response = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
    } catch {
        return { ok: false, status: 0, body: { status: 'unavailable' } };
    }
};

// Only two ways this goes wrong, and they need different sentences: the link
// is not one of ours, or we are broken. Telling somebody their link is bad
// when the fault is ours sends them off to re-copy something that was fine.
function fail(status) {
    const broken = status !== 'invalid';
    $('failed-title').textContent = broken ? 'Something is wrong on our end' : 'This link cannot be used';
    $('failed-detail').textContent = broken
        ? 'We cannot process this at the moment. It is not a problem with your link.'
        : 'The link is incomplete or was not created by us.';
    $('failed-help').textContent = broken
        ? 'Please try again shortly, or write to hello@pdayletters.com and we will stop the emails by hand.'
        : 'Links break when they wrap across lines in an email. Try copying the whole link from the message, or write to hello@pdayletters.com and we will stop the emails by hand.';
    show('failed');
}

async function submit(event, token) {
    event.preventDefault();
    $('stop-submit').disabled = true;
    show('working');

    const result = await post('/api/optout', { token });
    if (!result.ok || result.body.status !== 'ok') return fail(result.body.status ?? 'unavailable');

    sessionStorage.removeItem(KEY);
    $('done-summary').textContent = 'We will not email this address again.';
    show('done');
}

async function start() {
    const token = takeToken();
    if (!token) return fail('invalid');

    const described = await post('/api/optout/describe', { token });
    if (!described.ok) return fail(described.body.status ?? 'unavailable');
    if (described.body.status !== 'ready') return fail(described.body.status);

    // `textContent`. The address is inside the signature so it is ours rather
    // than a stranger's, but it is still an address somebody typed.
    $('ready-lede').textContent = `This will stop all email to ${described.body.email}.`;
    show('ready');

    $('stop-form').addEventListener('submit', (event) => submit(event, token));
}

start();
