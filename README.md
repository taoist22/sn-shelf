

https://github.com/user-attachments/assets/cab00cbd-c920-4aa1-b9f1-dff809c2548e

# Shelf

A reference navigator for Supernote e-ink devices. Shelf keeps each
project's working note and its reference materials one tap apart: pin notes,
PDFs, EPUBs, CBZ, XPS, and FB2 files to a per-project reference shelf, jump between them, capture
quotes from your reading — with an optional handwritten note about each —
and place them into any note with a link back to the source.

Built for research, coursework, and any writing that draws on multiple
sources. Shelf is deliberately **not** a launcher or dashboard — it manages
the loop between where you write and what you're reading.

## Core Concepts

- **Project** — anchored on either a working `.note` or a **folder**. A folder
  project (e.g. one folder per class) treats every file inside it as project
  territory and designates one note inside as its working note.
- **Reference Shelf** — each project's pinned sources, shown as a thumbnail
  grid: real page previews for notes, book-cover style cards for PDFs/EPUBs.
  The working note always occupies the first slot (badged `WORKING`).
- **Context-aware view** — the panel derives what to show from the file you
  are in when you open it: a project note or any of its materials shows that
  project's shelf; anywhere else shows the General Shelf. Priority when a
  file could belong to several: note anchor > pinned reference > containing
  folder (deepest wins) > general.
- **Quotes** — text captured from documents waits in a per-project inbox
  until you place it into the working note. Quotes can also be sent from a
  computer or tablet over Wi-Fi (see below).

## Using Shelf

### Set up a project

Open the note you write in (or any file in a class folder), open Shelf from
the toolbar, go to the **Projects** tab, and tap **Make Current Note a
Project**, or **Choose Folder Project…** to browse to any folder (including
empty folders and SD cards) and make it a project. For folder projects, open a
note inside the folder and designate it via **Make This the Working Note**
(later changeable by long-pressing any pinned note's card → **Set as Working
Note**).

### Pin references

Pins land on the shelf you are looking at:

- **Pin This Page** — pins the current file and exact page, including page 1
  and pages in supported PDF/EPUB/CBZ/XPS/FB2 documents.
- **Browse** — multi-select file picker (up to 9 at once), starting inside
  the project's folder but free to navigate anywhere. Browse additions resume
  at the file's last-used page because no page was selected when adding them.
- **Add to Project…** — appears when you're reading a file that isn't in
  any project (and you have at least one project): pins the current page
  straight into a project you pick, no need to leave the file and re-find
  it through Browse.
- Pins made outside any project land on the **General Shelf** and can be
  moved into a project later (long-press → **Move**).

### Navigate

- **Tap a card** to open it at its pinned page. Browse additions and working
  notes resume at their last-used page. Exact-page opening uses the current
  Supernote file API for notes and supported document formats.
- **Tap the project header** to return to the working note at your last-used
  page.
- **Long-press a card** for the detail view:
  - **Starred Pages** — jump chips for every five-star mark in the note
  - **Keywords** — jump chips for native keywords
  - **Headings** — recognized title text with jump chips. Recognition is
    incremental: most headings resolve instantly from Supernote's embedded
    recognition; new ones show as `· · ·` with a **Recognize** button.
    Long-press a heading chip to clear a wrong recognition and redo it.
  - **Pages** — numbered chips to jump to any page
  - **Open / Re-render preview / Move / Remove**, and **◀ Earlier / Later ▶**
    to reorder the card on the shelf

### Capture and place quotes

1. In a PDF or EPUB, select text with tap-and-drag; tap **Capture Quote** in
   the selection toolbar. (Rendered document text cannot be lasso-selected —
   that is a firmware limitation, use the text-selection gesture.)
2. The capture screen shows the quote at the top (editable) and a
   **Your Note** section at the bottom. To add your own handwritten note
   about the quote, tap **Write a Note** and write in the white area with
   the pen — real ink, not converted to text. It is optional; **Clear
   Writing** starts over. Tap **Save Quote**. Captures from a project's
   materials file automatically; captures from unaffiliated files ask which
   project to save to. (Tapping into the quote text itself brings up the
   device's handwriting keyboard, which converts writing to text — that is
   for editing the quote, not for your note.)
