// Cloudflare Email Worker: the first component to touch every letter.
//
// It does two things and nothing else: put the raw message in the inbox
// container, then enqueue its id. No parsing, no classification, no ACL
// lookup. Anything that can be deferred to the ingest Function is deferred,
// because a failure there retries from durable storage while a failure here
// costs the only copy of the message.
//
// On any failure it throws. Cloudflare then returns a temporary SMTP error,
// the sending server keeps its copy, and it tries again. Never catch a
// failure of the two durable writes below.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// ULID: 10 characters of timestamp, then 16 of randomness. Lexically
// sortable, so the inbox container lists in arrival order.
function ulid() {
    let now = Date.now();
    let time = '';
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[now % 32] + time;
        now = Math.floor(now / 32);
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let random = '';
    for (const b of bytes) random += CROCKFORD[b & 31];
    return time + random;
}

// Azure error bodies are safe to surface; the request URL is not, because the
// SAS token rides in the query string and Workers Logs is a second place a
// credential could leak.
async function failureDetail(response) {
    let body = '';
    try {
        body = (await response.text()).slice(0, 300);
    } catch {
        body = '(body unavailable)';
    }
    return `${response.status} ${response.statusText} ${body}`;
}

export default {
    async email(message, env, ctx) {
        const id = ulid();
        const sas = (q) => String(q || '').replace(/^\?/, '');

        // Buffered rather than streamed: Azure's Put Blob requires a
        // Content-Length and rejects chunked transfer encoding, and a Worker
        // cannot set Content-Length on a streaming body. Cloudflare caps
        // inbound mail at 25 MiB, comfortably inside the Worker memory limit.
        const raw = await new Response(message.raw).arrayBuffer();

        const blobUrl = `https://${env.STORAGE_ACCOUNT}.blob.core.windows.net/` +
            `${env.INBOX_CONTAINER}/${id}.raw?${sas(env.INBOX_SAS)}`;

        const put = await fetch(blobUrl, {
            method: 'PUT',
            headers: {
                'x-ms-blob-type': 'BlockBlob',
                'Content-Type': 'message/rfc822'
            },
            body: raw
        });
        if (!put.ok) {
            throw new Error(`inbox write failed for ${id}: ${await failureDetail(put)}`);
        }

        // Only now is the message durable. If the enqueue fails the sender
        // retries and we get a second id and a second blob; the ingest
        // Function de-duplicates on Message-ID, and the inbox lifecycle rule
        // clears the orphan after 30 days.
        const queueUrl = `https://${env.STORAGE_ACCOUNT}.queue.core.windows.net/` +
            `${env.INGEST_QUEUE}/messages?${sas(env.QUEUE_SAS)}`;

        const post = await fetch(queueUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml' },
            body: `<QueueMessage><MessageText>${id}</MessageText></QueueMessage>`
        });
        if (!post.ok) {
            throw new Error(`ingest enqueue failed for ${id}: ${await failureDetail(post)}`);
        }

        console.log(`accepted ${id} from ${message.from} to ${message.to} (${raw.byteLength} bytes)`);

        // Optional shadow copy, so fixture capture keeps working while the
        // catch-all is bound here. Deliberately failure-tolerant: the message
        // is already durable, and a forwarding problem must not provoke an
        // SMTP retry that would duplicate it.
        if (env.SHADOW_FORWARD) {
            try {
                await message.forward(env.SHADOW_FORWARD);
            } catch (err) {
                console.log(`shadow forward failed for ${id}: ${err.message}`);
            }
        }
    }
};
