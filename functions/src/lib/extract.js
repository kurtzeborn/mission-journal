// Recovering the original letter from whatever the forwarder's client sent.
//
// Two shapes exist. Either the client embedded a complete copy of the message
// as an attachment, or it flattened the original into the outer body and left
// its headers behind as quoted text. The embedded copy is always preferred:
// it carries real headers, a real Date, and a Message-ID.

import PostalMime from 'postal-mime';

// Clients disagree on how a forwarded block starts. Gmail draws a rule of
// hyphens, Outlook web and Android draw underscores, and Outlook desktop
// draws nothing at all in the plain-text part.
const SEPARATORS = [
    /^-{3,}\s*Forwarded message\s*-{3,}\s*$/i,
    /^_{8,}\s*$/
];

const HEADER_LINE = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/;

// postal-mime leaves Windows-1252 parts undecoded, so bytes 0x80-0x9F arrive
// as raw C1 control characters — an em dash shows up as U+0097 and renders as
// nothing at all. Outlook web and Outlook Android both label their parts
// Windows-1252, so this is not an edge case. Real text never contains C1
// controls, which makes the repair unambiguous.
const CP1252 =
    '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D' +
    '\u017D\u008F\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161' +
    '\u203A\u0153\u009D\u017E\u0178';

export function repairCp1252(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/[\u0080-\u009F]/g, (c) => CP1252[c.charCodeAt(0) - 0x80]);
}

// An address as a client renders it: "Name <addr>", "<addr>", or bare.
export function parseAddress(value) {
    if (!value) return null;
    const angled = value.match(/<([^>]+)>/);
    const address = (angled ? angled[1] : value).trim();
    return address.includes('@') ? address.toLowerCase() : null;
}

// The declared MIME type is not evidence — it is forwarder-controlled, and
// Outlook Android labels the embedded original application/octet-stream. The
// test is whether the bytes parse as a message.
//
// The window has to be generous: ARC seals and DKIM signatures push From:
// deep into the header block, as far as byte 12,103 in the Gmail captures.
const SNIFF_BYTES = 65536;

function looksLikeMessage(bytes) {
    const head = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString('latin1');
    if (!HEADER_LINE.test(head.split(/\r?\n/, 1)[0] || '')) return false;
    const headerBlock = head.split(/\r?\n\r?\n/, 1)[0];
    return /^From:\s*\S/im.test(headerBlock);
}

// postal-mime hands back a string for parts it considers text — which
// includes a message/rfc822 attachment carried verbatim rather than base64 —
// and an ArrayBuffer for everything else.
function toBytes(content) {
    if (!content) return new Uint8Array(0);
    if (typeof content === 'string') return Buffer.from(content, 'latin1');
    if (content instanceof Uint8Array) return content;
    return new Uint8Array(content);
}

export function findEmbeddedMessage(parsed) {
    for (const attachment of parsed.attachments ?? []) {
        const bytes = toBytes(attachment.content);
        if (bytes.length && looksLikeMessage(bytes)) {
            return { bytes, declaredType: (attachment.mimeType || '').toLowerCase() };
        }
    }
    return null;
}

// Reads the quoted header block a client leaves behind when it flattens a
// forward. Values may wrap onto continuation lines, which are indented by
// some clients and not by others, so a line that does not itself look like a
// header is treated as a continuation of the previous one.
export function readQuotedHeaders(text) {
    if (!text) return null;
    const lines = text.split(/\r?\n/);

    let start = lines.findIndex((line) => SEPARATORS.some((re) => re.test(line.trim())));
    if (start >= 0) {
        start += 1;
    } else {
        // Outlook desktop emits no rule in the plain-text part; the block
        // simply begins at the first From: line.
        start = lines.findIndex((line) => /^From:\s*\S/.test(line));
        if (start < 0) return null;
    }

    const headers = {};
    let last = null;
    let seen = 0;

    for (let i = start; i < lines.length && seen < 12; i++) {
        const line = lines[i];
        if (!line.trim()) {
            if (Object.keys(headers).length) break;
            continue;
        }
        seen++;
        const match = line.match(HEADER_LINE);
        if (match) {
            last = match[1].toLowerCase();
            headers[last] = match[2].trim();
        } else if (last) {
            headers[last] = `${headers[last]} ${line.trim()}`.trim();
        }
    }

    return Object.keys(headers).length ? headers : null;
}

