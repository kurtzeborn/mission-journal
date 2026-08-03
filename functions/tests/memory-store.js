// Shared in-memory blob/queue fake.
//
// Deliberately one implementation for every suite: a second copy would be free
// to disagree with the first, and a test double that disagrees with reality is
// how a two-way ACL format mismatch survived a green suite once already.

export function memoryStore() {
    const blobs = new Map();
    const queues = new Map();
    let seq = 0;

    return {
        blobs,
        queues,
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
        async enqueue(queue, text) {
            if (!queues.has(queue)) queues.set(queue, []);
            queues.get(queue).push(text);
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
