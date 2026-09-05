// Where a picture lands when an owner adds a pile of them at once.
//
// The feature this covers is a returned missionary's phone: two years of
// photographs, six hundred files, belonging to an archive rather than to
// whichever letter happens to be open. Placing them by hand is forty sittings,
// so the dates are read off the files and each one is offered the letter it
// was taken before.
//
// What is checked here is the placement and the question, not the reading --
// `web-taken.test.js` covers that. The two risks are the same either way
// round: putting a photograph on a letter written a year from it, and putting
// a dialog in front of an owner who only wanted to add one picture.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetching, page, run, settled } from './web-dom.js';

const SLUG = 'elder.example';

// Four letters, a fortnight apart, deliberately given out of order: the page
// receives them newest-first and the placement has to sort them itself.
const LETTERS = [
    { id: 'd', originalDate: '2025-09-01T18:00:00', subject: 'Four' },
    { id: 'c', originalDate: '2025-08-18T18:00:00', subject: 'Three' },
    { id: 'b', originalDate: '2025-08-04T18:00:00', subject: 'Two' },
    { id: 'a', originalDate: '2025-07-21T18:00:00', subject: 'One' }
];

/** A file the picker could have handed over, named so its date is readable. */
const file = (name) => ({
    name,
    type: 'image/jpeg',
    slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) })
});

/**
 * Load the archive as its owner and hand back the controls the reader is given.
 *
 * `taken.js` is run first, exactly as the markup loads it, so the real date
 * reading is what the placement is being fed.
 */
async function owner({ posts = LETTERS, chose = null, maxPhotos = 48 } = {}) {
    const view = page({ html: 'site.html', path: `/${SLUG}/` });

    let admin = null;
    view.context.Reader = {
        mount(options) {
            admin = options.admin;
        }
    };
    view.context.chose = chose;

    const net = fetching(async (url) => {
        if (url === '/.auth/me') {
            return {
                status: 200,
                body: { clientPrincipal: { userDetails: 'mum@example.com', identityProvider: 'aad' } }
            };
        }
        if (url === '/api/memberships') return { status: 200, body: { sites: [] } };
        if (url.startsWith('/api/posts/')) return { status: 200, body: { ok: true } };
        return { status: 200, body: { slug: SLUG, role: 'owner', posts, maxPhotos } };
    });

    run(['taken.js', 'app.js'], { context: view.context, fetch: net.fetch });
    await settled();

    const uploads = () => net.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/photos'));

    return {
        ...view,
        admin,
        uploads,
        /** Which letter each picture was posted to, in the order they went. */
        landings: () =>
            uploads().map((call) => decodeURIComponent(call.url.split('/').slice(-2)[0])),
        dates: () => uploads().map((call) => call.headers['X-Taken-At'] ?? null)
    };
}

const said = [];
const say = (words) => said.push(words);

describe('adding one picture, which is what usually happens', () => {
    test('no question is asked', async () => {
        const view = await owner();
        await view.admin.addPhotos('b', [file('20250801_120000.jpg')], say);

        assert.equal(view.context.asked, undefined, 'an owner adding one picture was interrupted');
        assert.deepEqual(view.landings(), ['b']);
    });

    test('the date still travels with it', async () => {
        // Placement is not the only thing the date is for. It is also the
        // order the letter lists its pictures in, which matters just as much
        // for one added on its own.
        const view = await owner();
        await view.admin.addPhotos('b', [file('20250801_120000.jpg')], say);

        assert.deepEqual(view.dates(), ['2025-08-01T12:00:00']);
    });
});

describe('adding several that carry no dates', () => {
    test('they go where the owner was standing, unasked', async () => {
        const view = await owner();
        await view.admin.addPhotos('c', [file('holiday.jpg'), file('church.jpg')], say);

        assert.equal(view.context.asked, undefined);
        assert.deepEqual(view.landings(), ['c', 'c']);
        assert.deepEqual(view.dates(), [null, null]);
    });
});

