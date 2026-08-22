// What somebody is shown when an archive refuses them.
//
// This is the page an invitation most often goes wrong on, and it goes wrong
// in a way that looks like the service losing the letters: an invitation is
// accepted on one account, the link is opened later on a phone signed in to
// another, and the archive answers exactly as it would for an archive that
// does not exist. The API cannot tell those two apart -- that is deliberate,
// it is what stops the site list being enumerable -- so the page cannot claim
// which one happened. What it can do is name the account being refused, which
// is the one fact the visitor cannot see for themselves.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

const SLUG = 'elder.example';

async function archive({ answer, path = `/${SLUG}/` }) {
    const view = page({ html: 'site.html', path });
    // The reader itself is not under test here; only what happens instead of
    // it when the letters never arrive.
    view.context.Reader = { mount() {} };
    const net = fetching(answer);
    run('app.js', { context: view.context, fetch: net.fetch });
    await settled();
    return { ...view, calls: net.calls };
}

const signedIn = (email, provider = 'google') => ({
    status: 200,
    body: { clientPrincipal: { userDetails: email, identityProvider: provider } }
});

describe('being turned away from an archive', () => {
    test('names the account, because that is the usual mistake', async () => {
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('other@example.com') : { status: 404, body: {} }
        });

        assert.equal(view.el('denied').hidden, false);
        assert.equal(view.el('denied-who').hidden, false);
        assert.equal(view.text('denied-email'), 'other@example.com');
        // The loading line has to go, or the page says both things at once.
        assert.equal(view.el('state').hidden, true);
    });

    test('offers a way back to the sign-in chooser, returning here', async () => {
        // Signing out and being dropped on the front page means finding the
        // archive again from an invitation email they may have deleted.
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('other@example.com') : { status: 404, body: {} }
        });

        assert.equal(
            view.el('denied-switch').href,
            `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(`/${SLUG}/`)}`
        );
    });

    test('says nothing about the account when it cannot find out which one', async () => {
        // Telling somebody which account they are on and being wrong about it
        // is worse than not saying.
        const view = await archive({
            answer: async (url) => (url === '/.auth/me' ? new Error('offline') : { status: 404, body: {} })
        });

        assert.equal(view.el('denied').hidden, false);
        assert.equal(view.el('denied-who').hidden, true);
        assert.equal(view.text('denied-email'), '');
    });

    test('asks for the identity once, not once per thing that wants it', async () => {
        // The masthead and the panel both need it and both run at once.
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('other@example.com') : { status: 404, body: {} }
        });

        assert.equal(view.calls.filter((c) => c.url === '/.auth/me').length, 1);
    });

    test('an expired session is a sign-in, not a refusal', async () => {
        // A 401 means "we do not know who you are", which is a different
        // sentence from "these are not yours" and has a different remedy.
        const view = await archive({ answer: async () => ({ status: 401, body: {} }) });

        assert.equal(view.el('denied').hidden, true);
        assert.match(view.context.location.href, /login\.html\?post_login_redirect_uri/);
    });

    test('the letters loading is not a refusal', async () => {
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me'
                    ? signedIn('mum@example.com')
                    : { status: 200, body: { slug: SLUG, role: 'reader', posts: [] } }
        });

        assert.equal(view.el('denied').hidden, true);
        assert.equal(view.el('download').hidden, false);
        // A reader has no use for a page that would refuse them.
        assert.equal(view.el('people').hidden, true);
    });

    test('an owner is offered the People page from the archive itself', async () => {
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me'
                    ? signedIn('mum@example.com')
                    : { status: 200, body: { slug: SLUG, role: 'owner', posts: [] } }
        });

        assert.equal(view.el('people').hidden, false);
        assert.equal(view.el('people').href, `/people/${SLUG}`);
    });
});

