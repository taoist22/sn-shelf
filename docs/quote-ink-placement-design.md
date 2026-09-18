# Quotes with handwritten notes — capture and one-tap placement

**Status: design, awaiting CT's approval. Nothing here is built in Shelf yet.**
Written 2026-09-18, right after `sn-strokeprobe` proved the key step on device.

## Goal

While reading a PDF, capture a passage **and** write your own note about it by hand, on
ruled lines. Later, in any note, place both **together, in one tap**: the quote text, its
link back to the PDF page, and your handwriting underneath as real Supernote ink.

It replaces today's multi-step placement (open the working note, reopen Shelf, Place, or
Place Manually → Paste Text → Mark Placed).

## Proven vs not

| Piece | Status | Evidence |
|---|---|---|
| Capture selected PDF text | shipped in Shelf | `getLastSelectedText` on the text-selection button |
| Handwriting in a plugin panel | shipped in sn-flashcards | firmware pen engine, `InkSurface*` |
| Ink → **real strokes in the open note** | **proven 2026-09-18** | sn-strokeprobe: 16 strokes built, inserted, note saved; CT "everything seemed to work well" |
| Tap-to-place on a note page | shipped in sn-datetime | `PlacementOverlay.tsx` + `tapPlacement.ts` |
| Quote text + source link placement | shipped in Shelf | `insertQuoteIntoCurrentNote` |
| Ruled lines behind the pen engine's ink | **not tested** | first thing to check on device |
| Inserted ink lassoable / erasable / survives reopen | **not explicitly confirmed** | check in the first Shelf test |
| Stroke style on a page with no handwriting yet | **not tested** | `getPenInfo()` is the candidate |

Details of the stroke recipe: plugin-scope memory `reference_plugin_stroke_insertion.md`.

## User flow

**Capture (in a PDF)**
1. Select text → **Capture Quote** (unchanged button).
2. The capture screen shows the quote text (editable, as now) and, below it, a **ruled
   writing area**. Writing is optional.
3. **Save.** Quote text and ink are stored together in Shelf.

**Place (in any note)**
4. Open Shelf. If quotes are waiting, it opens on them.
5. Tap **Place** on a quote → the panel hides → tap the spot on the page.
6. Shelf inserts, top to bottom from the tap: quote text, source link, handwriting. Done.
   The panel closes.

**Place all** (multi-select) keeps today's automatic stacking into clear space, now
counting each quote's ink height.

**Choose a Note…** stays — it is a quick way to get from the PDF to any note.
**Place Manually, Copy Again and Mark Placed are removed**: tap-to-place already gives
exact positioning, which was the only reason for manual paste.

## Ruled writing area

- Lines are a **writing guide in the panel only**. They are never inserted into the note.
- Drawn as the ink host view's own background (a native `Drawable` on the plain `View`
  that the pen engine binds to); the engine draws ink in the view's overlay, above it.
  If the engine repaint covers the background on device, fallback: a line layer drawn in
  RN directly behind a transparent host.
- **Default spacing 8 mm** ≈ 94 px on Nomad and Manta (both ~300 ppi), matching the
  standard 8 mm ruled template, so written lines land at a familiar size on the page.
- **Default height: 6 lines.** Enough for a marginal note without pushing the text field
  off screen.

Both defaults are constants; a setting can come later if they don't suit.

## Data

`ShelfQuote` gains an optional field; old quotes without it are unchanged.

```ts
ink?: {
  version: 1;
  width: number;          // px, bounding box of the ink
  height: number;
  lineSpacingPx: number;  // spacing used while writing, for reference
  strokes: Array<{
    xy: number[];         // [x, y, x, y, …] px, relative to the ink's top-left
    press: number[];      // raw engine pressure (measured 0.001–0.30)
  }>;
};
```

- Raw pressure is stored; mapping to the page's pressure range happens at placement,
  because it depends on the destination page.
- Point cap per quote (starting at 6000) keeps the Shelf state file small. Over the cap,
  saving is refused with a message rather than silently truncating ink.
- `nativeShelfStorage.isShelfQuote` must keep the field through load/save; add a test.

## Placement geometry

From the tap point `(x, y)` in page px:

1. Quote text at `(x, y)` — existing text measurement decides its height.
2. Source link directly below, as now.
3. Ink at `(x, linkBottom + gap)`, strokes translated by that origin, 1:1 scale (engine
   px = page px, measured).
4. If the whole block would run past the page bottom or right edge: **no insert**, a clear
   "doesn't fit here — tap higher or turn the page" message, and the quote stays queued.

Stroke style, in order:
1. Copy from an existing stroke on the page (`getElements`, first type-0) — the proven path.
2. Else `PluginCommAPI.getPenInfo()` for type/colour, with the measured Manta values
   (`thickness=1200`, pressure range 199–1119, `maxX/maxY` from `PointUtils.getRealMaxX/Y`).
3. Pressure: engine range mapped linearly onto the chosen range.

Insert order: text → link → strokes (`insertPageElements`, one call) → `saveCurrentNote`.
The quote leaves the queue only after the strokes insert succeeds; a text-placed-but-ink-
failed result is reported as partial, like the existing link warning.

## Hazards (all from shipped code; each was a bug once)

- **Release the pen engine on every exit**: Save, Cancel, Close, panel stop, host unmount,
  module invalidate. A bound engine behind an unmounted view wedges PluginHost (reboot).
- **The ink host must never move or resize** once bound. The capture screen gets fixed
  heights above the writing area and **must not scroll while the engine is live** —
  Shelf's panel is a ScrollView today, so the capture screen renders outside it.
- **Controls above the writing area**, never below (palm hits them). Finger input off.
- **Fail soft**: if the engine isn't available, the capture screen shows only the text
  field, as now.
- `getElements` on large pages: recycle every element (Error 206 cache warning).
- Titled notes (H elements): not relevant here — strokes are inserted, not modified.

## Build order

1. **Ink capture:** port `StrokeInk*` from sn-strokeprobe into Shelf's native package,
   ruled background, capture screen layout, save ink with the quote. Device check: lines
   visible under the ink, ink saved.
2. **Tap-to-place for one quote** with text + link + ink. Device check: position, ink is
   lassoable/erasable, survives reopen, page with no prior handwriting.
3. **Place all** with ink heights in the stacking.
4. **Remove** Place Manually / Copy Again / Mark Placed.

Each step is committed only after typecheck + tests pass and it is confirmed on device.
