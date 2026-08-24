// What the outside of the book looks like.
//
// Two decisions and no more: a cloth color, and optionally a photograph
// across the top of the front board. That is a deliberately small menu. A
// full color picker produces covers nobody would choose twice, a font
// choice produces a book that does not match its own insides, and every
// additional control is another thing to explain on a page somebody visits
// once in two years.
//
// **Colors are named, not sent.** The browser posts `navy`, never `#223349`,
// and the palette below is the only place the hexes exist. Three reasons, in
// increasing order of importance: the ink and the quiet gray that read
// against each cloth are chosen here rather than guessed by the page; a
// stored name still means something after the palette is retuned, where a
// stored hex freezes a color we may have decided was wrong; and a value that
// reaches a PDF drawing call cannot be arbitrary text from a request.
//
// **The choice lives on the profile.** It is a fact about the archive rather
// than about any one book -- an owner who prints a second copy next year
// wants the cover they chose -- and it rides along to the builder inside the
// profile that was already being read for the name and the dates.

import { readProfile } from './profile.js';
import { transcode } from './photos.js';

const CONFIG = 'config';

// The owner's own picture, if they uploaded one rather than picking from the
// archive. Kept beside the profile rather than in `rendered/photos/` because
// it is not a photograph of the mission: nothing in the archive refers to it,
// no reader may fetch it, and a re-render must never sweep it up.
export const coverFile = (slug) => `${slug}/cover.webp`;

// Cloth, ink, and the quieter ink the mission line and the dates are set in.
// Every one of these is a bound book somebody has actually seen: dark boards
// with pale type, or unbleached linen with dark. White is not among them --
// it is the one thing an owner has already told us they do not want, and it
// is what this whole file exists to stop being the answer.
export const CLOTHS = {
    linen: { paper: '#efe7d8', ink: '#2b2b2b', quiet: '#6f6455' },
    slate: { paper: '#44515c', ink: '#f7f5f1', quiet: '#c8d2da' },
    navy: { paper: '#223349', ink: '#f4f2ee', quiet: '#b9c6d8' },
    forest: { paper: '#26403a', ink: '#f1f2ec', quiet: '#b4cabf' },
    oxblood: { paper: '#4a2226', ink: '#f5efe9', quiet: '#d6b8b3' },
    plum: { paper: '#3b2a45', ink: '#f4f0f4', quiet: '#c9bad1' },
    ochre: { paper: '#8a5a20', ink: '#fdf6ea', quiet: '#edd6ae' },
    ink: { paper: '#1f2124', ink: '#f2f1ee', quiet: '#b8b7b3' }
};

// Dark and quiet, because a book of two years of letters is not a brochure.
// Any default is somebody else's taste, which the owner said plainly; the
// most that can be claimed for this one is that it looks like a book.
export const DEFAULT_CLOTH = 'slate';

// The owner's own upload, as opposed to one of the archive's photographs.
export const OWN_PICTURE = 'own';

// As `paths.js` mints them: `p_` and twelve hex characters.
const PHOTO_ID = /^p_[0-9a-f]{12}$/;

export const clothOf = (name) => CLOTHS[name] ?? CLOTHS[DEFAULT_CLOTH];

/**
 * The cover a profile is asking for, with everything filled in.
 *
 * Total: any profile, including one written before covers existed, resolves
 * to something printable. The builder never has to ask whether a choice was
 * made.
 */
export function coverOf(profile = {}) {
    const chosen = profile.cover ?? {};
    const cloth = CLOTHS[chosen.cloth] ? chosen.cloth : DEFAULT_CLOTH;
    const picture = chosen.picture === OWN_PICTURE || PHOTO_ID.test(chosen.picture ?? '')
        ? chosen.picture
        : '';

    return { cloth, picture };
}

/**
 * Check what the page sent.
 *
 * Refuses rather than corrects, unlike `coverOf` above, and the difference is
 * who is talking. A stored document that has drifted should still print; a
 * request that names a color we do not have is a page out of step with the
 * server, and silently printing a different cover to the one somebody chose
 * is worse than telling them.
 *
 * @returns {{error: string} | {cover: {cloth: string, picture: string}}}
 */
export function chooseCover({ cloth, picture }) {
    if (!CLOTHS[cloth]) return { error: 'that is not one of the cover colors' };

    const wanted = String(picture ?? '').trim();
    if (wanted && wanted !== OWN_PICTURE && !PHOTO_ID.test(wanted)) {
        return { error: 'that is not a picture from this archive' };
    }

    return { cover: { cloth, picture: wanted } };
}

/**
 * Remember it.
 *
 * A read-modify-write of the profile under its own ETag, exactly as a rename
 * is, because two owners share a site and the other one may be editing the
 * name while this one picks a color.
 *
 * The `sites` row is left alone. It indexes the name and the start date for
 * the lists; what color a book is bound in is nobody's index.
 *
 * @returns {Promise<{error: string} | {cover: object}>}
 */
export async function saveCover({ store, slug, cover }) {
    const { profile, etag } = await readProfile({ store, slug });
    const next = { ...profile, slug, cover, updatedAt: new Date().toISOString() };

    try {
        await store.writeBlob(CONFIG, `${slug}/profile.json`, JSON.stringify(next, null, 2), {
            contentType: 'application/json; charset=utf-8',
            ...(etag ? { ifMatch: etag } : { ifNoneMatch: '*' })
        });
    } catch (err) {
        if (err?.statusCode === 412 || err?.statusCode === 409) {
            return { error: 'somebody else changed this first' };
        }
        throw err;
    }

    return { cover };
}

/**
 * Take an uploaded picture and keep it as this site's cover.
 *
 * Through the same transcoder every attachment goes through, which is what
 * strips the EXIF -- a cover photograph is the most public object this
 * service produces, and shipping GPS coordinates on it would be the worst
 * place of all to do that.
 *
 * Only one is kept. There is one cover, an owner who uploads a second has
 * replaced the first, and keeping the old one would mean a list, a chooser
 * and a delete button for a thing nobody wants two of.
 *
 * @returns {Promise<{error: string} | {picture: string}>}
 */
export async function storeCoverPicture({ store, slug, bytes }) {
    const out = await transcode(bytes);
    if (!out) return { error: 'that picture could not be read' };

    await store.writeBlob(CONFIG, coverFile(slug), out.large, { contentType: 'image/webp' });

    return { picture: OWN_PICTURE };
}

/**
 * The bytes to print on the cover, wherever they live.
 *
 * Null covers three cases the builder treats alike: no picture was chosen,
 * the archive photograph has since been deleted, or the upload is gone. All
 * three print the cloth alone, which is a cover rather than a failure.
 */
export async function readCoverPicture({ store, slug, cover }) {
    const picture = cover?.picture;
    if (!picture) return null;

    const blob = picture === OWN_PICTURE
        ? await store.readBlob(CONFIG, coverFile(slug))
        : await store.readBlob('rendered', `${slug}/photos/${picture}/large.webp`);

    return blob ? Buffer.from(blob.bytes) : null;
}