// Reaching the other archives you belong to.
//
// There is no dashboard, and every archive is behind a sign-in, so somebody
// who loses one URL has the signed-in root redirect and this list and nothing
// else. It is also the reason it appears on the refusal page: a person who has
// just been told no is exactly the person who has lost a URL.
describe('the other archives in the menu', () => {
    const belongsTo = (...slugs) => ({
        status: 200,
        body: {
            memberships: slugs.map((slug) => ({
                slug,
                missionaryDisplayName: `Elder ${slug.split('.')[1]}`
            }))
        }
    });

    const reading = (memberships, archiveAnswer = { status: 200, body: { slug: SLUG, role: 'reader', posts: [] } }) =>
        archive({
            answer: async (url) => {
                if (url === '/.auth/me') return signedIn('gran@example.com');
                if (url === '/api/memberships') return memberships;
                return archiveAnswer;
            }
        });

    test('does not appear for the one archive somebody is already reading', async () => {
        // Which is nearly everybody. An entry whose only possible answer is
        // "you are already here" is friction between them and the letters.
        const view = await reading(belongsTo(SLUG));

        assert.equal(view.el('archives').hidden, true);
    });

    test('lists the others by name when there is more than one', async () => {
        const view = await reading(belongsTo(SLUG, 'sister.backman'));

        assert.equal(view.el('archives').hidden, false);
        assert.deepEqual(view.lines('archives-list'), ['Elder backman']);
    });

    test('links to the archive, not to a page about it', async () => {
        const view = await reading(belongsTo(SLUG, 'sister.backman'));

        assert.equal(view.link('archives-list', 'Elder backman').href, '/sister.backman/');
    });

    test('falls back to the slug when an archive has never been named', async () => {
        const view = await reading({
            status: 200,
            body: { memberships: [{ slug: SLUG }, { slug: 'sister.backman' }] }
        });

        assert.deepEqual(view.lines('archives-list'), ['sister.backman']);
    });

    test('offers every archive to somebody who has just been refused', async () => {
        // Nothing is excluded here: the slug in the address bar is by
        // definition not one of theirs.
        const view = await reading(belongsTo('sister.backman', 'elder.other'), { status: 404, body: {} });

        assert.equal(view.el('denied').hidden, false);
        assert.deepEqual(view.lines('archives-list'), ['Elder backman', 'Elder other']);
    });

    test('stays out of the way when the list cannot be fetched', async () => {
        // The letters are the point and they have already loaded. An error in
        // a masthead convenience must not be the thing anybody reads.
        const view = await reading({ status: 500, body: {} });

        assert.equal(view.el('archives').hidden, true);
    });

    test('does not put a second round trip in front of the letters', async () => {
        const view = await reading(belongsTo(SLUG, 'sister.backman'));

        assert.equal(view.el('download').hidden, false);
    });
});