describe('adding a pile with dates on it', () => {
    const PILE = [
        file('20250715_090000.jpg'), // before every letter
        file('20250801_120000.jpg'), // between One and Two
        file('20250820_120000.jpg'), // between Three and Four
        file('20260101_120000.jpg') // after every letter
    ];

    test('the owner is asked, and told what was found', async () => {
        const view = await owner({ chose: 'here' });
        await view.admin.addPhotos('a', PILE, say);

        assert.match(view.context.asked.question, /4 pictures/);
        assert.match(view.context.asked.detail, /4 of them/);
        // Loosely, because the dialog was built inside the script's own realm
        // and its array does not share this one's prototype.
        assert.deepEqual(
            [...view.context.asked.actions].map((action) => action.value),
            ['spread', 'here']
        );
    });

    test('spreading puts each one on the first letter written after it', async () => {
        const view = await owner({ chose: 'spread' });
        await view.admin.addPhotos('a', PILE, say);

        assert.deepEqual(view.landings(), ['a', 'b', 'd', 'd']);
    });

    test('and sends them in the order they were taken', async () => {
        const view = await owner({ chose: 'spread' });
        await view.admin.addPhotos('a', [PILE[3], PILE[0], PILE[2], PILE[1]], say);

        assert.deepEqual(view.dates(), [
            '2025-07-15T09:00:00',
            '2025-08-01T12:00:00',
            '2025-08-20T12:00:00',
            '2026-01-01T12:00:00'
        ]);
    });

    test('ones taken after the last letter go on the last letter', async () => {
        // Rather than being refused. There is no letter after them and there
        // never will be -- the mission is over, which is why the pile exists.
        const view = await owner({ chose: 'spread' });
        await view.admin.addPhotos('a', [PILE[3], file('20260214_090000.jpg')], say);

        assert.deepEqual(view.landings(), ['d', 'd']);
    });

    test('choosing this letter instead sends every one of them here', async () => {
        const view = await owner({ chose: 'here' });
        await view.admin.addPhotos('c', PILE, say);

        assert.deepEqual(view.landings(), ['c', 'c', 'c', 'c']);
    });

    test('backing out uploads nothing and leaves the page alone', async () => {
        const view = await owner({ chose: null });
        await view.admin.addPhotos('c', PILE, say);

        assert.deepEqual(view.uploads(), []);
        assert.equal(view.context.location.reloaded, undefined);
    });

    test('the undated ones in a mixed pile stay on this letter', async () => {
        const view = await owner({ chose: 'spread' });
        await view.admin.addPhotos('c', [file('holiday.jpg'), PILE[0], PILE[2]], say);

        assert.deepEqual(view.landings(), ['c', 'a', 'd']);
        assert.match(view.context.asked.detail, /The other 1 said nothing/);
    });
});

describe('when there is nothing to decide', () => {
    test('an archive with one letter is never asked about', async () => {
        const view = await owner({ posts: [LETTERS[3]] });
        await view.admin.addPhotos('a', [file('20250715_090000.jpg'), file('20250716_090000.jpg')], say);

        assert.equal(view.context.asked, undefined);
        assert.deepEqual(view.landings(), ['a', 'a']);
    });

    test('a pile that all belongs here anyway is not put to the owner', async () => {
        // Two pictures from the same week, added to the letter that week was
        // written about. Asking would be offering a choice with one answer.
        const view = await owner();
        await view.admin.addPhotos('b', [file('20250801_120000.jpg'), file('20250802_090000.jpg')], say);

        assert.equal(view.context.asked, undefined);
        assert.deepEqual(view.landings(), ['b', 'b']);
    });
});

