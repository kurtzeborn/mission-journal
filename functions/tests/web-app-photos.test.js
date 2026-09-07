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

/**
 * A file the picker could have handed over, named so its date is readable.
 *
 * The bytes are the name, so two files with different names hash to different
 * ids -- which is what the page uses to tell a repeat from a new picture.
 */
const file = (name, bytes = name) => ({
    name,
    type: 'image/jpeg',
    slice: () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
    arrayBuffer: async () => new TextEncoder().encode(bytes).buffer
});

/** The id the site will give a file, worked out the way the site works it out. */
async function idOf(name) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name));
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `p_${hex.slice(0, 12)}`;
}

/**
 * Load the archive as its owner and hand back the controls the reader is given.
 *
 * `taken.js` is run first, exactly as the markup loads it, so the real date
 * reading is what the placement is being fed.
 */
async function owner({ posts = LETTERS, chose = null, maxPhotos = 48, refuseAt = [] } = {}) {
    const view = page({ html: 'site.html', path: `/${SLUG}/` });

    // Which uploads, counted from zero in the order they are sent, come back
    // as a file the server could not decode.
    let posted = 0;

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
        if (url.endsWith('/photos')) {
            const at = posted;
            posted += 1;
            return refuseAt.includes(at)
                ? { status: 415, body: { error: 'that picture could not be read' } }
                : { status: 200, body: { ok: true } };
        }
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
        assert.match(told, /up to 30 pictures at a time\. You chose 31\./);
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

// A phone's worth of photographs collects damaged files -- a chat app or a
// download truncates one and it will never decode, here or anywhere. Losing
// the other twenty-six because of it is the expensive part, and so is leaving
// the owner to work out by hand which ones went up before it.
describe('a picture the server cannot read', () => {
    const pile = (count) =>
        Array.from({ length: count }, (unused, index) =>
            file(`202508${String((index % 28) + 1).padStart(2, '0')}_120000.jpg`)
        );

    const told = (view) => view.context.told;

    // The day is the reader's own short form and so is the machine's to
    // choose; asserting the shape of the line rather than the digits keeps
    // these from failing on a runner with a different locale.
    const lines = (view) => view.context.told.detail.split('\n');

    test('the rest of the batch still goes up', async () => {
        const view = await owner({ chose: 'here', refuseAt: [2] });
        await view.admin.addPhotos('b', pile(5), () => {});

        assert.equal(view.uploads().length, 5, 'the run stopped at the bad file');
        assert.equal(view.context.location.reloaded, 1);
    });

    test('and the owner is told how many were left behind', async () => {
        const view = await owner({ chose: 'here', refuseAt: [1, 3] });
        await view.admin.addPhotos('b', pile(5), () => {});

        assert.equal(told(view).question, 'Added 3 of 5 pictures.');
        assert.match(lines(view)[0], /^3 added to /);
        assert.equal(lines(view)[1], '2 could not be read and were skipped.');
    });

    test('one of them is counted as one', async () => {
        const view = await owner({ chose: 'here', refuseAt: [0] });
        await view.admin.addPhotos('b', pile(3), () => {});

        assert.equal(lines(view)[1], 'One could not be read and was skipped.');
    });

    test('a run where every one is refused still says what it did', async () => {
        const view = await owner({ chose: 'here', refuseAt: [0, 1] });
        await view.admin.addPhotos('b', pile(2), () => {});

        assert.equal(told(view).question, 'Added 0 of 2 pictures.');
        assert.equal(told(view).detail, '2 could not be read and were skipped.');
    });

    test('a batch with nothing wrong with it still says where it went', async () => {
        // The count is said whatever happened, because a run of thirty that
        // ends in silence is a run the owner cannot tell from one that failed.
        const view = await owner({ chose: 'here' });
        await view.admin.addPhotos('b', pile(3), () => {});

        assert.equal(told(view).question, 'Added 3 of 3 pictures.');
        assert.deepEqual(lines(view).length, 1);
        assert.match(lines(view)[0], /^3 added to \d/);
    });

    test('one picture on its own is not worth a dialog', async () => {
        const view = await owner();
        await view.admin.addPhotos('b', [file('20250801_120000.jpg')], () => {});

        assert.equal(view.context.told, undefined);
        assert.equal(view.context.location.reloaded, 1);
    });

    test('a refusal that is not about the file still stops the run', async () => {
        // An expired session says the same thing about picture four as it did
        // about picture three. Carrying on would be twenty-three more
        // round trips to be told so twenty-three more times.
        const view = page({ html: 'site.html', path: `/${SLUG}/` });
        let admin = null;
        view.context.Reader = { mount: (options) => (admin = options.admin) };
        view.context.chose = 'here';

        let posted = 0;
        const net = fetching(async (url) => {
            if (url === '/.auth/me') {
                return {
                    status: 200,
                    body: {
                        clientPrincipal: { userDetails: 'mum@example.com', identityProvider: 'aad' }
                    }
                };
            }
            if (url === '/api/memberships') return { status: 200, body: { sites: [] } };
            if (url.endsWith('/photos')) {
                posted += 1;
                return posted > 2 ? { status: 401, body: {} } : { status: 200, body: { ok: true } };
            }
            return { status: 200, body: { slug: SLUG, role: 'owner', posts: LETTERS, maxPhotos: 48 } };
        });

        run(['taken.js', 'app.js'], { context: view.context, fetch: net.fetch });
        await settled();
        await admin.addPhotos('b', pile(5), () => {});

        const sent = net.calls.filter((call) => call.url.endsWith('/photos'));
        assert.equal(sent.length, 3, 'the run kept going after a refusal that would repeat');
        assert.equal(view.context.told.question, 'Added 2 of 5 pictures, then stopped.');
        assert.match(view.context.told.detail, /Your session expired\./);
    });
});

// Six hundred photographs go up thirty at a time over an evening, and any run
// that stops part way is started again over the same folder. Nobody can be
// asked to remember which thirty already went, so the page works out the id
// the server would give each file and leaves out the ones already there.
describe('sending the same pictures a second time', () => {
    /** A letter already carrying the pictures these files would become. */
    const carrying = async (post, names) => ({
        ...post,
        photos: await Promise.all(names.map(async (name) => ({ id: await idOf(name) })))
    });

    const ONE = '20250801_120000.jpg';
    const TWO = '20250802_090000.jpg';
    const THREE = '20250803_090000.jpg';

    test('a picture the letter already holds is not sent again', async () => {
        const posts = [await carrying(LETTERS[2], [ONE]), ...LETTERS.filter((p) => p.id !== 'b')];
        const view = await owner({ posts, chose: 'here' });

        await view.admin.addPhotos('b', [file(ONE), file(TWO), file(THREE)], () => {});

        assert.equal(view.uploads().length, 2, 'the picture already on the letter went up again');
    });

    test('the owner is told, so the count is not a mystery', async () => {
        const posts = [await carrying(LETTERS[2], [ONE, TWO]), ...LETTERS.filter((p) => p.id !== 'b')];
        const view = await owner({ posts, chose: 'here' });

        await view.admin.addPhotos('b', [file(ONE), file(TWO), file(THREE)], () => {});

        assert.equal(view.context.told.question, 'Added 1 of 3 pictures.');
        assert.equal(view.context.told.detail.split('\n').at(-1), '2 were already in the archive.');
    });

    test('a batch that is entirely a repeat sends nothing', async () => {
        const posts = [await carrying(LETTERS[2], [ONE, TWO]), ...LETTERS.filter((p) => p.id !== 'b')];
        const view = await owner({ posts, chose: 'here' });

        await view.admin.addPhotos('b', [file(ONE), file(TWO)], () => {});

        assert.deepEqual(view.uploads(), []);
        assert.equal(view.context.told.question, 'Added 0 of 2 pictures.');
        assert.equal(view.context.told.detail, '2 were already in the archive.');
    });

    test('a repeat onto a full letter is not refused for filling it', async () => {
        // The cap counts pictures the letter would gain, and a repeat gains it
        // none. Counting them anyway meant a run that stopped once could never
        // be started again over the same folder: the letter that filled up on
        // the first pass refused the whole second batch, including everything
        // in it bound for other letters.
        const full = await carrying(LETTERS[2], [ONE, TWO, THREE]);
        const posts = [full, ...LETTERS.filter((post) => post.id !== 'b')];
        const view = await owner({ posts, maxPhotos: 3, chose: 'here' });

        const said = await view.admin.addPhotos('b', [file(ONE), file(TWO)], () => {});

        assert.deepEqual(view.uploads(), []);
        assert.equal(said, null, 'the cap refused a batch that would add nothing');
        assert.equal(view.context.told.detail, '2 were already in the archive.');
    });

    test('a letter that really would overfill is still refused', async () => {
        const posts = [await carrying(LETTERS[2], [ONE, TWO]), ...LETTERS.filter((p) => p.id !== 'b')];
        const view = await owner({ posts, maxPhotos: 3, chose: 'here' });

        const said = await view.admin.addPhotos(
            'b',
            [file(ONE), file(THREE), file('20250804_090000.jpg')],
            () => {}
        );

        assert.deepEqual(view.uploads(), []);
        assert.match(said, /can hold 3 pictures/);
        assert.equal(view.context.told, undefined, 'a refusal was reported as a finished run');
    });
});

// Spreading by date is the one thing the page does that the owner cannot watch
// happen: thirty pictures go onto seven letters and the reload shows one of
// them. So the run says where they went, and says which of them it could not
// place -- a picture with no date is put where the owner was standing, and
// that is a guess worth admitting to.
describe('what a run says about placement', () => {
    test('the letters are counted out, a day to a line', async () => {
        const view = await owner({ chose: 'spread' });

        await view.admin.addPhotos(
            'b',
            [file('20250801_120000.jpg'), file('20250820_090000.jpg'), file('undated.jpg')],
            () => {}
        );

        const said = view.context.told.detail.split('\n');
        assert.equal(said.length, 3);
        assert.match(said[0], /^1 added to \d/);
        assert.match(said[1], /^1 added to \d/);
        assert.notEqual(said[0], said[1], 'two letters were reported as one');
        assert.equal(said[2], 'One had no date and stayed on this letter.');
    });

    test('a batch where nothing is dated is told so', async () => {
        // No dialog asks where these should go, because with nothing dated
        // there is no second place to offer -- so this report is the only
        // time the owner hears that a guess was made on their behalf.
        const view = await owner();

        await view.admin.addPhotos('b', [file('one.jpg'), file('two.jpg')], () => {});

        assert.equal(view.context.asked, undefined, 'an empty choice was put in the way');
        assert.equal(view.context.told.question, 'Added 2 of 2 pictures.');
        assert.equal(view.context.told.detail, '2 had no date and stayed on this letter.');
    });
});
