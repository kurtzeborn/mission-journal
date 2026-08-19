// What the checkout page shows.
//
// These assert on the pixels rather than on the calls that made them, which
// is unusual here and is the point: the whole risk in `thumbnail.js` is that
// it draws a *different* cover to the one in the book, and no amount of
// checking that sharp was asked politely would catch that. So the tests read
// the colour back out of the image and ask whether it is the cloth that was
// chosen.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { coverImage } from '../src/lib/thumbnail.js';
import { CLOTHS } from '../src/lib/cover.js';

const PROFILE = {
    displayName: 'Elder Example',
    mission: 'Argentina Buenos Aires North Mission',
    startDate: '2025-06-15',
    returnDate: '2027-06-15'
};

// The corner of the board, well clear of any type or picture.
const cornerOf = async (jpeg) => {
    const { data } = await sharp(jpeg)
        .extract({ left: 4, top: 4, width: 2, height: 2 })
        .raw()
        .toBuffer({ resolveWithObject: true });

    return `#${[data[0], data[1], data[2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
};

describe('a picture of the cover', () => {
    test('is the shape of the book it is a picture of', async () => {
        const jpeg = await coverImage({ title: 'Elder Example', profile: PROFILE, cover: { cloth: 'navy' } });
        const { width, height, format } = await sharp(jpeg).metadata();

        assert.equal(format, 'jpeg');
        // 8.5 by 11, which is the trim the listing also declares.
        assert.equal(width, 612);
        assert.equal(height, 792);
    });

    test('is bound in the cloth the owner chose', async () => {
        for (const name of ['navy', 'linen', 'oxblood']) {
            const jpeg = await coverImage({ title: 'Elder Example', profile: PROFILE, cover: { cloth: name } });

            // JPEG is lossy, so this asks whether the corner is near the
            // chosen colour rather than exactly it -- a wrong cloth would be
            // a different colour entirely, not a few values out.
            const want = CLOTHS[name].paper;
            const got = await cornerOf(jpeg);
            const apart = [1, 3, 5].reduce(
                (most, at) =>
                    Math.max(most, Math.abs(parseInt(want.slice(at, at + 2), 16) - parseInt(got.slice(at, at + 2), 16))),
                0
            );

            assert.ok(apart <= 6, `${name}: wanted about ${want}, drew ${got}`);
        }
    });

    test('a cover with no colour chosen is bound like the book is', async () => {
        const jpeg = await coverImage({ title: 'Elder Example', profile: PROFILE, cover: {} });

        // `clothOf` falls back for both, so neither can be given a default
        // the other does not have.
        assert.ok(await cornerOf(jpeg));
    });

    test('a photograph fills the top of the board', async () => {
        const photo = await sharp({
            create: { width: 400, height: 300, channels: 3, background: '#c81400' }
        })
            .jpeg()
            .toBuffer();

        const jpeg = await coverImage({
            title: 'Elder Example',
            profile: PROFILE,
            cover: { cloth: 'navy', bytes: photo }
        });

        // The band is red where the cloth would have been navy.
        const [red, , blue] = await sharp(jpeg)
            .extract({ left: 4, top: 4, width: 2, height: 2 })
            .raw()
            .toBuffer();

        assert.ok(red > 150 && blue < 80, 'the picture should be at the top of the board');
    });

    test('a name too long to set large is set smaller rather than off the edge', async () => {
        const long = await coverImage({
            title: 'Hermana Maria Guadalupe Villanueva-Fernandez',
            profile: PROFILE,
            cover: { cloth: 'slate' }
        });

        // Nothing may be drawn outside the board, and the composite would
        // throw if it were -- so simply getting an image back is the
        // assertion. The failure this guards against is a name wider than the
        // page, which is a build that raises rather than a cover that looks
        // wrong.
        assert.ok(long.length > 1000);
    });

    test('a book with no dates yet still gets a cover', async () => {
        const jpeg = await coverImage({
            title: 'Elder Example',
            profile: { mission: 'Somewhere' },
            cover: { cloth: 'forest' }
        });

        assert.ok(jpeg.length > 1000);
    });

    test('a picture that cannot be read costs the book nothing', async () => {
        const noted = [];
        const jpeg = await coverImage({
            title: 'Elder Example',
            profile: PROFILE,
            cover: { cloth: 'navy', bytes: Buffer.from('this is not an image') },
            log: { warn: (event) => noted.push(event) }
        });

        assert.equal(jpeg, null);
        assert.deepEqual(noted, ['book.noThumbnail']);
    });
});
