// The render half of the pipeline: raw MIME in, display artifacts out.
//
// Everything here is regenerable from `raw/`, which is what makes it safe to
// re-run after a sanitizer or extractor fix. Re-rendering the same message
// yields byte-identical output, because photo identity is a content hash
// rather than a counter.

import { extractOriginal } from './extract.js';
import { sanitizeBody, photoUrl } from './sanitize.js';
import { transcode, isPhotoType } from './photos.js';
import { photoId } from './paths.js';

const CONFLICT_RETRIES = 8;
const utf8 = (value) => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

const escapeHtml = (text) =>
    String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

// A plain-text letter still has to become HTML, because bodyHtml is the only
// body the data model carries and the reader, the offline export and the
// printed book all render from it. Escaped first, so text that merely looks
// like markup stays text.
const textToHtml = (text) =>
    String(text ?? '')
        .split(/\r?\n\s*\r?\n/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => `<p>${escapeHtml(block).replace(/\r?\n/g, '<br />')}</p>`)
        .join('\n');

/**
 * @param {object} input
 * @param {{slug: string, msgId: string, postId: string}} input.message
 * @param {object} input.store   { readBlob, writeBlob }
 * @param {object} [input.log]
 */
export async function runRender({ message, store, log = console }) {
    const { slug, msgId, postId } = message;
    if (!slug || !msgId || !postId) return { status: 'rejected', reason: 'incomplete-message' };

    const blob = await store.readBlob('raw', `${slug}/${msgId}/message.eml`);
    if (!blob) {
        // raw/ is the archive; a message missing from it means the site was
        // deleted between ingest and render. Not an error worth retrying.
        log.info?.('render: raw message is gone', { slug, msgId });
        return { status: 'missing' };
    }

    const extracted = await extractOriginal(Buffer.from(blob.bytes));
    const photos = await renderPhotos({ store, slug, extracted, log });

    // Only inline parts get a cid entry. An ordinary attachment is an album
    // photo and has no reference in the body to rewrite.
    const cidMap = new Map();
    for (const photo of photos) {
        if (photo.cid) cidMap.set(photo.cid, photoUrl(slug, photo.id, 'large'));
    }

    const source = extracted.original ?? {};
    const bodyHtml = source.html
        ? sanitizeBody(source.html, { cidMap })
        : textToHtml(source.text);

    const stored = photos.map(({ id, width, height }) => ({ id, width, height }));
    return commitRender({ store, slug, postId, bodyHtml, photos: stored, log });
}

// Transcodes every image part and writes both renditions. Photos that fail to
// decode are dropped individually — a letter with one unreadable attachment
// still publishes, which is the whole point of doing this after ingest rather
// than inside it.
async function renderPhotos({ store, slug, extracted, log }) {
    const parts = [
        ...(extracted.attachments ?? []).map((part) => ({ part, cid: null })),
        ...(extracted.inlineImages ?? []).map((part) => ({
            part,
            cid: String(part.contentId ?? '').replace(/^</, '').replace(/>$/, '').toLowerCase() || null
        }))
    ];

    const rendered = [];
    const seen = new Set();

    for (const { part, cid } of parts) {
        if (!isPhotoType(part.mimeType)) continue;

        const bytes = Buffer.from(part.content);
        const id = photoId(bytes);

        // The same image attached twice — or pasted inline and attached — is
        // one photo. Content-hash identity makes that free.
        if (seen.has(id)) {
            const existing = rendered.find((p) => p.id === id);
            if (existing && cid && !existing.cid) existing.cid = cid;
            continue;
        }

        const out = await transcode(bytes);
        if (!out) {
            log.info?.('render: dropped an undecodable or undersized image', {
                slug,
                mimeType: part.mimeType ?? null,
                bytes: bytes.length
            });
            continue;
        }

        const prefix = `${slug}/photos/${id}`;
        await store.writeBlob('rendered', `${prefix}/large.webp`, out.large, {
            contentType: 'image/webp'
        });
        await store.writeBlob('rendered', `${prefix}/thumb.webp`, out.thumb, {
            contentType: 'image/webp'
        });

        seen.add(id);
        rendered.push({ id, width: out.width, height: out.height, cid });
    }

    return rendered;
}

// posts.json is shared by every message on the site, so render contends with
// ingest for it exactly as two ingests contend with each other.
async function commitRender({ store, slug, postId, bodyHtml, photos, log }) {
    const name = `${slug}/posts.json`;

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const current = await store.readBlob('rendered', name);
        if (!current) return { status: 'missing-post' };

        const posts = JSON.parse(Buffer.from(current.bytes).toString('utf8'));
        const index = posts.findIndex((p) => p.id === postId);
        if (index < 0) return { status: 'missing-post' };

        posts[index] = { ...posts[index], bodyHtml, photos };

        // bodyText only ever existed to carry a plain-text letter across the
        // gap between ingest and render. Once bodyHtml is built from it the
        // duplicate would ship in every reader payload for nothing.
        delete posts[index].bodyText;

        try {
            await store.writeBlob('rendered', name, utf8(posts), {
                contentType: 'application/json',
                ifMatch: current.etag
            });
            return { status: 'rendered', photos: photos.length };
        } catch (err) {
            if (!isConflict(err)) throw err;
            log.info?.('render: posts.json conflict, retrying', { slug, postId, attempt });
        }
    }

    throw new Error(`posts.json contention for ${slug} after ${CONFLICT_RETRIES} attempts`);
}

const isConflict = (err) =>
    err?.statusCode === 412 ||
    err?.statusCode === 409 ||
    err?.code === 'ConditionNotMet' ||
    err?.code === 'BlobAlreadyExists';
