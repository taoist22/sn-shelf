# Shelf

A study-session navigator for Supernote e-ink devices. Shelf keeps each
project's working note and its reference materials one tap apart: pin notes,
PDFs, and EPUBs to a per-project reference shelf, jump between them, capture
quotes from your reading, and place those quotes into your working note with
a link back to the source.

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
  until you place it into the working note.

## Using Shelf

### Set up a project

Open the note you write in (or any file in a class folder), open Shelf from
the toolbar, go to the **Projects** tab, and tap **Make Current Note a
Project** or **Make Current Folder a Project**. For folder projects, open a
note inside the folder and designate it via **Make This the Working Note**
(later changeable by long-pressing any pinned note's card → **Set as Working
Note**).

### Pin references

Pins land on the shelf you are looking at:

- **Pin This Page** — pins the current file. Pinning mid-note remembers the
  exact page; pinning a first page (or adding via Browse) opens at the
  note's last-used page instead.
- **Browse** — multi-select file picker (up to 9 at once), starting inside
  the project's folder but free to navigate anywhere.
- Pins made outside any project land on the **General Shelf** and can be
  moved into a project later (long-press → **Move**).

### Navigate

- **Tap a card** to open it — notes in the editor, PDFs/EPUBs in the
  document viewer (at their last-used page; Supernote's viewer does not
  support page jumps).
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
2. Edit the captured text if needed and save. Captures from a project's
   materials file automatically; captures from unaffiliated files ask which
   project to save to.
3. The **Quotes** tab (with a live count in its label) lists waiting quotes
   by project. In the working note, **Place on This Page** inserts the quote
   as an editable text box with an italic source link beneath it — tapping
   the link jumps back to the source. Quotes stack bottom-up on the page to
   avoid colliding with your writing. Elsewhere, the button takes you to the
   working note first.

### Notes on behavior

- Shelf state (projects, pins, quotes, recognized headings) persists on the
  device across restarts. It is private to the plugin install.
- Keywords, stars, and headings are read from notes only — Supernote's
  plugin APIs do not expose them for PDFs/EPUBs.
- The small gray footer shows which file Shelf detected; tap it to
  re-detect. It remains while some PluginHost platform issues are open.
- On load, Shelf cleans up stale plugin-version artifacts that PluginHost
  leaves behind on every install/update (a known platform bug that otherwise
  grows storage without bound).

## Install

1. Copy `build/outputs/SNShelf.snplg` to the device (Partner app, or the
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
  services/   thumbnails (generateNotePng cache), note metadata + heading recognition
  supernote/  Supernote API adapters (navigation intents, capture, inserts)
  storage/    persisted state (native ShelfStorage JSON) and session wrapper
android/      native modules: ShelfNavigation (open intents), ShelfStorage
              (state file + PluginHost version cleanup)
```

Design history: [docs/navigation-direction.md](docs/navigation-direction.md)
records the early shift away from backlink discovery toward the curated
shelf; `docs/` handoffs track iteration decisions.

## Credits

- Bookshelf icon created by
  [Freepik - Flaticon](https://www.flaticon.com/free-icons/furniture-and-household).
