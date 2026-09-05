// When a photograph was taken, worked out in the browser from the file itself.
//
// This has to happen here, and it is the metadata rules that decide it. The
// server never sees an uploaded picture's original bytes for longer than one
// transcode: `photos.js` renders WebP with everything stripped, deliberately,
// because EXIF carries GPS and a missionary's photograph is a location their
// family may not intend to publish. Nothing is kept in `raw/` either -- that
// container holds messages, and an upload never was one. So if the capture
// date is not read before the bytes leave, it is not read at all.
//
// Two sources, in that order.
//
// EXIF is exact, and it is what a phone's own camera writes. The filename is
// the fallback, and it is not a guess: WhatsApp strips EXIF on send but names
// the file after the day, Messenger and the Android camera do the same, and on
// the files that carry both -- measured over a real mission's photographs --
// the two agree every time.
//
// The answer is a floating local time, `YYYY-MM-DDTHH:MM:SS`, with no offset
// on it. That is the same shape `present.js` sorts letters by and for the same
// reason: EXIF records the wall clock of wherever the shutter was pressed and
// no zone at all, so there is no instant to be had without inventing one.

/* exported Taken */

(function () {
    'use strict';

    // Enough to reach the EXIF block, which sits in the first segment of the
    // file, and far short of reading a ten-megabyte photograph to find a
    // twenty-byte string. Several hundred files go through this before a
    // single one is uploaded.
    const HEAD_BYTES = 128 * 1024;

    // --- EXIF -------------------------------------------------------------

    const APP1 = 0xffe1;
    const START_OF_SCAN = 0xffda;

    // The three tags that carry a time, in the order they deserve to be
    // believed. `DateTimeOriginal` is when the shutter opened. `DateTime` is
    // when the file was last written, which an editing app moves, so it is
    // consulted only when the other two are absent.
    const DATE_TIME_ORIGINAL = 0x9003;
    const DATE_TIME_DIGITIZED = 0x9004;
    const DATE_TIME = 0x0132;
    const EXIF_IFD = 0x8769;

    const ascii = (view, at, length) => {
        let out = '';
        for (let i = 0; i < length; i += 1) {
            const code = view.getUint8(at + i);
            if (!code) break;
            out += String.fromCharCode(code);
        }
        return out;
    };

    /**
     * Read the entries of one image file directory into a tag -> value map.
     *
     * Only the four-byte value field is taken. Every tag wanted here is either
     * a pointer, which is a LONG and lives in that field, or a twenty-byte
     * ASCII string, which cannot fit in four bytes and so is always an offset.
     * Neither case needs the type and count read back.
     */
    function readDirectory(view, tiff, at, little) {
        const found = new Map();
        const base = tiff + at;
        if (base + 2 > view.byteLength) return found;

        const entries = view.getUint16(base, little);
        for (let i = 0; i < entries; i += 1) {
            const entry = base + 2 + i * 12;
            if (entry + 12 > view.byteLength) break;
            found.set(view.getUint16(entry, little), view.getUint32(entry + 8, little));
        }
        return found;
    }

    function readStamp(view, tiff, offset) {
        if (offset == null) return null;
        const at = tiff + offset;
        if (at < 0 || at + 19 > view.byteLength) return null;

        // EXIF writes `YYYY:MM:DD HH:MM:SS`, colons in the date included.
        const text = ascii(view, at, 19);
        const parts = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
        return parts ? stamp(parts.slice(1)) : null;
    }

    function readTiff(view, tiff) {
        if (tiff + 8 > view.byteLength) return null;

        const order = view.getUint16(tiff);
        if (order !== 0x4949 && order !== 0x4d4d) return null;
        const little = order === 0x4949;
        if (view.getUint16(tiff + 2, little) !== 42) return null;

        const first = readDirectory(view, tiff, view.getUint32(tiff + 4, little), little);
        const exif = first.has(EXIF_IFD)
            ? readDirectory(view, tiff, first.get(EXIF_IFD), little)
            : new Map();

        return (
            readStamp(view, tiff, exif.get(DATE_TIME_ORIGINAL)) ??
            readStamp(view, tiff, exif.get(DATE_TIME_DIGITIZED)) ??
            readStamp(view, tiff, first.get(DATE_TIME))
        );
    }

    /**
     * The capture time recorded inside JPEG bytes, or null.
     *
     * Walks the marker segments rather than searching for the string, because
     * a photograph of a photograph of a receipt contains all sorts of things
     * that look like a date. HEIC and PNG return null and fall through to the
     * filename -- their metadata is a different container entirely, and the
     * files that reach this without EXIF are overwhelmingly ones a messaging
     * app has already stripped.
     *
     * @param {ArrayBuffer|Uint8Array} bytes the first of the file
     * @returns {string|null}
     */
    function fromExif(bytes) {
        const view =
            bytes instanceof DataView
                ? bytes
                : ArrayBuffer.isView(bytes)
                    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
                    : new DataView(bytes);

        try {
            if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

            let at = 2;
            while (at + 4 <= view.byteLength) {
                const marker = view.getUint16(at);
                // Past here the file is compressed image data, and there are
                // no more headers to find.
                if (marker === START_OF_SCAN) return null;
                // Out of step with the segment structure. A truncated read is
                // the ordinary cause, since only the head of the file was
                // fetched.
                if ((marker & 0xff00) !== 0xff00) return null;

                const length = view.getUint16(at + 2);
                if (length < 2) return null;

                if (marker === APP1 && ascii(view, at + 4, 4) === 'Exif') {
                    return readTiff(view, at + 10);
                }
                at += 2 + length;
            }
        } catch {
            // A malformed file is a file with no date, not a failed upload.
            return null;
        }

        return null;
    }

    // --- the filename -----------------------------------------------------

    // Every one is anchored against neighbouring digits, which is the whole
    // guard. Message attachments are named after enormous ids -- 1206313707238074,
    // 3886514557024394542 -- and a pattern that could match part of a longer run
    // would read the first eight digits of one as a date and file a photograph
    // under the year 1206.
    const PATTERNS = [
        // 20240808_210229, IMG_20240808_210229, PXL_20240808_210229123
        /(?<![0-9])(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?![0-9])/,
        // 2024-08-08 21.02.29, 2024-08-08T21-02-29
        /(?<![0-9])(\d{4})-(\d{2})-(\d{2})[ T_](\d{2})[.:-](\d{2})[.:-](\d{2})(?![0-9])/,
        // BeautyPlus_20250228204045749 -- date, time and milliseconds in one run
        /(?<![0-9])(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d{0,3}(?![0-9])/,
        // IMG-20240930-WA0012 -- the day, which is all WhatsApp keeps
        /(?<![0-9])(\d{4})(\d{2})(\d{2})(?![0-9])/,
        // 2024-08-08
        /(?<![0-9])(\d{4})-(\d{2})-(\d{2})(?![0-9])/
    ];

    /**
     * A capture time from the name a camera or a messaging app gave the file.
     *
     * @param {string} name
     * @returns {string|null}
     */
    function fromName(name) {
        for (const pattern of PATTERNS) {
            const found = pattern.exec(String(name ?? ''));
            if (!found) continue;
            const answer = stamp(found.slice(1));
            // Deliberately not `continue`: the patterns run most specific
            // first, so a match that fails to be a real date means the digits
            // were never a date, and a looser pattern reading the same digits
            // differently would be inventing one.
            if (answer) return answer;
        }
        return null;
    }

    // --- both -------------------------------------------------------------

    // A photograph older than this is not a mission photograph, it is a
    // misread. The upper bound is a year out so a clock set wrong on a phone
    // does not silently lose the picture.
    const EARLIEST = 1990;

    /**
     * Assemble and check the six parts, and refuse anything that is not a day
     * that existed. February 31st is what this is for: the digits parse, the
     * date does not, and a filename full of ids will produce one eventually.
     */
    function stamp(parts) {
        const [year, month, day, hour = '00', minute = '00', second = '00'] = parts.map(Number);
        if (!(year >= EARLIEST && year <= new Date().getFullYear() + 1)) return null;
        if (hour > 23 || minute > 59 || second > 59) return null;

        const when = new Date(year, month - 1, day);
        if (when.getFullYear() !== year || when.getMonth() !== month - 1 || when.getDate() !== day) {
            return null;
        }

        const pad = (n) => String(n).padStart(2, '0');
        return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
    }

    /**
     * When this file was taken, from its bytes if they say and its name if not.
     *
     * @param {File} file
     * @returns {Promise<string|null>}
     */
    async function of(file) {
        let head = null;
        try {
            head = await file.slice(0, HEAD_BYTES).arrayBuffer();
        } catch {
            // A file the browser can no longer read is one the upload is about
            // to fail on anyway. Answer on the name and let it get there.
        }

        return (head && fromExif(head)) || fromName(file?.name) || null;
    }

    window.Taken = { of, fromExif, fromName };
})();
