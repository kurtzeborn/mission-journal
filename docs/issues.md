# Loose ends

Small things that are wrong, missing, or unfinished, and that have nowhere else to live. [plan.md](plan.md) is the design and records decisions; [todos.md](todos.md) is work that comes due on a clock. This is the third category — **things somebody would file as a bug or a chore**, none of which is big enough to be a phase and all of which would otherwise survive only in somebody's memory.

Nothing here blocks anything. That is exactly why it needs writing down.

---

## Defects

### A comment names the wrong table

The comment above `.deletions--dense` in [web/styles.css](../web/styles.css) describes "the arrivals table", one row per archive, growing without bound. `arrivals` is one row per *letter* and has been swept nightly since the `sweep` timer landed. The rules under that comment style the operator page's last-received view, which is the table actually described. One word.

---

## Gaps in verification

### `web/app.js` has no tests

[web/reader.js](../web/reader.js) runs under jsdom against the real page in `functions/tests/reader-dom.js`. `app.js` has no harness at all, so the owner's entire request layer — the reload-and-return-to-the-letter behaviour, the upload loop, the notice stashed across a reload, the sentences that explain a refusal — is verified only by driving it by hand. It is also the file most likely to be edited while thinking about something else.

### Nobody has read the site with a screen reader

Never audited, and the owner bar raises the stakes: it is icon-only now, so each control's meaning lives entirely in its `aria-label`. The album, the word cloud and the search stepper are all keyboard-reachable by construction and none of them has been listened to.

---

## The photo album, small things

None of these is wrong; all of them were noticed and left.

- **No pinch-zoom in the viewer.** The deck that stood here before had it, from the library; the grid does not. A phone can zoom the page but not the photograph, and a face in the back of a group shot is where somebody wants to get closer.
- **No way to narrow the album** to one letter or one month. The whole archive is the right default; it is not always the right answer.
- **No swipe between photographs in the viewer.** The arrows and the arrow keys are the whole of the navigation, and a thumb on a phone reaches for a swipe first.
- **A picture in a letter does not link into the album.** Clicking it opens the reader's lightbox, which is right, but there is nowhere to say "and show me the rest of them from here".

---

## Known and accepted

- **Font Awesome is served from `/vendor/` rather than a CDN**, so nothing reaches a third party while somebody is reading. If it ever fails to load, the owner's icon buttons render blank — they still work and still announce themselves, and a missing vendored asset is a broken deploy rather than somebody else's outage.
- **Video attachments are not handled.** Measured once from a real phone: H.264/AAC with `mdat` ahead of `moov`, so it needs remuxing before a browser will start playing before the download finishes, at roughly 17.6 Mbps — which is the number that decides whether this is affordable. The album is where video would go, and that is [why the album is not in the zip](plan.md#the-photo-album).
