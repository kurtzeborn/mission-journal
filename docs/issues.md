# Loose ends

Small things that are wrong, missing, or unfinished, and that have nowhere else to live. [plan.md](plan.md) is the design and records decisions; [todos.md](todos.md) is work that comes due on a clock. This is the third category — **things somebody would file as a bug or a chore**, none of which is big enough to be a phase and all of which would otherwise survive only in somebody's memory.

Nothing here blocks anything. That is exactly why it needs writing down.

---

## Defects

None outstanding.

---

## Gaps in verification

### `web/app.js` is only half covered

[web/reader.js](../web/reader.js) runs under jsdom against the real page in `functions/tests/reader-dom.js`, and `web-app-photos.test.js` reaches the upload loop. The rest of the owner's request layer — the reload-and-return-to-the-letter behaviour, the notice stashed across a reload, the sentences that explain a refusal — is verified only by driving it by hand. It is also the file most likely to be edited while thinking about something else.

---

## Known and accepted

- **Font Awesome is served from `/vendor/` rather than a CDN**, so nothing reaches a third party while somebody is reading. If it ever fails to load, the owner's icon buttons render blank — they still work and still announce themselves, and a missing vendored asset is a broken deploy rather than somebody else's outage.
- **Video attachments are not handled.** Measured once from a real phone: H.264/AAC with `mdat` ahead of `moov`, so it needs remuxing before a browser will start playing before the download finishes, at roughly 17.6 Mbps — which is the number that decides whether this is affordable. The album is where video would go, and that is [why the album is not in the zip](plan.md#the-photo-album).
