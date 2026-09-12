import { CONFLICT_RETRIES, isConflict } from './conflict.js';
import { sanitizeBody } from './sanitize.js';

const CONFIG = 'config';
const MAX_BODY = 128 * 1024;

export const BOOK_SECTION_NAMES = Object.freeze(['foreword', 'afterword']);
export const bookSectionsName = (slug) => `${slug}/book-sections.json`;

const empty = () => ({ foreword: null, afterword: null });
const utf8 = (value) => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

export function sanitizeBookSection(value) {
    if (typeof value !== 'string') return { error: 'bodyHtml must be a string' };
    if (value.length > MAX_BODY) return { error: `bodyHtml exceeds ${MAX_BODY} characters` };

    // With no trusted photo prefix or CID map, the letter sanitizer removes
    // every image while retaining the same safe rich-text vocabulary.
    const html = sanitizeBody(value);
    if (!html) return { error: 'bodyHtml must not be empty' };
    return { html };
}

export async function readBookSections({ store, slug }) {
    const blob = await store.readBlob(CONFIG, bookSectionsName(slug));
    if (!blob) return { sections: empty(), etag: '' };

    try {
        const stored = JSON.parse(Buffer.from(blob.bytes).toString('utf8'));
        return {
            sections: {
                foreword: typeof stored?.foreword === 'string' ? stored.foreword : null,
                afterword: typeof stored?.afterword === 'string' ? stored.afterword : null
            },
            etag: blob.etag ?? ''
        };
    } catch {
        return { sections: empty(), etag: blob.etag ?? '' };
    }
}

export async function changeBookSection({ store, slug, section, bodyHtml, remove = false, log = console }) {
    if (!BOOK_SECTION_NAMES.includes(section)) return { error: 'unknown book section' };

    const cleaned = remove ? null : sanitizeBookSection(bodyHtml);
    if (!remove && cleaned.error) return cleaned;

    for (let attempt = 0; attempt < CONFLICT_RETRIES; attempt++) {
        const { sections, etag } = await readBookSections({ store, slug });
        const next = { ...sections, [section]: remove ? null : cleaned.html };

        try {
            await store.writeBlob(CONFIG, bookSectionsName(slug), utf8(next), {
                contentType: 'application/json; charset=utf-8',
                ...(etag ? { ifMatch: etag } : { ifNoneMatch: '*' })
            });
            return { sections: next };
        } catch (error) {
            if (!isConflict(error)) throw error;
            log.info?.('book-sections: conflict, retrying', { slug, section, attempt });
        }
    }

    throw new Error(`book-sections contention for ${slug} after ${CONFLICT_RETRIES} attempts`);
}