// The clock at the top of the archive.
//
// It is the only thing on the page that is not a letter, and the only one that
// can be wrong while looking perfectly fine -- a number nobody can check by
// eye, in front of the people who care most about it. So the tests here are
// about the boundaries rather than the arithmetic: which of the three readings
// it picks, when it appears at all, when it stops, and what it does with a
// date it cannot use.
describe('how long they have been out', () => {
    const day = 86400000;

    // Built from local parts rather than by subtracting from an ISO string,
    // because the value under test is a calendar day and `toISOString` is UTC.
    const onDay = (n) => {
        const when = new Date(Date.now() + n * day);
        const pad = (v) => String(v).padStart(2, '0');
        return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
    };

    const daysAgo = (n) => onDay(-n);
    const daysAhead = (n) => onDay(n);

    const loaded = (startDate, returnDate) =>
        archive({
            answer: async (url) =>
                url === '/.auth/me'
                    ? signedIn('gran@example.com')
                    : {
                        status: 200,
                        body: { slug: SLUG, role: 'reader', startDate, returnDate, posts: [] }
                    }
        });

    test('is not shown at all when nobody has set a start date', async () => {
        // Which is every archive until somebody visits settings. A counter
        // reading zero is worse than no counter.
        const view = await loaded(undefined);

        assert.equal(view.el('elapsed').hidden, true);
        assert.equal(view.text('elapsed-value'), '');
        assert.equal(view.context.timers.length, 0);
    });

    test('counts up from the day the mission began', async () => {
        const view = await loaded(daysAgo(400));

        assert.equal(view.el('elapsed').hidden, false);
        assert.equal(view.text('elapsed-label'), 'Serving');
        assert.match(view.text('elapsed-value'), /^\d+ days, \d\d:\d\d:\d\d$/);

        // A day either side. This is elapsed time, not calendar subtraction,
        // and a clock change inside a window this long moves it by an hour.
        const days = Number(view.text('elapsed-value').split(' ')[0]);
        assert.ok(Math.abs(days - 400) <= 1, `counted ${days} days`);
    });

    test('turns round into a countdown once somebody says when they come home', async () => {
        // The number the family is actually watching, from the day there is
        // one to watch.
        const view = await loaded(daysAgo(400), daysAhead(84));

        assert.equal(view.el('elapsed').hidden, false);
        assert.equal(view.text('elapsed-label'), 'Home in');

        const days = Number(view.text('elapsed-value').split(' ')[0]);
        assert.ok(Math.abs(days - 83) <= 1, `counted ${days} days`);
    });

    test('the countdown ticks, and the total it becomes does not', async () => {
        assert.equal((await loaded(daysAgo(400), daysAhead(84))).context.timers.length, 1);
        assert.equal((await loaded(daysAgo(730), daysAgo(1))).context.timers.length, 0);
    });

    test('stays up once they are home, as a total rather than a reading', async () => {
        // Somebody who has come home still served, and the archive is the
        // record of it. But a total is not a thing that ticks, so it loses the
        // seconds and the role that promised they were moving.
        const view = await loaded(daysAgo(730), daysAgo(1));

        assert.equal(view.el('elapsed').hidden, false);
        assert.equal(view.text('elapsed-label'), 'Served');
        assert.equal(view.text('elapsed-value'), '729 days');
        assert.equal(view.el('elapsed-value').getAttribute('role'), null);
    });

    test('a return date that has passed with no start date has nothing to total', async () => {
        const view = await loaded(undefined, daysAgo(1));

        assert.equal(view.el('elapsed').hidden, true);
        assert.equal(view.context.timers.length, 0);
    });

    test('ticks once a second, and only once', async () => {
        const view = await loaded(daysAgo(400));

        assert.equal(view.context.timers.length, 1);
        assert.equal(view.context.timers[0].every, 1000);
    });

    test('stops at two years rather than counting a whole life', async () => {
        const view = await loaded(daysAgo(1200));

        assert.equal(view.el('elapsed').hidden, false);
        assert.equal(view.text('elapsed-label'), 'Serving');
        // Two calendar years to the day, so 730 or 731 depending on which two.
        assert.match(view.text('elapsed-value'), /^73[01] days, 00:00:00$/);
        // And never starts ticking, because there is nothing left to count.
        assert.equal(view.context.timers.length, 0);
    });

    test('says nothing until a start date in the future arrives', async () => {
        // A report date somebody typed early. It appears on its own the day it
        // comes round, which is why the clock is still running.
        const view = await loaded('2099-01-01');

        assert.equal(view.el('elapsed').hidden, true);
        assert.equal(view.context.timers.length, 1);
    });

    test('a date it cannot read leaves the page alone', async () => {
        for (const bad of ['', 'June 2025', '2025-6-5']) {
            const view = await loaded(bad, bad);
            assert.equal(view.el('elapsed').hidden, true, bad);
            assert.equal(view.context.timers.length, 0, bad);
        }
    });

    test('an unreadable return date falls back to counting up', async () => {
        const view = await loaded(daysAgo(400), 'sometime in June');

        assert.equal(view.text('elapsed-label'), 'Serving');
    });
});

