// What we know about a book somebody paid to have printed.
//
// This is deliberately not a fourth state on the build. A build is ours: it
// starts when an owner presses a button, it ends when there are bytes in the
// container, and it is finished for good. An order is somebody else's, it
// starts after our part is over, and it goes on changing for weeks -- paid,
// in production, shipped, delivered, and occasionally refunded. Folding that
// into `status.json` would mean the record of what was built kept changing
// long after nothing about the book had.
//
// So it lives beside the book instead, in the same folder, in a container
// that is never swept. That is the same decision the print file gets and for
// the same reason: a reprint requested next year has to find the thing it is
// a reprint of.
//
// One file per book rather than a table, because every question anybody asks
// of it starts with "this book" -- there is no listing of all orders, no
// reporting, and no reason to invent an index for a lookup that already has a
// key.

import { BOOKS, bookFolder } from './publish.js';

export const orderName = (slug, id) => `${bookFolder(slug, id)}/order.json`;

// Enough to see the shape of what happened -- ordered, printed, shipped,
// delivered -- without letting a provider that likes sending the same status
// twice grow the file forever.
const HISTORY_MOST = 40;

/**
 * The order record for a book, if there is one.
 *
 * @returns {Promise<{order: object, etag: string} | null>}
 */
export async function readOrder({ store, slug, id }) {
    const blob = await store.readBlob(BOOKS, orderName(slug, id));
    if (!blob) return null;

    try {
        return { order: JSON.parse(Buffer.from(blob.bytes).toString('utf8')), etag: blob.etag };
    } catch {
        // Unreadable is treated as absent on purpose. The alternative is a
        // webhook that fails forever because one bad write happened once, and
        // the provider retries a failure until somebody notices.
        return null;
    }
}

/**
 * Merge something we have just been told into the record.
 *
 * Read-modify-write under the ETag, retried once, because the two webhooks
 * can land at the same instant on different instances and the loser of that
 * race is carrying the fact we actually wanted. Retried *once* rather than
 * looped: a second collision means something is wrong that a third attempt
 * will not fix, and this is called from a handler that has to answer.
 *
 * @returns {Promise<{order: object} | {error: string}>}
 */
export async function noteOrder({ store, slug, id, patch, log }) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const found = await readOrder({ store, slug, id });
        const order = found?.order ?? { slug, id, history: [] };

        const next = {
            ...order,
            ...patch,
            slug,
            id,
            updatedAt: new Date().toISOString()
        };

        // Every status we are told about, in the order we were told, which is
        // not necessarily the order they happened in. Written down as heard
        // rather than sorted, because a provider sending SHIPPED before PAID
        // is a thing worth being able to see rather than tidy away.
        if (patch.status && patch.status !== order.status) {
            next.history = [...(order.history ?? []), { at: next.updatedAt, status: patch.status }]
                .slice(-HISTORY_MOST);
        }

        try {
            await store.writeBlob(BOOKS, orderName(slug, id), JSON.stringify(next, null, 2), {
                contentType: 'application/json; charset=utf-8',
                ...(found?.etag ? { ifMatch: found.etag } : { ifNoneMatch: '*' })
            });
            return { order: next };
        } catch (err) {
            if (err?.statusCode !== 412 && err?.statusCode !== 409) throw err;
            log?.warn?.('order.raced', { slug, id, attempt });
        }
    }

    return { error: 'the order record was being written by somebody else' };
}
