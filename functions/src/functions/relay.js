import { app } from '@azure/functions';
import { blobStore, mailer, signingKey } from '../lib/clients.js';
import { jsonResponse as json } from '../lib/api.js';
import { setting } from '../lib/settings.js';
import { readRelay, requestRelay } from '../lib/relay.js';

// Asking the missionary to vouch for a family member.
//
// Anonymous, like the opt-out, and for the same reason: the person holding
// this link has never signed in and is not going to. The signature on the
// token is the whole of the authorisation, and it names both parties, so
// there is nothing here for a caller to substitute.
//
// POST for both, including the read. A GET that sends mail would be sent by
// the first link scanner to open the message, which would interrupt a
// missionary on nobody's behalf -- the exact outcome this flow is built to
// keep rare.

const baseUrl = () => setting('PUBLIC_BASE_URL', 'https://pdayletters.com');

async function tokenFrom(request) {
    try {
        return (await request.json())?.token ?? '';
    } catch {
        return '';
    }
}

export async function describe({ request, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const token = await tokenFrom(request);
    const read = token ? readRelay({ token, key }) : null;

    // Both addresses come back so the page can say who will be written to and
    // on whose behalf. Somebody who was forwarded this by mistake needs to be
    // able to see that before pressing anything.
    return json(
        200,
        read
            ? { status: 'ready', author: read.author, requester: read.requester }
            : { status: 'invalid' }
    );
}

export async function ask({ request, context, store, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const token = await tokenFrom(request);
    if (!token) return json(400, { status: 'invalid' });

    const result = await requestRelay({
        store,
        mailer: mailer(),
        token,
        key,
        baseUrl: baseUrl(),
        log: context
    });

    return json(result.status === 'ok' ? 200 : 400, { status: result.status });
}

app.http('relay-describe', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'relay/describe',
    handler: (request, context) => describe({ request, key: signingKey('relay', context) })
});

app.http('relay', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'relay',
    handler: (request, context) => ask({ request, context, store: blobStore(), key: signingKey('relay', context) })
});
