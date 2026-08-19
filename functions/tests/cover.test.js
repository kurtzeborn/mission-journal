import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    CLOTHS,
    DEFAULT_CLOTH,
    chooseCover,
    coverFile,
    coverOf,
    readCoverPicture,
    saveCover,
    storeCoverPicture
} from '../src/lib/cover.js';
import { memoryStore } from './memory-store.js';

const wrote = (store, slug) =>
    JSON.parse(store.blobs.get(`config/${slug}/profile.json`).bytes.toString('utf8'));

describe('what a cover is bound in', () => {
    it('gives every colour an ink that is not the same colour', () => {
        for (const [name, cloth] of Object.entries(CLOTHS)) {
            assert.notEqual(cloth.paper, cloth.ink, name);
            assert.match(cloth.paper, /^#[0-9a-f]{6}$/, name);
            assert.match(cloth.ink, /^#[0-9a-f]{6}$/, name);
            assert.match(cloth.quiet, /^#[0-9a-f]{6}$/, name);
        }
    });

    it('binds an archive that has never been asked', () => {
        assert.deepEqual(coverOf({}), { cloth: DEFAULT_CLOTH, picture: '' });
    });

    it('does not bind anything in white', () => {
        // The one thing the owner said plainly. A default nobody chose is
        // still a decision, and this is the decision.
        assert.notEqual(CLOTHS[DEFAULT_CLOTH].paper.toLowerCase(), '#ffffff');
    });

    it('falls back rather than refusing when a stored choice has drifted', () => {
        // Read from a file, so it may have been written by a version of this
        // service that had a colour we have since dropped. Printing the
        // default is a book; refusing is a support request.
        assert.deepEqual(coverOf({ cover: { cloth: 'chartreuse', picture: 'nonsense' } }), {
            cloth: DEFAULT_CLOTH,
            picture: ''
        });
    });

    it('keeps a picture that looks like one of ours', () => {
        assert.deepEqual(coverOf({ cover: { cloth: 'navy', picture: 'p_0123456789ab' } }), {
            cloth: 'navy',
            picture: 'p_0123456789ab'
        });
    });
});

describe('choosing a cover', () => {
    it('takes a colour and a photograph from the archive', () => {
        assert.deepEqual(chooseCover({ cloth: 'forest', picture: 'p_0123456789ab' }), {
            cover: { cloth: 'forest', picture: 'p_0123456789ab' }
        });
    });

    it('takes a colour on its own', () => {
        assert.deepEqual(chooseCover({ cloth: 'linen', picture: '' }), {
            cover: { cloth: 'linen', picture: '' }
        });
    });

    it('takes the owner\u2019s own picture', () => {
        assert.deepEqual(chooseCover({ cloth: 'ink', picture: 'own' }), {
            cover: { cloth: 'ink', picture: 'own' }
        });
    });

    it('refuses a colour we do not have', () => {
        // Unlike the reader above, which forgives. A request that names a
        // colour the page does not know about is a page out of step with the
        // server, and quietly printing something else is worse than saying so.
        assert.ok(chooseCover({ cloth: '#ff00ff', picture: '' }).error);
    });

    it('refuses a picture that is not one of ours', () => {
        assert.ok(chooseCover({ cloth: 'navy', picture: '../../secrets' }).error);
    });
});

describe('remembering a cover', () => {
    it('keeps everything else on the profile', async () => {
        const store = memoryStore();
        await store.writeBlob(
            'config',
            'declan.kurtzeborn/profile.json',
            JSON.stringify({
                slug: 'declan.kurtzeborn',
                displayName: 'Elder Declan Kurtzeborn',
                mission: 'Chile Santiago East',
                startDate: '2026-01-07'
            })
        );

        await saveCover({
            store,
            slug: 'declan.kurtzeborn',
            cover: { cloth: 'oxblood', picture: '' }
        });

        const saved = wrote(store, 'declan.kurtzeborn');
        assert.equal(saved.displayName, 'Elder Declan Kurtzeborn');
        assert.equal(saved.mission, 'Chile Santiago East');
        assert.equal(saved.startDate, '2026-01-07');
        assert.equal(saved.cover.cloth, 'oxblood');
    });

    it('writes a profile for an archive that has never had one', async () => {
        const store = memoryStore();

        const result = await saveCover({
            store,
            slug: 'isaac.backman',
            cover: { cloth: 'navy', picture: '' }
        });

        assert.equal(result.error, undefined);
        assert.equal(wrote(store, 'isaac.backman').cover.cloth, 'navy');
    });

    it('refuses when somebody else saved first', async () => {
        const store = memoryStore();
        await store.writeBlob('config', 'isaac.backman/profile.json', JSON.stringify({}));
        store.conflictOnce = 'config/isaac.backman/profile.json';

        const result = await saveCover({
            store,
            slug: 'isaac.backman',
            cover: { cloth: 'navy', picture: '' }
        });

        assert.equal(result.error, 'somebody else changed this first');
    });
});

describe('the picture on the front board', () => {
    it('reads nothing when no picture was chosen', async () => {
        const store = memoryStore();
        assert.equal(await readCoverPicture({ store, slug: 'isaac.backman', cover: {} }), null);
    });

    it('reads a photograph out of the archive', async () => {
        const store = memoryStore();
        await store.writeBlob(
            'rendered',
            'isaac.backman/photos/p_0123456789ab/large.webp',
            Buffer.from('webp bytes')
        );

        const bytes = await readCoverPicture({
            store,
            slug: 'isaac.backman',
            cover: { cloth: 'navy', picture: 'p_0123456789ab' }
        });

        assert.equal(bytes.toString(), 'webp bytes');
    });

    it('prints the cloth alone when the photograph has since been deleted', async () => {
        // A picture is chosen and then the letter it came from is deleted.
        // The book is still a book; it is just a plain one.
        const bytes = await readCoverPicture({
            store: memoryStore(),
            slug: 'isaac.backman',
            cover: { cloth: 'navy', picture: 'p_0123456789ab' }
        });

        assert.equal(bytes, null);
    });

    it('stores an upload as a stripped rendition of its own', async () => {
        const store = memoryStore();
        const stored = await storeCoverPicture({
            store,
            slug: 'isaac.backman',
            bytes: await pixels(1600, 1200)
        });

        assert.equal(stored.picture, 'own');

        const kept = store.blobs.get(`config/${coverFile('isaac.backman')}`);
        assert.equal(kept.contentType, 'image/webp');
        // WebP, whatever was uploaded: the transcode is also what removes the
        // EXIF, and a cover is the most public thing this service produces.
        assert.equal(kept.bytes.subarray(8, 12).toString(), 'WEBP');
    });

    it('reads an upload back', async () => {
        const store = memoryStore();
        await storeCoverPicture({ store, slug: 'isaac.backman', bytes: await pixels(800, 600) });

        const bytes = await readCoverPicture({
            store,
            slug: 'isaac.backman',
            cover: { cloth: 'navy', picture: 'own' }
        });

        assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
    });

    it('refuses something that is not a picture', async () => {
        const result = await storeCoverPicture({
            store: memoryStore(),
            slug: 'isaac.backman',
            bytes: Buffer.from('not an image')
        });

        assert.ok(result.error);
    });

    it('replaces the last upload rather than keeping both', async () => {
        // There is one cover. Keeping the old one would mean a list, a
        // chooser and a delete button for a thing nobody wants two of.
        const store = memoryStore();
        await storeCoverPicture({ store, slug: 'isaac.backman', bytes: await pixels(800, 600) });
        await storeCoverPicture({ store, slug: 'isaac.backman', bytes: await pixels(1600, 1200) });

        const kept = [...store.blobs.keys()].filter((key) => key.startsWith('config/isaac.backman/'));
        assert.deepEqual(kept, [`config/${coverFile('isaac.backman')}`]);
    });
});

// A real picture, because the transcode is the part being trusted.
async function pixels(width, height) {
    const { default: sharp } = await import('sharp');
    return sharp({
        create: { width, height, channels: 3, background: { r: 120, g: 90, b: 60 } }
    })
        .jpeg()
        .toBuffer();
}
