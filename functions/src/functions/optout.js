import { app } from '@azure/functions';
import { signingKey, tableStore } from '../lib/clients.js';
import { jsonResponse as json } from '../lib/api.js';
import { readOptOut, recordOptOut } from '../lib/optout.js';

// Stopping our mail.
//
// Anonymous, and it has to be: the person using it has never signed in, is not
// going to, and requiring them to would be a way of making the opt-out
// technically available and practically impossible.
//
// Two callers, one endpoint:
//
//   A **person**, from `/optout`, whose page posts the token in a body. The
//   token reached them in the URL fragment, as every other link in this
//   service does.
//
//   A **mail provider**, from the `List-Unsubscribe` header, which posts to
//   `?t=<token>` with no body at all. RFC 8058 -- and it is a POST rather than
//   a GET for exactly the reason this file cares about: providers and
//   corporate scanners fetch links before a human sees them, and an opt-out
//   spent by a scanner silences somebody who never asked for it.
//
// Both are POST, so neither can be triggered by fetching a URL.

async function tokenFrom(request) {
    const fromQuery = request.query?.get?.('t');
    if (fromQuery) return fromQuery;
    try {
        return (await request.json())?.token ?? '';
    } catch {
        return '';
    }
}

export async function describe({ request, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const token = await tokenFrom(request);
    const read = token ? readOptOut({ token, key }) : null;

    // The address comes back so the page can show whose mail is about to stop.
    // Not a disclosure: holding this token means having been sent the message
    // it travelled in.
    return json(200, read ? { status: 'ready', email: read.email } : { status: 'invalid' });
}

export async function stop({ request, context, tables, key }) {
    if (!key) return json(503, { status: 'unavailable' });

    const token = await tokenFrom(request);
    if (!token) return json(400, { status: 'invalid' });

    const result = await recordOptOut({ tables, token, key, log: context });

    // 200 either way for the provider's benefit: a one-click unsubscribe that
    // answers 4xx gets retried and, in some clients, reported to the user as a
    // failure to unsubscribe. An invalid token is not something the person
    // pressing the button can do anything about.
    return json(result.status === 'ok' ? 200 : 400, { status: result.status });
}

app.http('optout-describe', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'optout/describe',
    handler: (request, context) => describe({ request, key: signingKey('optout', context) })
});

app.http('optout', {
    authLevel: 'anonymous',
    methods: ['POST'],
    route: 'optout',
    handler: (request, context) => stop({ request, context, tables: tableStore(), key: signingKey('optout', context) })
});
