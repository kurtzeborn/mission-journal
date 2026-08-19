// Shared in-memory blob/queue fake.
//
// Deliberately one implementation for every suite: a second copy would be free
// to disagree with the first, and a test double that disagrees with reality is
// how a two-way ACL format mismatch survived a green suite once already.

export function memoryStore() {
    const blobs = new Map();
    const queues = new Map();
    const tables = new Map();
    let seq = 0;

    const rows = (table) => {
        if (!tables.has(table)) tables.set(table, new Map());
        return tables.get(table);
    };

    return {
        blobs,
        queues,
        tables,
        conflictOnce: null,
        async readBlob(container, name) {
            const found = blobs.get(`${container}/${name}`);
            return found ? { ...found } : null;
        },
        async writeBlob(container, name, bytes, options = {}) {
            const key = `${container}/${name}`;

            // Lets a test simulate another writer winning the race exactly
            // once, without any real concurrency.
            if (this.conflictOnce === key) {
                this.conflictOnce = null;
                const err = new Error('condition not met');
                err.statusCode = 412;
                throw err;
            }

            const current = blobs.get(key);
            if (options.ifNoneMatch === '*' && current) {
                const err = new Error('already exists');
                err.statusCode = 409;
                throw err;
            }
            if (options.ifMatch && current?.etag !== options.ifMatch) {
                const err = new Error('condition not met');
                err.statusCode = 412;
                throw err;
            }

            const etag = `etag-${++seq}`;
            blobs.set(key, {
                bytes: Buffer.from(bytes),
                metadata: options.metadata ?? {},
                contentType: options.contentType ?? null,
                etag
            });
            return { etag };
        },
        // Sorted, because the real listing is sorted and promotion depends on
        // that ordering being stable rather than on insertion order.
        async listBlobs(container, prefix = '') {
            const head = `${container}/`;
            return [...blobs.keys()]
                .filter((key) => key.startsWith(head + prefix))
                .map((key) => key.slice(head.length))
                .sort();
        },
        async deleteBlob(container, name) {
            blobs.delete(`${container}/${name}`);
        },
        // The real one asks storage for a user delegation key and signs a URL
        // with it. Nothing about that signature is worth faking; what a caller
        // can get wrong is asking for a link to a blob that is not there --
        // storage signs that happily and the 404 arrives later, in somebody
        // else's download. So this refuses instead of inventing a string.
        async readUrl(container, name, { minutes = 15 } = {}) {
            const key = `${container}/${name}`;
            if (!blobs.has(key)) throw new Error(`no blob to sign a link for: ${key}`);
            return `https://example.blob.core.windows.net/${key}?se=${minutes}m&sig=fake`;
        },
        async enqueue(queue, text) {
            if (!queues.has(queue)) queues.set(queue, []);
            queues.get(queue).push(text);
        },
        // Drains the stream into an ordinary blob, which is the part of the
        // real method worth faking: everything else about it -- the buffer
        // size, the concurrency, the fact that bytes leave before the last
        // one arrives -- is storage's business. What a caller can get wrong,
        // and what this makes visible, is handing over a stream that never
        // ends or one that is destroyed before it does.
        async uploadStream(container, name, stream, options = {}) {
            const chunks = [];

            // Listens for `end` and `error` and nothing else, which is the
            // one detail of the real method worth copying exactly. Storage
            // has no opinion about a stream that goes quiet: a caller who
            // abandons one without ending it or failing it leaves this
            // pending forever, and in production that is an invocation that
            // runs to the platform's timeout with a status blob still
            // reading "building". Draining it with `for await` instead would
            // quietly store the truncated half and hide exactly that.
            await new Promise((resolve, reject) => {
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('end', resolve);
                stream.on('error', reject);
            });

            blobs.set(`${container}/${name}`, {
                bytes: Buffer.concat(chunks),
                metadata: {},
                contentType: options.contentType ?? null,
                etag: `etag-${++seq}`
            });
        },

        // --- tables -------------------------------------------------------
        async getEntity(table, partitionKey, rowKey) {
            return rows(table).get(`${partitionKey}/${rowKey}`) ?? null;
        },
        // Merge, matching the real upsert mode: a partial entity updates the
        // fields it names and leaves the rest alone.
        async upsertEntity(table, entity) {
            const key = `${entity.partitionKey}/${entity.rowKey}`;
            rows(table).set(key, { ...(rows(table).get(key) ?? {}), ...entity });
        },
        // Returns false when the row exists, matching the real store's 409.
        // Single-threaded here, so this cannot reproduce the race it was
        // written for -- what it can check is that the caller respects the
        // answer.
        async insertEntity(table, entity) {
            const key = `${entity.partitionKey}/${entity.rowKey}`;
            if (rows(table).has(key)) return false;
            rows(table).set(key, { ...entity });
            return true;
        },
        async listEntities(table, { partitionKey } = {}) {
            return [...rows(table).values()].filter(
                (row) => !partitionKey || row.partitionKey === partitionKey
            );
        },
        async deleteEntity(table, partitionKey, rowKey) {
            rows(table).delete(`${partitionKey}/${rowKey}`);
        },
        json(container, name) {
            const blob = blobs.get(`${container}/${name}`);
            return blob ? JSON.parse(blob.bytes.toString('utf8')) : null;
        },
        seed(ulid, bytes, envelope = {}) {
            blobs.set(`inbox/${ulid}.raw`, {
                bytes: Buffer.from(bytes),
                metadata: {
                    envelopeto: encodeURIComponent(envelope.to ?? 'post@pdayletters.com'),
                    envelopefrom: encodeURIComponent(envelope.from ?? 'sender@example.com')
                },
                etag: `etag-${++seq}`
            });
        },
        // Wrapped exactly as infra/seed-config.ps1 writes it. The tests used to
        // seed a bare array, which is why a two-way format mismatch with the
        // real file survived a green suite.
        acl(slug, members) {
            blobs.set(`config/${slug}/acl.json`, {
                bytes: Buffer.from(JSON.stringify({ slug, members }), 'utf8'),
                metadata: {},
                etag: `etag-${++seq}`
            });
        }
    };
}
