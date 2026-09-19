# Insert pages into a PDF — design

**Status: phase 1 done and device-tested 2026-09-18, including the closed-PDF handwriting
move and undo (CT: handwriting moved to the right pages, survived reopen, undo restored).**
Written 2026-09-18. Supersedes the approach in `pdf-page-insertion-handoff.md` (local only):
CT chose to edit the PDF in place, as the InsertPage plugin does, rather than make a copy;
and if the native Templates picker is unavailable, Shelf offers its own templates.

## Goal

While reading a PDF, open Shelf and add a page after (or before) the current one — blank
or with a writing background — then land on it, ready to write. Undo the last insert.

## What InsertPage does (studied, not copied)

`github.com/dersalbader/supernote-PDF-Insert-page`, checked-in v0.1.0 and the v0.2.5 source
zip in that repo. The repo has **no licence**, so Shelf writes its own code; only the
approach and the public library/APIs carry over.

1. `getCurrentFilePath` / `getCurrentPageNum` for the open PDF and page.
2. Native Java with **PDFBox-Android** (`com.tom-roush:pdfbox-android:2.0.27.0`, Apache 2.0):
   load, `new PDPage(anchor.getMediaBox())`, `pages.insertAfter(...)`, draw a background
   with `PDPageContentStream` (7 mm lines, 5 mm squares or dots), `document.save(file)`.
3. Undo: one `undo_backup.pdf` in the plugin's files dir, overwritten by every edit.
4. Saves **over the file it loaded from**.
5. Reader refresh: `PluginFileAPI.openFile(path, newPage)` — reopening makes the reader
   reload the file and jump to the new page. README: allow ~8 s per operation.
6. **Nothing touches the handwriting sidecar** (`.pdf.mark`) in either version.

CT reports it "works very well" (permission prompts aside).

## Proven vs not

| Piece | Status |
|---|---|
| PDFBox-Android inside a Supernote plugin | proven by InsertPage (Manta, Chauvet 3.29.44) |
| `openFile(path, page)` reloads an edited PDF | proven by InsertPage |
| Open PDF path + current page | proven in Shelf |
| `getMarkPages(pdfPath)` lists pages with handwriting | proven 2026-09-18 (PdfMarkProbe: `[0,1,4]`) |
| Handwriting on later pages follows the insert on its own | **NO** — device test 2026-09-18 (Shelf and InsertPage alike) |
| A plugin can move PDF handwriting between pages | **YES** — PdfMarkProbe 2026-09-18, survives reopen |
| Supernote built-in template images readable from Shelf | not tested (phase 3) |
| Custom PDF page as a background (`LayerUtility`) | not tested (phase 2) |

## User flow

1. Reading a PDF, open Shelf. The Shelf tab shows **Insert Page…** (PDFs only; EPUBs and
   other documents never show it).
2. The insert screen:
   - **Where:** After page N (default) / Before page N. Pages are shown 1-based.
   - **Pages:** how many to add, 1–20 (CT: user chooses the count).
   - **Background:** Blank · Lined 8 mm (CT: those two are enough), then **Your
     template…** (phase 2) and Supernote's own templates (phase 3).
   - **Insert** · **Cancel**. **Undo last insert** appears when this PDF has one.
3. A progress screen ("Inserting the page…", then "Refreshing the PDF…"), like the quote
   placing screen.
4. The reader reopens on the new page; Shelf closes.

Locked or encrypted PDFs: a plain message that this PDF can't be changed. Nothing else.

## Moving handwriting with its pages

**Measured 2026-09-18:** the sidecar (`.mark`) stores PDF handwriting by page index, so
after an insert the handwriting stays on the old page numbers. InsertPage has this problem
and does nothing about it. A plugin can move handwriting itself — but **only while the PDF
is closed**:

| PDF state | getElements | insertElements | deleteElements | clearMarkElements / getMarkPages |
|---|---|---|---|---|
| open in the reader | ✅ | ✅ but **live only** — a reload discards it; pages beyond the reader's count refused | — | ✅ |
| closed (Shelf run from a note) | ✅ | ✅ written to `.mark`, survives reopen | ✅ survives reopen | ❌ 102 "not allowed" |

**Insert** (N pages, first new page at index b), started from inside the PDF:
1. While the PDF is open: `getMarkPages` lists pages with handwriting.
2. **Step out of the PDF**: open a note, keeping Shelf's progress screen up, and wait until
   the reader reports that note as the open file. Leaving also makes the reader save any
   handwriting just written. Note used, in order: the working note of the PDF's project;
   the last note Shelf saw this session; any project's working note; otherwise Shelf asks
   the user to open a note first.
3. PDFBox inserts the pages.
4. For every marked page p ≥ b, **highest first**: copy p → p + N (`insertElements`), then
   delete p's elements (`deleteElements`). A page is deleted only after its copy
   succeeded.
5. Reopen the PDF on the first new page.