3. The **Quotes** tab (with a live count in its label) lists waiting quotes
   by project; ones with a handwritten note are marked **✎**. In **any**
   note, tap **Place**, then tap the line on the page where the quote should
   start. Shelf shows a **Placing the quote…** screen while it works (the
   handwriting takes a few seconds) and closes when done. Top to bottom you
   get: the quote as an editable text box, an italic source link that jumps
   back to the source page, and your handwritten note as real ink you can
   lasso, move, and erase. If the block would not fit below the tapped spot,
   nothing is inserted and Shelf asks you to tap higher or turn the page.
   The **Source links On/Off** toggle at the top of the tab controls the link
   for everything you place that session.
4. Outside a note (e.g. still in the PDF), a quote offers **Open** *working
   note* and **Choose a Note…**, a browser for any note on the device.
5. **Placing several at once**: in a note, each quote card shows a
   **Select** button; selected quotes get a **Place N Here** button at the
   top of the tab. This stacks them automatically, collision-aware — quotes
   land in the lowest clear space that avoids both your handwriting and
   anything already placed, never on top of either. When no such space
   exists, Shelf says so in bold — how many lines the quote needs vs. the
   largest clear run it found — and keeps the rest selected: turn to a fresh
   page and place again.
6. If a quote's text is placed but its handwriting cannot be inserted, the
   quote stays in Shelf so the handwriting is not lost.

### Insert pages into a PDF

While reading a PDF, open Shelf and tap **Insert Page…** (PDFs only).

1. Choose **Before** or **After** the page you are on, how many pages
   (1–20), and a background: **Blank**, **Lined** (6, 8 or 10 mm), **Grid**
   or **Dots** (5 or 10 mm), or **Image…** — a PNG or JPEG from the
   device, centred on the page at a **Size** you choose — Full (edge to
   edge), Margin (94%) or Small (86%). Shelf remembers the last five
   templates you used and your size choice, so a template you reach for
   often is one tap away. **Shrink for e-ink** (on by default) re-encodes the
   image for the screen before it goes in — line art becomes 1-bit, anything
   shaded becomes grey, flattened to the 16 greys the screen can actually
   show — which cut a 1.2 MB diagram to 258 KB on a Manta. **Embed as-is** keeps the file untouched
   when you want fidelity over size.
   You write on an inserted template exactly as you write on any PDF page,
   and the eraser only touches your writing: the image is part of the page,
   your ink is not. Keep templates at roughly the screen's own resolution
   (about 1404 × 1872 for a Nomad, 1920 × 2560 for a Manta) — a page-sized
   1-bit PNG costs tens of kilobytes, while a photo costs megabytes on every
   page inserted. Images over 12 MB or 40 megapixels are refused.

   Rule, grid and dot spacing is measured **as it looks on the device**, not
   on the page. The reader shrinks a page to fit the screen — a US Letter page
   displays at about 75% on a Manta — so rules drawn 8 mm apart on the page
   arrive as 6 mm and look tighter than Supernote's own 8 mm template. Shelf
   divides by that fit, drawing them about 10.6 mm apart on a Letter page so
   they measure 8 mm on glass. One consequence: print such a PDF and the rules
   measure the on-page figure, not the on-screen one.
2. Tap **Insert**. When there is handwriting after the insert point, Shelf
   briefly steps out of the PDF into a note (your project's working note, or
   the last note Shelf saw), because PDF handwriting can only be moved while
   the PDF is closed. **When there is nothing to move — the usual case when
   you add a page as you read forward — Shelf stays in the PDF**, rewrites it
   and reloads. If the reader keeps its old page count, Shelf steps out and
   back to force the reload. A progress screen shows each step.
3. **Coming back is quicker.** Your position, count, template, spacing and
   size are remembered, and reopening Shelf while reading a PDF whose pages
   you were just working on goes straight to Insert Page — so a second page
   is two taps. Cancel on that screen stops it doing so.
4. **Your handwriting stays with its pages.** The Supernote stores PDF
   handwriting by page number, so inserting pages would normally leave
   everything after the insert point on the wrong pages. Shelf moves each
   later page's handwriting to its new page number.
