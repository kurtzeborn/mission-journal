// Detection for photos that arrived as a link instead of as attachments.
//
// Missionaries with more photos than an email will carry link a shared album
// rather than attaching them, and both of the first two real letters did
// exactly that. The link renders as an anchor and nothing is ever fetched --
// a Google Photos album cannot be fetched at all, and a Drive file could be
// but deliberately is not. See the plan's "Photos that arrive as links"
// section for why.
//
// This exists to answer one question with evidence rather than guesswork:
// how often does this happen, and to which service. That answer is the input
// any later decision needs, and it only starts accumulating once this ships.

// Bounded by the characters that end a URL inside HTML -- quotes and angle
// brackets close an attribute, and the closing bracket cases catch a link
// written inline in prose.
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

// Two services, kept apart because their prospects are opposite: a Drive link
// is fetchable in principle and a Photos album is not. Collapsing them to a
// bool would erase the only part of the observation worth recording.
const SERVICES = [
    { name: 'googlePhotos', hosts: ['photos.app.goo.gl', 'photos.google.com'] },
    { name: 'googleDrive', hosts: ['drive.google.com'] }
];

/**
 * @param {string|null} body sanitized HTML, or the plain-text letter when
 *   there is no HTML part
 * @returns {string[]} service names, sorted; empty when nothing matched
 */
export function linkedPhotoServices(body) {
    if (!body) return [];

    const found = new Set();

    for (const [url] of String(body).matchAll(URL_PATTERN)) {
        // Parsed rather than substring-matched, so a host appearing in a path
        // or in userinfo -- `evil.com/photos.google.com`, or
        // `photos.google.com@evil.com` -- is not counted as the real thing.
        let host;
        try {
            host = new URL(url).hostname.toLowerCase();
        } catch {
            continue;
        }

        for (const service of SERVICES) {
            if (service.hosts.includes(host)) found.add(service.name);
        }
    }

    return [...found].sort();
}