// Waiting for the archive list.
//
// It is a second round trip and not a fast one. It is fetched into a panel
// that stays closed until somebody opens it, so nothing in the masthead moves
// -- but a menu opened mid-flight would otherwise show a group that is simply
// not there yet.
describe('the archive list says it is coming', () => {
    const membersOf = (...slugs) => ({
        status: 200,
        body: { memberships: slugs.map((slug) => ({ slug })) }
    });

    // The membership list is answered only when the test says so, which is
    // what lets it look at the page mid-flight.
    async function midFlight(answerMemberships) {
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });

        const view = page({ html: 'site.html', path: `/${SLUG}/` });
        view.context.Reader = { mount() {} };
        const net = fetching(async (url) => {
            if (url === '/.auth/me') return signedIn('gran@example.com');
            if (url === '/api/memberships') {
                await held;
                return answerMemberships;
            }
            return { status: 200, body: { slug: SLUG, role: 'reader', posts: [] } };
        });
        run('app.js', { context: view.context, fetch: net.fetch });
        await settled();

        return {
            ...view,
            async finish() {
                release();
                await settled();
            }
        };
    }

    test('says so in the menu while the list is being fetched', async () => {
        const view = await midFlight(membersOf(SLUG, 'sister.backman'));

        assert.equal(view.el('archives-wait').hidden, false);
        assert.equal(view.el('archives').hidden, false);
    });

    test('gives way to the real list when it arrives', async () => {
        const view = await midFlight(membersOf(SLUG, 'sister.backman'));

        await view.finish();

        assert.equal(view.el('archives-wait').hidden, true);
        assert.equal(view.el('archives').hidden, false);
    });

    test('goes away when there was nothing to draw', async () => {
        // The common case: one archive, and no list of others on its own page.
        // A placeholder that stays up is a list that never comes.
        const view = await midFlight(membersOf(SLUG));

        await view.finish();

        assert.equal(view.el('archives-wait').hidden, true);
        assert.equal(view.el('archives').hidden, true);
    });

    test('goes away when the list cannot be fetched at all', async () => {
        const view = await midFlight({ status: 500, body: {} });

        await view.finish();

        assert.equal(view.el('archives-wait').hidden, true);
        assert.equal(view.el('archives').hidden, true);
    });

    test('is not left up by a refusal, where the list still matters', async () => {
        // The list is drawn on the refusal page too, and with nothing excluded
        // -- somebody who has just been told no is exactly the person who has
        // lost a URL.
        const view = page({ html: 'site.html', path: `/${SLUG}/` });
        view.context.Reader = { mount() {} };
        const net = fetching(async (url) => {
            if (url === '/.auth/me') return signedIn('gran@example.com');
            if (url === '/api/memberships') return membersOf('sister.backman');
            return { status: 404, body: {} };
        });
        run('app.js', { context: view.context, fetch: net.fetch });
        await settled();

        assert.equal(view.el('denied').hidden, false);
        assert.equal(view.el('archives-wait').hidden, true);
        assert.equal(view.el('archives').hidden, false);
    });
});

// One control in the masthead, holding everything that is not a letter.
//
// The row it replaces held six side by side. A reader had no use for four of
// them, and on a phone the whole lot wrapped onto a second line and pushed the
// letters below the fold.
describe('the masthead menu', () => {
    const loaded = (role) =>
        archive({
            answer: async (url) => {
                if (url === '/.auth/me') return signedIn('gran@example.com');
                if (url === '/api/memberships') return { status: 200, body: { memberships: [] } };
                return { status: 200, body: { slug: SLUG, role, posts: [] } };
            }
        });

    test('names the account in full, which the trigger can only truncate', async () => {
        const view = await loaded('reader');

        assert.equal(view.text('account-email'), 'gran@example.com');
        assert.equal(view.text('menu-address'), 'gran@example.com');
        assert.equal(view.text('menu-provider'), 'Signed in with Google');
    });

    test('the way out does not wait on anything that can fail', async () => {
        // Sign out lives in here now, so the menu is in the markup rather than
        // drawn once /.auth/me has answered.
        const view = await archive({ answer: async () => new Error('offline') });

        assert.equal(view.el('menu').hidden, false);
        assert.match(view.source, /href="\/\.auth\/logout">Sign out/);
    });

    test('the archive group stays down for somebody who was refused', async () => {
        // There is no archive there for any of those entries to act on.
        const view = await archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('other@example.com') : { status: 404, body: {} }
        });

        assert.equal(view.el('menu-archive').hidden, true);
    });

    test('the archive group comes up with the letters', async () => {
        const view = await loaded('reader');

        assert.equal(view.el('menu-archive').hidden, false);
        assert.equal(view.el('download').hidden, false);
        assert.equal(view.el('book').hidden, true);
    });

    test('an open menu closes when the click lands somewhere else', async () => {
        const view = await loaded('reader');
        view.el('menu').open = true;

        await view.elsewhere('click');

        assert.equal(view.el('menu').open, false);
    });

    test('a click inside the menu leaves it open', async () => {
        const view = await loaded('reader');
        view.el('menu').open = true;

        await view.elsewhere('click', view.el('menu'));

        assert.equal(view.el('menu').open, true);
    });
});