5. **Remove Page N…** (on the same screen) takes out the page you are on, but
   **only if Shelf added it** — every page Shelf inserts is stamped inside the
   PDF, and a page without that stamp is refused, so your own pages are safe
   whatever you tap. Shelf asks first, and says so when you wrote on that
   page: the writing goes with the page, and putting the page back does not
   bring the writing back. Handwriting on later pages moves back down.
6. **Undo Last Insert** (on the same screen) removes the added pages and
   moves the handwriting back. If you wrote on the added pages, Shelf asks
   first — that writing goes with them. Undo is refused if the PDF has
   changed since.
7. If anything fails part-way, Shelf puts the PDF and the handwriting back
   as they were and says so.

Inserting a page rewrites the whole PDF, so the file can grow by a few
percent the first time (PDFBox does not preserve the original's compression).

Shelf keeps one backup per PDF (the five most recent, up to 30 days) in its
private storage for undo. Your pins and captured quotes on that PDF are
moved to the new page numbers. Source links **already placed in notes** keep
their old page numbers. Shelf needs a note to step out to: if the PDF has no
project and Shelf has not seen a note yet, open any note and open Shelf there
once. Locked (encrypted) PDFs cannot be changed.

### Send quotes from a computer

Text copied on any machine on the same Wi-Fi can land in the Quotes tab —
no cloud account, no companion app:

1. Enable **Browse & Access** on the Supernote (note the URL it shows).
2. Upload the text as a file named `shelf-quote-<anything>.txt` into the
   device's `INBOX` folder. One command does it:

   ```bash
   curl -F "file=@shelf-quote-note.txt" http://<device-ip>:8089/INBOX
   ```

   Anything that can POST a file works (Windows, Linux, a phone). On a Mac,
   wrap it in a Shortcuts quick action so that selecting text → right-click →
   **Services → Send to Supernote** is the whole flow: a **Run Shell Script**
   action that writes stdin (falling back to `pbpaste`) to
   `shelf-quote-$(date +%Y-%m-%d-%H%M%S).txt` and runs the `curl` above.
3. Open Shelf's **Quotes** tab. Waiting files appear in an **Imported**
   section and are removed from `INBOX` (only after the quotes are safely
   saved; a re-sent filename is never imported twice). Imported quotes place
   onto the current page of **any** note — no source link, since the source
   isn't on the device. A `-YYYY-MM-DD-HHMMSS` filename suffix becomes the
   shown capture date.

### The floating button (optional)

Insert Page has a **FLOATING BUTTON** switch. Turned on, Shelf puts a small
round button over whatever you are reading:

- **Long-press it with a finger** for a menu that says exactly what each row
  will do — *Insert 1 lined 8 mm page after 33*, *Insert image: Cornell.png*,
  *Remove page 34*, *Undo…*, *Open Shelf*, *Hide this button*. A row that
  cannot apply (no PDF open, no template chosen, nothing to undo) says so
  rather than disappearing.
- **A plain tap** opens the same menu. Switch to **Tap inserts** and a single
  tap adds a page straight away.
- **Drag it** anywhere; it remembers where you put it.
- **The pen writes straight through it** — only finger touches count, so it
  will not eat a stroke.
- It is **off by default**, and it disappears when the device restarts the
  plugin host; opening Shelf once brings it back.
- **Hold it for three seconds and it removes itself.** The button is a window
  owned by the plugin host, not by Shelf, so uninstalling or reloading Shelf
  can leave it on screen with nothing left to dismiss it. The long hold is
  handled by the button itself and always works; a long press also removes it
  when there is no Shelf left to answer.

Each action brings the Shelf panel up while it works, so progress and any
error are visible, and the panel closes itself afterwards.

### PDF size limit

**Shelf does not take PDFs over 25 MB**, and warns you about ones over 10 MB.
A PDF that size can't be pinned, quoted or added to a project, and pages
can't be inserted into it.

This is a deliberate line, not a missing feature. Measured on a Manta: a
738 KB PDF gains a page in about 2.5 seconds, while a 38.5 MB, 930-page book
took 34 — and the device's own reader was slow to open that book and slow to
turn its pages before Shelf was involved at all. Between 10 and 25 MB the
Insert Page screen tells you roughly how long the insert will take.

To use a large PDF with Shelf, shrink it on a computer first. Ghostscript
does this well, and re-encoding the page images to grayscale at 150 dpi
matches what the screen can actually show:

```
gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH \
   -sOutputFile=small.pdf big.pdf
```

Scanned books usually shrink by well over half. A text-based PDF will barely
change, because its text was never what made it big.

### Notes on behavior

- **Moving placed text without changing its font** (an OS quirk that
  affects every text-placing plugin, not just Shelf): moving a text box
  with a plain lasso makes the reader re-fit the font to the box when it
  loses focus. To reposition without any font change, lasso the text, tap
  the **edit** option (as if changing bold/size), and drag that tighter
  selection box instead. Shelf sizes its boxes to minimize the effect, but
  the edit-mode move is the only zero-drift way the OS offers.
- Collision-aware placement reads real bounds for the current page's text,
  titles, links, pictures, and handwriting (via the stroke contour data the
  SDK exposes), so quotes land in genuinely clear space rather than a
  rough estimate. It skips scanning pages that are extremely dense and
  caps how much handwriting data it reads per page, falling back to simple
  bottom-up stacking in either case — so it stays within the platform's
  element-cache limits rather than risk stalling on a very busy page.
- Shelf state (projects, pins, quotes, recognized headings) persists on the
  device across restarts. It is private to the plugin install.
- Keywords, stars, and headings are read from notes only — Supernote's
  plugin APIs do not expose them for PDFs/EPUBs.
- The small gray footer shows which file Shelf detected; tap it to
  re-detect. It remains while some PluginHost platform issues are open.
- Shelf requests file access when it needs to browse/open files or build note
  previews. Delete access is requested when importing `shelf-quote-*.txt`
  files because the source is removed only after the quote is safely saved.

## Changes in 0.2.8

- **Insert a page from your own PNG or JPEG.** Background now offers
  **Image…**: pick a template from the device, at a **Size** of Full, Margin
  (94%) or Small (86%). Shelf remembers the last five templates and your size
  choice. You write on the page as you would any PDF page, and the eraser
  only touches your writing — the image is part of the page.
- **Shrink for e-ink** (on by default) re-encodes a template for the screen:
  grayscale, flattened to the 16 greys the device shows, line art as 1-bit.
  A diagram that cost 1197 KB embedded as-is costs about 248 KB this way.
  **Embed as-is** keeps the file exactly as it is.
- **Remove Page N** takes out a page Shelf added. Pages Shelf inserts are
  stamped inside the PDF, and a page without that stamp is refused — your own
  pages cannot be removed however you ask. Handwriting on later pages moves
  back down, and Undo puts the page back (though not writing that was on it).
- **Fixed: choosing Image… jumped straight to the file picker**, so the
  template controls never appeared. Picking the mode and picking the file are
  now separate taps.
- **Fixed: a tap meant for the file picker could start an insert**, because
  the plugin panel can sit above the picker. Insert now ignores a tap for a
  moment after the picker closes.
- **Fixed: the diagnostic log began mid-operation**, losing everything before
  Insert Page asked for file permission.
- **Both halves of the plugin show a build number** on the Insert Page screen
  and in the log, so a stale install is obvious at a glance.

## Changes in 0.2.7

- **PDFs over 25 MB are refused**, with a warning from 10 MB. A 38.5 MB,
  930-page book took 34 seconds to gain a page, and the device's own reader
  was already slow with it. See **PDF size limit** above for how to shrink a
  PDF for the device.
- **Insert Page can work on the SD card.** Choose where Shelf does the heavy
  work and keeps its undo backup: same volume as the PDF (the default), the
  SD card, or internal storage. Free space is shown for each and checked
  before starting.
- **Fixed: Insert Page did nothing on an SD-card PDF.** Shelf's own
  write-check cleanup tripped the plugin host's delete rules and aborted the
  insert with nothing on screen to say why.
- **Fixed: Insert Page could hang** after stepping out to a note, because a
  plugin's timers stop while its panel is hidden.
- **Faster on large PDFs**: the edited file is no longer parsed twice.
- **Browse uses the device's own file picker again** instead of Shelf's
  folder browser, which showed raw Android paths.
- **Insert Page writes a log** to `EXPORT/shelf-log.txt`, which you can
  download with Browse & Access if something goes wrong.

## Changes in 0.2.6

- **Handwritten notes on quotes**: write your own note in real ink on the
  capture screen; it is placed beneath the quote as native strokes.
- **Tap-to-place**: tap the line where a quote should start, on any note.
  A **Placing the quote…** screen shows progress until it is done.
- Quotes place on **any** note, not just the project's working note;
  **Choose a Note…** browses to one from anywhere.
- **Fixed**: quote placement was refused on every page since 0.2.5 ("The
  current page does not allow note content to be inserted"). The check asked
  the firmware about Shelf's own panel rather than the note beneath it.
- **Choose Folder Project…** replaces Make Current Folder a Project: browse
  to any folder, including empty ones and SD cards; SD-card paths are no
  longer rewritten onto internal storage.
- Removed **Place Manually** (tap-to-place covers exact positioning).
- **Insert Page** for PDFs: 1–20 blank or 8 mm lined pages before/after the
  current page, with undo — and your handwriting moves with its pages.

## Changes in 0.2.5

- Updated to `sn-plugin-lib` 0.1.65 and the current lifecycle listener.
- Exact-page opening now works for pinned notes, PDFs, EPUBs, CBZ, XPS, and
  FB2 files; same-file navigation uses the new page-jump API.
- Browse entries explicitly retain the previous last-used-page behavior, while
  **Pin This Page** now means the exact page even when it is page 1.
- Added scoped file permissions and guards against stale refresh/detail results.
- A quote is no longer left in the queue after its text was inserted but its
  optional source link failed, preventing duplicate text on retry.
- Removed Shelf's old plugin-install cleanup workaround now that the current OS
  cleans superseded plugin cache files itself.

## Install

1. Copy `build/outputs/SNShelf.snplg` to the device (Partner app, Browse and Access, or the
   `MyStyle` folder over USB).
2. On the device: toolbar plugin icon → Manage Plugins → Add Plugin.
3. When updating: remove the old plugin and the old `.snplg` first.

## Development

React Native is locked to `0.79.2` to match the Supernote PluginHost
runtime. Standard checks:

```bash
npm install
npm run typecheck
npm run lint
npm run test:coverage
npm run build
npm run validate:package -- --native
```

`npm run build` / `./buildPlugin.sh` need `ANDROID_HOME` set (the native
module must compile — a `.snplg` produced after an "APK build failed" line
is missing `app.npk` and must not be installed; `validate:package --native`
catches this). The build also applies the local Metro watcher patch that
avoids `EMFILE` failures.

### Structure

```text
src/
  app/        events and plugin-button wiring
  screens/    the plugin panel (tabs, grid, detail, capture)
  domain/     project/context model and pure state logic
  services/   thumbnails (generateNotePng cache), note metadata + heading recognition, INBOX quote import
  supernote/  Supernote API adapters (SDK-first navigation, capture, inserts)
  storage/    persisted state (native ShelfStorage JSON) and session wrapper
android/      native modules: folder/fallback navigation, state storage,
              clipboard access, and text measurement
```

Design history: [docs/navigation-direction.md](docs/navigation-direction.md)
records the early shift away from backlink discovery toward the curated
shelf; `docs/` handoffs track iteration decisions.

## Credits

- Bookshelf and quote icons created by
  [Freepik - Flaticon](https://www.flaticon.com/free-icons/furniture-and-household).
- Native text-measurement approach (an Android bridge to `StaticLayout`,
  plus a device-calibrated text-frame inset) adapted from
  [tilmanbergt/textboxHelper](https://github.com/tilmanbergt/textboxHelper).
- PDF page insertion uses
  [PDFBox-Android](https://github.com/TomRoush/PdfBox-Android) (Apache License
  2.0), a port of Apache PDFBox. The approach of editing the PDF with PDFBox
  and reopening it was studied from the
  [InsertPage plugin](https://github.com/dersalbader/supernote-PDF-Insert-page);
  no code was copied.
