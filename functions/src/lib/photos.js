// Photo rendition pipeline: original attachment bytes in, WebP renditions out.
//
// `raw/` keeps originals byte-for-byte with EXIF intact. Nothing here writes
// back to it — these are display copies, and they are regenerable, which is
// what makes re-rendering history after a fix safe.

import sharp from 'sharp';
import { photoId } from './paths.js';

// Formats accepted as photos. An allowlist rather than a bare `image/*` test,
// specifically to exclude SVG: it is an XML document that can carry script,
// and rasterizing attacker-supplied SVG has a long CVE history. No camera and
// no mail client produces one as a photo, so nothing legitimate is lost.
const PHOTO_TYPES = new Set([
    'image/jpeg', 'image/jpg', 'image/pjpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/tiff',
    'image/bmp',
    'image/heic', 'image/heif', 'image/avif'
]);

export const LARGE_EDGE = 2400;
export const THUMB_EDGE = 400;

// A small file can decode to a very large surface, so the guard has to be on
// pixels rather than on bytes. 100 MP is far above any phone camera and far
// below what would exhaust a Consumption instance.
export const MAX_PIXELS = 100_000_000;

// Below this on the longest edge an image is furniture, not a photograph:
// signature logos, social icons, spacer GIFs, and mail-client tracking pixels
// all sit well under it, and no real photo does. Excluded from the album and
// dropped from the body, since a letter rendered with three social-media
// icons inline reads as spam.
export const MIN_PHOTO_EDGE = 200;

// The largest single picture an owner may upload. Well above what a phone
// camera produces and comfortably below `MAX_RAW_BYTES`, which is the whole
// message an ingest has to hold; one picture arriving through the browser has
// no business being larger than an entire letter with its attachments.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const isPhotoType = (mimeType) =>
    PHOTO_TYPES.has(String(mimeType ?? '').toLowerCase().split(';')[0].trim());

/**
 * Decode one attachment into display renditions.
 *
 * Returns null when the bytes are not a usable photo — an unsupported codec, a
 * truncated file, or something too small to be one. Callers drop that photo
 * and publish the letter regardless: losing an image is a far better outcome
 * than losing the letter it came with.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {Promise<{large: Buffer, thumb: Buffer, width: number, height: number}|null>}
 */
export async function transcode(bytes) {
    try {
        const input = Buffer.from(bytes);

        // `rotate()` with no argument applies the EXIF orientation and then
        // drops it. Without it, every photo shot in portrait renders on its
        // side once the metadata is stripped.
        const base = sharp(input, { limitInputPixels: MAX_PIXELS, animated: false }).rotate();

        const meta = await base.metadata();

        // Turned by hand, because `metadata()` describes the *file* and not
        // the pipeline: the `rotate()` above has no bearing on what it
        // reports, so a phone photograph shot upright comes back as the
        // landscape rectangle its sensor recorded while the rendition beside
        // it is stored portrait. Nothing downstream reads the picture to find
        // out -- these two numbers are the only shape the book and the reader
        // ever see -- so recording the sensor's rectangle draws a portrait
        // photograph into a landscape hole, stretched half as wide again as
        // it should be. Orientations 5 through 8 are the four that involve a
        // quarter turn; 1 through 4 are uprights and flips, which change no
        // dimensions.
        const turned = (meta.orientation ?? 1) >= 5;
        const width = (turned ? meta.height : meta.width) ?? 0;
        const height = (turned ? meta.width : meta.height) ?? 0;

        if (!width || !height) return null;
        if (Math.max(width, height) < MIN_PHOTO_EDGE) return null;

        // sharp drops all metadata unless withMetadata() is called, so EXIF —
        // including GPS coordinates, which on a missionary's photo is a
        // location the family may not intend to publish — never reaches
        // rendered/.
        const render = (edge) =>
            sharp(input, { limitInputPixels: MAX_PIXELS, animated: false })
                .rotate()
                .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 82 })
                .toBuffer();

        const [large, thumb] = await Promise.all([render(LARGE_EDGE), render(THUMB_EDGE)]);
        return { large, thumb, width, height };
    } catch {
        return null;
    }
}

/**
 * Transcode one picture and write both renditions under a slug.
 *
 * The identity is the hash of the bytes that arrived, so writing the same
 * picture twice writes the same two blobs and costs nothing -- which is what
 * makes re-rendering a letter safe, and what makes an owner adding a photo
 * that is already in the letter a no-op rather than a duplicate.
 *
 * Returns null when the bytes are not a usable photo. Every caller drops that
 * one and carries on with the rest.
 *
 * @param {object} input
 * @param {{writeBlob: Function}} input.store
 * @param {string} input.slug
 * @param {Buffer|Uint8Array} input.bytes
 * @returns {Promise<{id: string, width: number, height: number}|null>}
 */
export async function storePhoto({ store, slug, bytes }) {
    const out = await transcode(bytes);
    if (!out) return null;

    const id = photoId(bytes);
    const prefix = `${slug}/photos/${id}`;
    await store.writeBlob('rendered', `${prefix}/large.webp`, out.large, {
        contentType: 'image/webp'
    });
    await store.writeBlob('rendered', `${prefix}/thumb.webp`, out.thumb, {
        contentType: 'image/webp'
    });

    return { id, width: out.width, height: out.height };
}
