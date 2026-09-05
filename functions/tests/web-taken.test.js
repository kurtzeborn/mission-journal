// Working out when a photograph was taken, in the browser, before it is sent.
//
// This is the only place the date can come from. The server strips EXIF on
// purpose -- it carries GPS, and a missionary's coordinates are not the
// family's to publish -- and keeps nothing of the original bytes, so a picture
// uploaded without a date read here has no date, ever.
//
// Two things are proved. That the EXIF walk finds the tag in the byte layout a
// camera actually writes, both endiannesses, and gives up quietly on files
// that are not JPEGs or are cut short. And that the filename fallback reads
// the names that real photographs arrive under while refusing the ones that
// only look like dates -- which is the failure that matters, because a
// message attachment named after a sixteen-digit id would otherwise be filed
// under the year 1206 and land on the first letter in the archive.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context = { window: {} };
runInNewContext(
    readFileSync(new URL('../../web/taken.js', import.meta.url), 'utf8'),
    context,
    { filename: 'taken.js' }
);
const Taken = context.window.Taken;

// --- building a JPEG by hand -------------------------------------------

// Small enough to read, and exactly the shape the walk expects: the start
// marker, one APP1 segment holding a TIFF header and two directories, then
// the start of scan that says the rest is pixels.
function jpeg({ little = true, original = null, digitized = null, modified = null, marker = 0xffe1 } = {}) {
    const bytes = [];
    const u8 = (v) => bytes.push(v & 0xff);
    const u16 = (v) => (little ? (u8(v), u8(v >> 8)) : (u8(v >> 8), u8(v)));
    const u32 = (v) => (little ? (u8(v), u8(v >> 8), u8(v >> 16), u8(v >> 24)) : (u8(v >> 24), u8(v >> 16), u8(v >> 8), u8(v)));

    // The exif sub-directory sits after IFD0 and its two entries; both are
    // laid out at fixed offsets so the value pointers can be written flat.
    const ifd0Entries = modified ? 2 : 1;
    const ifd0At = 8;
    const exifAt = ifd0At + 2 + ifd0Entries * 12 + 4;
    const exifEntries = (original ? 1 : 0) + (digitized ? 1 : 0);
    let valueAt = exifAt + 2 + exifEntries * 12 + 4;

    const entry = (tag, type, count, value) => {
        u16(tag);
        u16(type);
        u32(count);
        u32(value);
    };

    const strings = [];
    const string = (text) => {
        const at = valueAt;
        strings.push(text);
        valueAt += 20;
        return at;
    };

    const modifiedAt = modified ? string(modified) : 0;
    const originalAt = original ? string(original) : 0;
    const digitizedAt = digitized ? string(digitized) : 0;

    // TIFF header.
    u16(little ? 0x4949 : 0x4d4d);
    u16(42);
    u32(ifd0At);

    // IFD0: the exif pointer, and DateTime if one was asked for.
    u16(ifd0Entries);
    if (modified) entry(0x0132, 2, 20, modifiedAt);
    entry(0x8769, 4, 1, exifAt);
    u32(0);

    // The exif sub-directory.
    u16(exifEntries);
    if (original) entry(0x9003, 2, 20, originalAt);
    if (digitized) entry(0x9004, 2, 20, digitizedAt);
    u32(0);

    for (const text of strings) {
        for (let i = 0; i < 20; i += 1) u8(i < text.length ? text.charCodeAt(i) : 0);
    }

    const tiff = bytes;
    const head = [0xff, 0xd8];
    const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
    const length = payload.length + 2;
    head.push(marker >> 8, marker & 0xff, length >> 8, length & 0xff, ...payload);
    head.push(0xff, 0xda, 0x00, 0x02);
    return new Uint8Array(head);
}

