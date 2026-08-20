import { app } from '@azure/functions';
import { hardened, jsonResponse as json } from '../lib/api.js';
import { readPrincipal } from '../lib/principal.js';
import { tableStore } from '../lib/clients.js';
import { optedOut } from '../lib/optout.js';
import { DIGEST, readUser, setDigest, validFrequency } from '../lib/users.js';

// How often, if at all, we should write to the person signed in right now.
//
// The one endpoint in the service that takes no slug, because the thing it
// changes is not about an archive. A grandmother following two grandchildren
// has one inbox and one opinion, and asking her twice would be asking the
// wrong question twice.
//
// It is therefore also the one settings surface a *reader* can reach.
// `/settings/{slug}` is owners only and always will be -- it names an archive
// and sets its display name -- and readers are precisely the audience the
// digest exists for.

const refuse = () => ({ status: 401, headers: hardened({ 'Cache-Control': 'no-store' }), body: '' });

export async function read({ request, tables }) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal?.email) return refuse();

    const row = await readUser({ tables, email: principal.email });

    return json(200, {
        email: principal.email,
        digestFrequency: validFrequency(row?.digestFrequency),
        // Reported separately rather than folded into the frequency, because
        // they are different statements and the page has to be able to say
        // which one is in force. Somebody who pressed an unsubscribe link and
        // later wonders why nothing arrives is owed an answer better than a
        // dropdown that reads "monthly" and is lying.
        suppressed: await optedOut({ tables, email: principal.email }),
        // Whether this person has ever been asked. The claim and invitation
        // flows ask on the way in, so an empty answer here means somebody who
        // joined before any of this existed.
        answered: Boolean(row)
    });
}

export async function write({ request, tables }) {
    const principal = readPrincipal(request.headers.get('x-ms-client-principal'));
    if (!principal?.email) return refuse();

    const body = await request.json().catch(() => ({}));

    // Refused rather than coerced to `off`. Everywhere else in this service a
    // value that is not on the list becomes the safe one, and that is right
    // for a thing being read; here it would mean a typo in a client silently
    // switching somebody's mail off and reporting success.
    const wanted = String(body?.digestFrequency ?? '');
    if (![DIGEST.monthly, DIGEST.weekly, DIGEST.off].includes(wanted)) {
        return json(400, { error: 'digestFrequency must be monthly, weekly or off' });
    }

    await setDigest({ tables, email: principal.email, frequency: wanted });

    return json(200, { digestFrequency: wanted });
}

app.http('preferences-read', {
    authLevel: 'anonymous',
    methods: ['GET'],
    route: 'preferences',
    handler: (request) => read({ request, tables: tableStore() })
});

app.http('preferences-write', {
    authLevel: 'anonymous',
    methods: ['PUT'],
    route: 'preferences',
    handler: (request) => write({ request, tables: tableStore() })
});
