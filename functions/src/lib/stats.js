// How big is this service, and how big is each archive in it?
//
// The operator page could already answer "is mail still arriving" and could
// not answer "how much is here". Those are different questions with different
// failure modes: the first one is an alarm and the second one is a shape, and
// the shape is what tells you whether a slow month is a quiet service or a
// broken one.
//
// Assembled from what already exists, on the same terms as flow.js: the site
// rows, one scan of `memberships`, and each archive's own `posts.json`. Nothing
// here is authoritative about anything and nothing is written, so a wrong
// number on this page is a bug in a report rather than a bug in the service.
//
// **The letter and photograph counts cost one blob read per archive**, which is
// the only part of this that grows with the service. It is on its own route for
// that reason -- the arrivals table is the alarm and must not wait behind it,
// and a stats read that fails or times out leaves the alarm standing.
//
// **People are counted from `memberships`, not from each `acl.json`.** One
// table scan answers both halves at once: the rows group by slug for the
// per-archive count, and the distinct partition keys are the service-wide
// number. Counting ACLs would be a second blob read per archive to arrive at
// a total that then could not be de-duplicated -- a grandmother following two
// missionaries is one person, and reading two ACLs cannot see that.
//
// **Who is on the list and who actually reads it are different questions**, so
// `visits` is scanned too. Membership only ever grows; the number that can fall
// is the one worth watching. See visits.js.

import { TABLES } from './tables.js';
import { allSiteActivity } from './sites.js';
import { activeReaders } from './visits.js';

// How many archives are read at once. Storage is not the constraint; the
// Function's own socket pool is, and a hundred archives opened simultaneously
// is how a page that reports on health becomes the reason for an incident.
const AT_ONCE = 10;

/**
 * One archive's letters and photographs, or zeroes when it has none yet.
 *
 * A missing `posts.json` is the ordinary state of an archive that has been
 * claimed and has not received anything, so it is not an error. Anything else
 * that goes wrong is reported as zeroes too: this is a report, and a report
 * that throws takes down four other tables with it.
 */
async function contentOf({ store, slug, log }) {
    let posts;
    try {
        const blob = await store.readBlob('rendered', `${slug}/posts.json`);
        posts = blob ? JSON.parse(Buffer.from(blob.bytes).toString('utf8')) : [];
    } catch (error) {
        log?.warn?.('stats: could not read posts', { slug, error: error.message });
        return { letters: 0, hidden: 0, photos: 0 };
    }

    if (!Array.isArray(posts)) return { letters: 0, hidden: 0, photos: 0 };

    return {
        letters: posts.length,
        // Counted separately rather than subtracted out. A family hiding half
        // their letters is a thing worth seeing, and it is invisible in a
        // total that has already had them removed.
        hidden: posts.filter((post) => post.hidden).length,
        photos: posts.reduce((n, post) => n + (post.photos?.length ?? 0), 0)
    };
}

/** Runs `job` over `items` a few at a time, in order. */
async function inBatches(items, size, job) {
    const done = [];
    for (let i = 0; i < items.length; i += size) {
        done.push(...(await Promise.all(items.slice(i, i + size).map(job))));
    }
    return done;
}

/**
 * Every archive, what is in it, and the totals across all of them.
 *
 * @returns {Promise<{totals: object, archives: Array<object>}>}
 */
export async function serviceStats({ store, tables, log, now }) {
    const sites = await allSiteActivity({ tables });

    const memberships = await tables.listEntities(TABLES.memberships);

    // How many of those people actually came. Same de-duplication argument as
    // the membership scan below, and the same answer: read once, group twice.
    const reading = await activeReaders({ tables, now, log });

    // Slug -> people, and every address that belongs to anything. The distinct
    // set is the honest service-wide number: summing the per-archive counts
    // would count a grandmother following two missionaries twice.
    const peopleBySlug = new Map();
    const everyone = new Set();
    for (const row of memberships) {
        peopleBySlug.set(row.rowKey, (peopleBySlug.get(row.rowKey) ?? 0) + 1);
        everyone.add(row.partitionKey);
    }

    const archives = await inBatches(sites, AT_ONCE, async (site) => ({
        slug: site.slug,
        people: peopleBySlug.get(site.slug) ?? 0,
        daily: reading.bySlug.get(site.slug)?.daily ?? 0,
        monthly: reading.bySlug.get(site.slug)?.monthly ?? 0,
        ...(await contentOf({ store, slug: site.slug, log }))
    }));

    const sum = (field) => archives.reduce((total, archive) => total + archive[field], 0);

    return {
        totals: {
            archives: archives.length,
            letters: sum('letters'),
            hidden: sum('hidden'),
            photos: sum('photos'),
            people: everyone.size,
            // Not `sum('daily')`: somebody who opened two archives this morning
            // is one person here and two there, and both readings are wanted.
            daily: reading.totals.daily,
            monthly: reading.totals.monthly
        },
        archives
    };
}
