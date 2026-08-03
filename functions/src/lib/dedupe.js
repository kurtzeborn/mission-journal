// Deciding whether a letter has already been ingested.
//
// A parent bulk-forwarding a year of letters, two relatives forwarding the
// same message, and an SMTP retry all produce near-identical mail. The cost
// of a false positive is a lost letter, so every test here is exact equality
// on a normalized field, never a similarity score.

import { dayInOwnOffset } from './dates.js';

// Strip reply and forward markers, and bracketed tags a gateway prepends.
// Iterative because clients stack them: "Re: [EXTERNAL] Fwd: Week 34".
export function normalizeSubject(subject) {
    let s = String(subject ?? '');
    for (;;) {
        const next = s
            .replace(/^\s*(re|fw|fwd|rv|aw|tr)\s*:\s*/i, '')
            .replace(/^\s*\[[^\]]*\]\s*/, '');
        if (next === s) break;
        s = next;
    }
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// The first 100 characters of what the author actually wrote: quoted replies
// and signature blocks are stripped first, because they are the parts a
// forwarding client rewrites.
export function bodyHead100(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const kept = [];
    for (const line of lines) {
        if (/^\s*>/.test(line)) continue;
        if (/^--\s*$/.test(line)) break;
        if (/^\s*Sent from my /i.test(line)) break;
        if (/^\s*Get Outlook for /i.test(line)) break;
        kept.push(line);
    }
    return kept.join(' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
}

// The comparable shape of a message, whether it came from a fresh extraction
// or from a post already committed to posts.json.
export function dedupeKey({ messageId, from, dateHeader, subject, text }) {
    return {
        messageId: messageId ? String(messageId).trim() : null,
        from: from ? String(from).toLowerCase() : null,
        day: dayInOwnOffset(dateHeader),
        subject: normalizeSubject(subject),
        head: bodyHead100(text)
    };
}

// Committed posts store no separate dedupe fields: the day is recoverable
// from originalDate because that value keeps its offset, and the normalized
// subject is recoverable from the subject. Only bodyHead100 is stored, being
// the one field derived from a body the post does not otherwise carry.
export function keyOfPost(post) {
    return {
        messageId: post.originalMessageId ?? null,
        from: post.originalFrom ? String(post.originalFrom).toLowerCase() : null,
        day: dayInOwnOffset(post.originalDate),
        subject: normalizeSubject(post.subject),
        head: post.bodyHead100 ?? ''
    };
}

// An empty normalized field is unmatchable, not a value. Gmail's forward-as-
// attachment composes with an empty Subject unless the forwarder types one,
// and a photos-only letter has no body text — so two unrelated forwards from
// one relative on the same day would otherwise normalize to the same empty
// strings and the second letter would be discarded as a duplicate of
// something it does not resemble.
const bothPresentAndEqual = (a, b) => Boolean(a) && a === b;

export function findDuplicate(candidate, posts) {
    for (const post of posts ?? []) {
        const existing = keyOfPost(post);

        // A Message-ID match is certain. Stop.
        if (bothPresentAndEqual(candidate.messageId, existing.messageId)) {
            return { post, reason: 'message-id' };
        }

        // The text gate applies when either side lacks a Message-ID — an
        // inline forward never has one, so a letter can arrive first as an
        // attached copy and later as inline text, or the reverse.
        if (candidate.messageId && existing.messageId) continue;

        if (!bothPresentAndEqual(candidate.from, existing.from)) continue;
        if (!bothPresentAndEqual(candidate.day, existing.day)) continue;
        if (!bothPresentAndEqual(candidate.subject, existing.subject)) continue;
        if (!bothPresentAndEqual(candidate.head, existing.head)) continue;

        return { post, reason: 'text-match' };
    }
    return null;
}