// The server refuses one picture at a time and that is the check that counts.
// This one exists so a six-hundred-file run does not stop at picture 380 with
// a letter nobody can name.
describe('a selection that would overfill a letter', () => {
    /** A letter carrying `count` pictures already. */
    const holding = (post, count) => ({
        ...post,
        photos: Array.from({ length: count }, (unused, index) => ({ id: `p${post.id}${index}` }))
    });

    test('nothing is uploaded and the letter is named', async () => {
        const posts = LETTERS.map((post) => (post.id === 'b' ? holding(post, 3) : post));
        const view = await owner({ posts, maxPhotos: 4 });

        const told = await view.admin.addPhotos(
            'b',
            [file('20250801_120000.jpg'), file('20250802_090000.jpg')],
            () => {}
        );

        assert.deepEqual(view.uploads(), []);
        assert.match(told, /can hold 4 pictures/);
        assert.match(told, /"Two" has room for 1 more/);
        assert.match(told, /Nothing was added/);
    });

    test('the letters it would spread onto are checked too', async () => {
        const posts = LETTERS.map((post) => (post.id === 'a' ? holding(post, 4) : post));
        const view = await owner({ posts, maxPhotos: 4, chose: 'spread' });

        const told = await view.admin.addPhotos(
            'c',
            [file('20250715_090000.jpg'), file('20250716_090000.jpg'), file('20250820_120000.jpg')],
            () => {}
        );

        assert.deepEqual(view.uploads(), []);
        assert.match(told, /"One" has room for 0 more/);
    });

    test('several full letters are counted rather than listed', async () => {
        const posts = LETTERS.map((post) => (post.id === 'd' ? post : holding(post, 4)));
        const view = await owner({ posts, maxPhotos: 4, chose: 'spread' });

        const told = await view.admin.addPhotos(
            'c',
            [file('20250715_090000.jpg'), file('20250801_120000.jpg'), file('20250810_120000.jpg')],
            () => {}
        );

        assert.match(told, /3 of the letters they would go on are too full/);
    });

    test('a letter with room is left alone', async () => {
        const posts = LETTERS.map((post) => (post.id === 'b' ? holding(post, 2) : post));
        const view = await owner({ posts, maxPhotos: 4 });

        await view.admin.addPhotos(
            'b',
            [file('20250801_120000.jpg'), file('20250802_090000.jpg')],
            say
        );

        assert.deepEqual(view.landings(), ['b', 'b']);
    });

    test('a page that has not been told the limit does not guess at one', async () => {
        // A response cached from before the API sent it. The check is skipped
        // and the server does the refusing, which is where it was always done.
        const posts = LETTERS.map((post) => (post.id === 'b' ? holding(post, 9) : post));
        const view = await owner({ posts, maxPhotos: null });

        await view.admin.addPhotos(
            'b',
            [file('20250801_120000.jpg'), file('20250802_090000.jpg')],
            say
        );

        assert.deepEqual(view.landings(), ['b', 'b']);
    });
});

describe('how many may go up in one sitting', () => {
    const pile = (count) =>
        Array.from({ length: count }, (unused, index) =>
            file(`202508${String((index % 28) + 1).padStart(2, '0')}_120000.jpg`)
        );

    test('too large a pick is refused before a single file is read', async () => {
        const view = await owner();
        const told = await view.admin.addPhotos('b', pile(31), () => {});

        assert.deepEqual(view.uploads(), []);
        assert.equal(view.context.asked, undefined, 'the owner was questioned about a refused pile');
        assert.match(told, /up to 30 pictures at a time, not 31/);
    });

    test('a full batch goes through', async () => {
        const view = await owner({ chose: 'here' });
        await view.admin.addPhotos('b', pile(30), () => {});

        assert.equal(view.uploads().length, 30);
    });

    test('the reading is counted out loud, not left as one line', async () => {
        // The dates come off the files one at a time, and on a phone that is
        // long enough to look like nothing is happening.
        const heard = [];
        const view = await owner({ chose: 'here' });
        await view.admin.addPhotos('b', pile(3), (words) => heard.push(words));

        assert.ok(heard.includes('Reading dates (1 of 3)…'), heard.join(' | '));
        assert.ok(heard.includes('Reading dates (3 of 3)…'), heard.join(' | '));
    });
});