describe('the date written inside the file', () => {
    test('a little-endian camera, which is nearly all of them', () => {
        assert.equal(
            Taken.fromExif(jpeg({ original: '2025:04:28 14:07:33' })),
            '2025-04-28T14:07:33'
        );
    });

    test('a big-endian one reads the same', () => {
        assert.equal(
            Taken.fromExif(jpeg({ little: false, original: '2025:04:28 14:07:33' })),
            '2025-04-28T14:07:33'
        );
    });

    test('the shutter beats the import', () => {
        // DateTimeDigitized is when the file reached the computer, which for a
        // scanned photograph is decades out.
        assert.equal(
            Taken.fromExif(
                jpeg({ original: '2025:04:28 14:07:33', digitized: '2026:01:02 08:00:00' })
            ),
            '2025-04-28T14:07:33'
        );
    });

    test('and the import beats the last save', () => {
        assert.equal(
            Taken.fromExif(jpeg({ digitized: '2026:01:02 08:00:00', modified: '2026:06:06 06:06:06' })),
            '2026-01-02T08:00:00'
        );
    });

    test('a file with no dates in it says so', () => {
        assert.equal(Taken.fromExif(jpeg()), null);
    });

    test('a segment that is not EXIF is stepped over, not read', () => {
        // APP0 is a JFIF header and holds nothing of interest. A walk that
        // assumed the first segment was the one it wanted would read its
        // length as a TIFF header.
        assert.equal(Taken.fromExif(jpeg({ marker: 0xffe0, original: '2025:04:28 14:07:33' })), null);
    });

    test('something that is not a JPEG at all', () => {
        // HEIC lands here. Its metadata is a different container entirely, so
        // the name has to carry it -- which is why the fallback exists.
        assert.equal(Taken.fromExif(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])), null);
    });

    test('a file cut off part way through', () => {
        // Only the head of each file is read, so a large photograph whose EXIF
        // sits unusually deep arrives truncated. That is a picture with no
        // date, not an upload that fails.
        const whole = jpeg({ original: '2025:04:28 14:07:33' });
        assert.equal(Taken.fromExif(whole.slice(0, whole.length - 30)), null);
    });

    test('empty bytes', () => {
        assert.equal(Taken.fromExif(new Uint8Array(0)), null);
    });
});

describe('the date in the name, when the file kept none', () => {
    const reads = (name, expected) =>
        test(name, () => assert.equal(Taken.fromName(name), expected));

    reads('20240808_210229_Original.JPG', '2024-08-08T21:02:29');
    reads('IMG_20240808_210229.jpg', '2024-08-08T21:02:29');
    reads('PXL_20240808_210229.jpg', '2024-08-08T21:02:29');
    // WhatsApp strips the metadata and keeps the day. Every one of these is a
    // photograph somebody sent home, and there are hundreds of them.
    reads('IMG-20240930-WA0012_Original.JPG', '2024-09-30T00:00:00');
    reads('BeautyPlus_20250228204045749_save_Original.JPG', '2025-02-28T20:40:45');
    reads('2024-08-08 21.02.29.jpg', '2024-08-08T21:02:29');
    reads('2024-08-08.jpg', '2024-08-08T00:00:00');
    reads('Screenshot_20250612-183000.png', '2025-06-12T18:30:00');
});

describe('names that only look like dates', () => {
    const refuses = (name, label = name) =>
        test(label, () => assert.equal(Taken.fromName(name), null));

    // Messenger names its attachments after ids. Read eight digits off the
    // front of this and the photograph is filed under the year 1206, which
    // puts it on the first letter of the archive.
    refuses('received_1206313707238074_Original.JPG');
    refuses('received_520323753701384.jpeg');
    refuses('motion_photo_3886514557024394542.jpg');
    refuses('1000249687_Original.JPG');
    refuses('875696E1-9F5B-4A21-9C0C-1B7E2D3F4A5C.jpg');
    refuses('f36b1f98a4c2d1e0b9a8c7d6e5f4a3b2_Original.JPG');
    refuses('IMG_9426-1.JPG');
    refuses('Independencia_15.jpg');
    // The digits parse and the day does not exist.
    refuses('20250231_120000.jpg');
    // Before anybody in this archive was taking photographs.
    refuses('18800101_120000.jpg');
    refuses('', 'a file with no name at all');
});

describe('a file, bytes and name together', () => {
    const file = (name, bytes = new Uint8Array(0)) => ({
        name,
        slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
    });

    test('the bytes are believed over the name', async () => {
        // They disagree here on purpose. Editing apps rename freely, and the
        // camera's own record is the one that was there when the shutter
        // opened.
        assert.equal(
            await Taken.of(file('20200101_000000.jpg', jpeg({ original: '2025:04:28 14:07:33' }))),
            '2025-04-28T14:07:33'
        );
    });

    test('the name carries it when the bytes say nothing', async () => {
        assert.equal(await Taken.of(file('IMG-20240930-WA0012.jpg')), '2024-09-30T00:00:00');
    });

    test('neither is an answer, not an error', async () => {
        assert.equal(await Taken.of(file('holiday.jpg')), null);
    });

    test('a file the browser can no longer read still answers on its name', async () => {
        // OneDrive placeholders go offline mid-selection. Losing the date is
        // survivable; losing the upload is not.
        const gone = {
            name: '20240808_210229.jpg',
            slice: () => ({
                arrayBuffer: async () => {
                    throw new Error('not available offline');
                }
            })
        };
        assert.equal(await Taken.of(gone), '2024-08-08T21:02:29');
    });
});
