// Publishing the letters that arrived before anyone could read them.
//
// A pending site is a pile of letters and a claim record. Promotion is the
// moment that pile becomes an archive: the ACL now exists, so every letter
// that was held because there was nobody entitled to read it can be committed
// exactly as it would have been had it arrived a minute ago.
//
// Three properties this has to have, in order of how much they cost to get
// wrong:
//
//   **It must not lose a letter.** A pending blob is deleted only after its
//   post is committed. A crash halfway leaves the remainder still pending and
//   the promoted ones already published, which is precisely the state a
//   re-run expects to find.
//
//   **It must be safe to run twice.** It follows from the above plus
//   `findDuplicate`: a letter whose blob was committed but not deleted comes
//   back round, matches its own post on Message-ID, and is dropped as a
//   duplicate rather than published twice.
//
//   **One bad letter must not block the rest.** A message that fails to
//   extract stays pending and is reported; the others still publish. The
//   alternative -- abandoning the batch on first error -- means one
//   malformed message can withhold a year of someone's mail.
//
// Letters are replayed in ULID order, which is arrival order. That matters
// only for letters sharing a timestamp, where first-write-wins then means
// first-arrived-wins, but it costs nothing to be deliberate about.

import { commitLetter } from './ingest.js';
import { extractOriginal } from './extract.js';
import { CLASS, DISPOSITION } from './classify.js';

const decodeMeta = (value) => {
    if (!value) return '';
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

const ulidOf = (name) => name.split('/').pop().replace(/\.eml$/, '');

/**
 * Publish everything held for a slug.
 *
 * @returns {{promoted: number, duplicates: number, failed: Array, postIds: string[]}}
 */
export async function promotePending({ store, tables = null, slug, now = () => new Date(), log = console }) {
    const names = (await store.listBlobs('pending', `${slug}/`)).filter((n) => n.endsWith('.eml'));

    const result = { promoted: 0, duplicates: 0, failed: [], postIds: [] };

    for (const name of names) {
        const ulid = ulidOf(name);
        try {
            const blob = await store.readBlob('pending', name);
            if (!blob) continue;

            const extracted = await extractOriginal(blob.bytes);

            // Synthesized rather than recomputed, and safe to synthesize
            // because only one path can put a letter here: `runIngest` holds
            // a message solely when it has already classified it as a direct
            // send from an authenticated missionary domain, which fixes every
            // field below. A forward never reaches the pending container --
            // it is rejected as `unknown-slug` long before -- so there is no
            // second shape to account for.
            const verdict = {
                class: CLASS.direct,
                disposition: DISPOSITION.publish,
                slug,
                reason: null,
                forwarder: null
            };

            const committed = await commitLetter({
                store,
                tables,
                slug,
                ulid,
                raw: blob.bytes,
                extracted,
                envelope: {
                    to: decodeMeta(blob.metadata?.envelopeto),
                    from: decodeMeta(blob.metadata?.envelopefrom)
                },
                verdict,
                now,
                log
            });

            if (committed.status === 'stored') {
                result.promoted += 1;
                result.postIds.push(committed.postId);
            } else if (committed.status === 'duplicate') {
                result.duplicates += 1;
            } else {
                result.failed.push({ ulid, reason: committed.status });
                continue;
            }

            // Only now. The letter exists in raw/ and in posts.json, so the
            // pending copy is redundant rather than the only copy.
            await store.deleteBlob('pending', name);
        } catch (error) {
            // Left pending on purpose: whatever went wrong, the bytes are
            // still the only place that letter exists, and a re-run after a
            // fix will find them.
            log.error?.('promote: letter failed', { slug, ulid, error: error.message });
            result.failed.push({ ulid, reason: 'error', message: error.message });
        }
    }

    log.info?.('promote: finished', {
        slug,
        promoted: result.promoted,
        duplicates: result.duplicates,
        failed: result.failed.length
    });

    return result;
}