**Any failure rolls back**: moved pages go back (lowest first), the PDF is restored from its
backup, the PDF is reopened on the original page, and the user is told nothing changed.

**Undo**, started from inside the PDF: `getMarkPages`; if the added pages have handwriting,
ask first (it is deleted with them); step out to a note; delete the added pages'
handwriting; move pages p ≥ b + N back to p − N, **lowest first**; restore the PDF; reopen.
Undo is refused up front if the PDF changed since the insert.

## Native engine (`ShelfPdfEditModule.java`, new)

Own code, one background thread, never on the UI thread.

**Insert:**
1. Load with a temp-file-backed memory setting (`MemoryUsageSetting.setupTempFileOnly()`)
   so large textbooks do not exhaust memory.
2. Refuse encrypted PDFs with a specific error (→ the "can't be changed" message).
3. New page sized to the anchor's **visible** area (CropBox), with the anchor's rotation,
   so it matches what the reader shows. Backgrounds are drawn in the displayed
   orientation.
4. Draw the background (below), insert before/after the anchor.
5. Save the edited PDF into **Shelf's private storage** (never over the file being read —
   PDFBox advises against it; InsertPage does it). Reopen it there and check the page
   count is original + count, and that the original did not change meanwhile.
6. Back up the original into private storage, then **write the new PDF's bytes over the
   original**. If that write fails part-way, the backup is written back.

   *Changed from the first draft*, which built a temp file beside the PDF and renamed it
   into place: that needs create/rename/delete in the user's folders, which plugin file
   access may refuse (a plugin java.io write outside the allowed places has thrown
   SecurityException before). Rewriting the PDF itself is the one user-folder operation
   InsertPage proves works, so it is the only one Shelf does. It also avoids SD-card
   rename differences.

**Undo:** write this PDF's backup back over it, then delete the backup. Refused if the
PDF's size differs from what the insert produced (it was changed since).
One backup **per PDF**, not one shared file; backups older than 30 days, or beyond the
5 most recent PDFs, are removed so they cannot fill the device.

**Backgrounds (phase 1):** Blank, or light-grey rules every **8 mm** (Supernote's standard
ruled spacing) within a 10 mm margin, drawn to run horizontally as displayed.

**Every inserted page is tagged** (`/ShelfInserted` in the page dictionary), so a later
**Delete this page** can refuse to delete the document's original pages (CT's concern).

**Phase 2 — your own templates:** pick an image (PNG/JPG) or a PDF with the device file
picker. Images are scaled to fit the page, centred on white, never stretched or cropped.
For a PDF, you choose which page; it is drawn as vectors (`LayerUtility.importPageAsForm`),
so it stays sharp.

**Phase 3 — Supernote's built-in templates:** `getNoteSystemTemplates()` gives each
template's image as `android.resource://com.ratta.supernote.pluginhost/drawable/…`. Shelf
runs inside PluginHost, so it may be able to decode those directly. Untested; if it works,
the background list shows Supernote's real templates by their own names.

**Dependency cost:** PDFBox-Android adds roughly 8 MB to Shelf's package (InsertPage's
`.snplg` is ~15 MB vs Shelf's ~7 MB). Its Apache 2.0 licence notice is added to the README.

## Keeping Shelf's own references right

After a successful insert, Shelf shifts its own references to that PDF: pinned pages and
captured quotes' source pages after the insert point go up by one. Undo shifts them back.

Not fixable: source links **already placed in notes** point at the old page numbers.
The README says so.

## Build order

1. **Phase 1:** native module + PDFBox, Blank/Lined 8 mm, 1–20 pages, before/after,
   handwriting warning, undo, reference shift, progress screen, refresh via `openFile`.
2. **Phase 2:** your own image/PDF templates.
3. **Phase 3:** Supernote's built-in templates (if they can be read).

Each phase: typecheck/lint/tests, CT approves the build, device test, then commit.

## Phase 1 device test

1. Insert a Lined page after the current page: the reader lands on it; lines at 8 mm.
2. Write on the new page, close and reopen the PDF: the writing is still there.
3. Before-page insert; a rotated or landscape PDF if you have one.
4. **Handwriting follows its pages:** write on pages 1–3, insert after page 1; the old
   page-2 writing must be on page 3, the new page empty. Then Undo: all back as before.
5. Undo: the page is gone and the PDF is as before.
6. A pinned page / captured quote after the insert point still opens the right page.
7. A large PDF (a textbook): time it, no crash.
8. A locked PDF: the "can't be changed" message, nothing written.

## Open questions for CT (defaults in brackets)

- **Delete page** — later, and only for pages Shelf inserted (tagged). Not phase 1.
- **Insert another PDF's pages** — maybe; CT worries about size (10-page PDF + 100-page
  insert). If built: show page count and size first and ask.
- **Several pages at once** — yes, with before/after; capped at 20 per insert.