// An image is inline when the body actually points at it. Neither of the
// obvious shortcuts works: Gmail stamps a Content-ID on ordinary attachments,
// and Outlook mobile rebuilds the message so that every part claims to belong
// to the related group. What the HTML references is the only honest test.
function splitAttachments(parsed) {
    const referenced = new Set();
    for (const match of String(parsed.html || '').matchAll(/cid:([^"'\s>)]+)/gi)) {
        referenced.add(decodeURIComponent(match[1]).toLowerCase());
    }

    const inline = [];
    const files = [];
    for (const a of parsed.attachments ?? []) {
        const cid = stripCid(a.contentId).toLowerCase();
        const isInline = cid ? referenced.has(cid) : a.disposition === 'inline';
        if (isInline) inline.push(a);
        else files.push(a);
    }
    return { inline, files };
}

const stripCid = (id) => String(id || '').replace(/^</, '').replace(/>$/, '');

// Gmail web sends an attached forward with a present-but-empty Subject header,
// which postal-mime reports as undefined. An absent subject and an empty one
// mean the same thing downstream, so both collapse to the empty string.
const subjectOf = (parsed) => repairCp1252(parsed.subject) ?? '';

export async function extractOriginal(raw) {
    const outer = await PostalMime.parse(raw);
    const sender = outer.from?.address?.toLowerCase() ?? null;

    const embedded = findEmbeddedMessage(outer);
    if (embedded) {
        const inner = await PostalMime.parse(embedded.bytes);
        const { inline, files } = splitAttachments(inner);
        return {
            source: 'rfc822',
            embeddedPartType: embedded.declaredType,
            embeddedBytes: embedded.bytes,
            sender,
            forwarder: sender,
            headers: outer.headers,
            outerSubject: subjectOf(outer),
            original: {
                from: inner.from?.address?.toLowerCase() ?? null,
                subject: repairCp1252(inner.subject) ?? null,
                // An embedded copy carries a real Date header, so this is the
                // one path that yields an actual instant.
                date: inner.date ? new Date(inner.date).toISOString() : null,
                dateText: null,
                datePrecision: 'second',
                messageId: inner.messageId ?? null
            },
            attachments: files,
            inlineImages: inline,
            inlineCids: inline.map((a) => stripCid(a.contentId))
        };
    }

    const quoted = readQuotedHeaders(repairCp1252(outer.text));
    if (!quoted || !quoted.from) {
        // Nothing was forwarded: the message in hand *is* the original. It
        // still has to yield a usable record, because a direct send from the
        // missionary is the intended path, not a degenerate case.
        const { inline, files } = splitAttachments(outer);
        return {
            source: null,
            embeddedPartType: null,
            sender,
            forwarder: null,
            headers: outer.headers,
            outerSubject: subjectOf(outer),
            original: {
                from: sender,
                subject: repairCp1252(outer.subject) ?? null,
                date: outer.date ? new Date(outer.date).toISOString() : null,
                dateText: null,
                datePrecision: 'second',
                messageId: outer.messageId ?? null
            },
            attachments: files,
            inlineImages: inline,
            inlineCids: inline.map((a) => stripCid(a.contentId))
        };
    }

    const { inline, files } = splitAttachments(outer);
    // Gmail says Date:, Outlook says Sent:. Neither carries a timezone, so no
    // instant can be recovered — the text is kept verbatim instead, including
    // the narrow no-break space Gmail puts before the meridiem.
    const dateText = quoted.date ?? quoted.sent ?? null;

    return {
        source: 'inline',
        embeddedPartType: null,
        sender,
        forwarder: sender,
        headers: outer.headers,
        outerSubject: subjectOf(outer),
        original: {
            from: parseAddress(quoted.from),
            subject: quoted.subject ?? null,
            date: null,
            dateText,
            datePrecision: dateText && /\d{1,2}:\d{2}:\d{2}/.test(dateText) ? 'second' : 'minute',
            messageId: null
        },
        attachments: files,
        inlineImages: inline,
        inlineCids: inline.map((a) => stripCid(a.contentId))
    };
}
