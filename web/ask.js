// The "ask the missionary" page.
//
// The same shape as optout.js -- token out of the fragment, into
// sessionStorage, stripped from the address bar, only ever leaves in a POST
// body -- and for both of the same reasons.
//
// The same reason: a token in a query string is in a server log before anybody
// has decided it should be.
//
// The stronger one here: this page must not act on being loaded. Pressing the
// button writes to a missionary, and the things that fetch mailed links before
// a person reads them are numerous and automated. If arriving were enough,
// every scanner in the path would spend somebody's letter-writing time on a
// request nobody made.

const KEY = 'relay-token';

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
    // strands the page on whichever section was showing at the time.
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

// Three ways this goes wrong and they need different sentences: the link is
// not one of ours, the link has run out, or we are broken. Telling somebody
// their link is bad when the fault is ours sends them off to re-copy something
// that was fine.
function fail(status) {
    const broken = status !== 'invalid';
    $('failed-title').textContent = broken ? 'Something is wrong on our end' : 'This link cannot be used';
    $('failed-detail').textContent = broken
        ? 'We cannot send the request at the moment. It is not a problem with your link.'
        : 'The link is incomplete, has expired, or was not created by us.';
    $('failed-help').textContent = broken
        ? 'Please try again shortly, or write to hello@pdayletters.com and we will sort it out by hand.'
        : 'Links break when they wrap across lines in an email. Try copying the whole link from the message, or write to hello@pdayletters.com.';
    show('failed');
}

async function submit(event, token, author) {
    event.preventDefault();
    $('ask-submit').disabled = true;
    show('working');

    const result = await post('/api/relay', { token });
    if (!result.ok || result.body.status !== 'ok') return fail(result.body.status ?? 'unavailable');

    sessionStorage.removeItem(KEY);
    $('done-summary').textContent = `We have asked ${author} to send you a link.`;
    show('done');
}

async function start() {
    const token = takeToken();
    if (!token) return fail('invalid');

    const described = await post('/api/relay/describe', { token });
    if (!described.ok) return fail(described.body.status ?? 'unavailable');
    if (described.body.status !== 'ready') return fail(described.body.status);

    const { author, requester } = described.body;

    // `textContent`. Both addresses are inside the signature, so they are ours
    // rather than a stranger's, but they are still addresses somebody typed.
    $('ready-lede').textContent =
        `We will email ${author} and ask them to forward a link to ${requester}.`;
    show('ready');

    $('ask-form').addEventListener('submit', (event) => submit(event, token, author));
}

start();
