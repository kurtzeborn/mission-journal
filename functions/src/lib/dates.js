// Dates as the sender wrote them.
//
// Missionaries write from every time zone there is. Normalizing to UTC would
// change the calendar day of a letter written in the evening in Manaus, and
// the local day is both what readers mean by "the letter from the 6th" and
// the one value every copy of a message preserves. So the offset in the
// header is carried through rather than resolved away.

const MONTHS = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

const pad = (n) => String(n).padStart(2, '0');

// "Sun, 2 Aug 2026 18:04:22 -0400"
const RFC5322 =
    /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Z]{2,4})?/;

// Client-rendered quoted headers, which carry no offset at all:
// "Sat, Aug 1, 2026 at 8:20 PM" (Gmail), "Saturday, August 1, 2026 8:20 PM"
// (Outlook).
const WRITTEN =
    /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})(?:\s+at)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?/;

function parts(text) {
    if (!text) return null;
    const s = String(text);

    // RFC 3339, which is how a date already committed to posts.json comes
    // back. Re-parsed rather than trusted as a string so a stored post and a
    // freshly parsed header compare on the same footing.
    const iso = s.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?/
    );
    if (iso) {
        return {
            year: iso[1],
            month: iso[2],
            day: iso[3],
            hour: iso[4],
            minute: iso[5],
            second: iso[6] ?? '00',
            offset: iso[7] === 'Z' ? '+0000' : (iso[7] ?? '').replace(':', '') || null
        };
    }

    const rfc = s.match(RFC5322);
    if (rfc) {
        const month = MONTHS[rfc[2].toLowerCase()];
        if (month) {
            return {
                year: rfc[3],
                month,
                day: pad(rfc[1]),
                hour: pad(rfc[4]),
                minute: rfc[5],
                second: rfc[6] ?? '00',
                // A named zone that is not a numeric offset is not resolvable
                // without a table that changes with politics. Treated as
                // absent, which downgrades the value to floating time rather
                // than guessing wrong.
                offset: /^[+-]\d{4}$/.test(rfc[7] ?? '') ? rfc[7] : null
            };
        }
    }

    const written = s.match(WRITTEN);
    if (written) {
        const month = MONTHS[written[1].toLowerCase()];
        if (month) {
            let hour = Number(written[4]);
            const meridiem = (written[7] ?? '').toLowerCase();
            if (meridiem === 'p' && hour < 12) hour += 12;
            if (meridiem === 'a' && hour === 12) hour = 0;
            return {
                year: written[3],
                month,
                day: pad(written[2]),
                hour: pad(hour),
                minute: written[5],
                second: written[6] ?? '00',
                offset: null
            };
        }
    }

    return null;
}

// The calendar day as written: "2026-08-01".
export function dayInOwnOffset(text) {
    const p = parts(text);
    return p ? `${p.year}-${p.month}-${p.day}` : null;
}

// RFC 3339 with the original offset preserved: "2026-08-01T20:20:59-07:00".
// When the source carried no offset — every inline forward — the result is a
// floating local time with no zone designator, which is what was actually
// known. It is never silently stamped as UTC.
export function rfc3339InOwnOffset(text) {
    const p = parts(text);
    if (!p) return null;
    const stamp = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    if (!p.offset) return stamp;
    return `${stamp}${p.offset.slice(0, 3)}:${p.offset.slice(3)}`;
}