// The banner an operator sees on an archive they do not belong to.
//
// It guards against the likeliest failure by a long way: an operator
// forgetting which hat they are wearing and editing a real family's letter.
describe('operator access is stated on the page', () => {
    const loaded = (body) =>
        archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('ops@pdayletters.com') : { status: 200, body }
        });

    test('says so when the authority came from the operator setting', async () => {
        const view = await loaded({ slug: SLUG, role: 'owner', viaOperator: true, posts: [] });

        assert.equal(view.el('operator-banner').hidden, false);
    });

    test('says nothing to an owner on their own archive', async () => {
        // A warning that fires when nothing is wrong is one people learn to
        // stop reading.
        const view = await loaded({ slug: SLUG, role: 'owner', viaOperator: false, posts: [] });

        assert.equal(view.el('operator-banner').hidden, true);
    });

    test('says nothing when the API does not mention it at all', async () => {
        const view = await loaded({ slug: SLUG, role: 'reader', posts: [] });

        assert.equal(view.el('operator-banner').hidden, true);
    });
});

// A deleted archive still renders in full to an operator, because the operator
// override resolves above the ACL that deletion removes. That access is
// wanted -- somebody about to restore an archive needs to look at it first --
// and it was completely silent, which is the part that was not.
describe('a deleted archive says so', () => {
    const loaded = (body) =>
        archive({
            answer: async (url) =>
                url === '/.auth/me' ? signedIn('ops@pdayletters.com') : { status: 200, body }
        });

    const DELETED = {
        slug: SLUG,
        role: 'owner',
        viaOperator: true,
        deleted: {
            deletedAt: '2026-08-11T20:56:41.257Z',
            deletedBy: 'dad@example.com',
            purgeAfter: '2026-09-10T20:56:41.257Z'
        },
        posts: []
    };

    test('names who deleted it and the date it is erased', async () => {
        const view = await loaded(DELETED);

        assert.equal(view.el('deleted-banner').hidden, false);
        assert.match(view.text('deleted-detail'), /dad@example\.com/);
        assert.match(view.text('deleted-detail'), /erased on /i);
    });

    test('and stays quiet on an archive nobody has deleted', async () => {
        const view = await loaded({ slug: SLUG, role: 'owner', viaOperator: true, posts: [] });

        assert.equal(view.el('deleted-banner').hidden, true);
    });

    test('and on one the API says nothing about', async () => {
        // Every ordinary reader, who is never told about deletions at all --
        // and, for that matter, could not be reading a deleted archive.
        const view = await loaded({ slug: SLUG, role: 'reader', posts: [] });

        assert.equal(view.el('deleted-banner').hidden, true);
    });

    test('a record with no address still forms a sentence', async () => {
        // `deletedBy` and the dates are each optional in the row, and a
        // sentence with a hole in it reads worse than a shorter one.
        const view = await loaded({
            ...DELETED,
            deleted: { deletedAt: '', deletedBy: '', purgeAfter: '' }
        });

        assert.equal(view.el('deleted-banner').hidden, false);
        assert.doesNotMatch(view.text('deleted-detail'), /undefined|NaN|Invalid/i);
    });
});
