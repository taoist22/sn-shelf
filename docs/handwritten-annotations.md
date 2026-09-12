# Handwritten annotations on captured quotes — design note

**Status: not started, not committed to.** Written 2026-09-11 while the reasoning was
fresh. Deferred because it is a lot of assembly for a small user-visible change; revisit
when there is a reason to.

## The idea

Reading a PDF: select a passage, capture it into Shelf as a quote, then write your own
note about it **by hand, in real ink**, inside the plugin. The annotation lives with the
quote in Shelf until you choose to place it on a page.

The point of ink rather than the handwriting IME is that reading notes are scrappy —
arrows, underlines, a circled word, symbols, mixed scripts. Recognition turns all of that
into approximate text and loses what made it useful. For anything that is really just
prose, the IME already works and is far simpler; this is only worth it for marginalia.

## Why this is now possible

Shelf's own notes said "plugin panels get no access to the native low-latency ink path".
That is false as of 2026-09-11. A plugin can drive the firmware pen engine directly and
get real firmware-rasterised ink at full panel size. See
`~/supernote-plugins/references/firmware-pen-engine-einkpwinterface.md`.

The RN-canvas verdict still stands — that route really is dead. The ceiling was simply not
where we thought.

## Every piece already exists in shipped code

| Step | Mechanism | Where it is proven |
|---|---|---|
| Select text in a PDF | `PluginDocAPI.getLastSelectedText()`, DOC text-selection button | **Shelf**, shipped |
| Write a note by hand | firmware pen engine on a ViewManager-hosted plain `View` | **sn-flashcards v0.4.0-beta**, shipped |
| Keep the note | `saveBitmapAndWaitDone` writes a sibling `.png` | byte-verified on device |
| Show it in Shelf | `<Image source={{uri: 'file://…'}}>` | standard; used in flashcards |
| Place it on a page | `PluginNoteAPI.insertImage(pngPath)` | **sn-frameclip**, shipped |

Nothing needs research first. This is assembly, which is exactly why it is also more work
than it sounds.

## The part that is not a copy-paste: placement

`insertImage(pngPath)` takes **only a path**. There is nowhere to pass a position, which is
why FrameClip inserts and immediately closes rather than placing anything. So the
tap-to-place overlay does **not** drop in the way it did for `insertText`.

What transfers: `sn-datetime/src/PlacementOverlay.tsx` + `src/tapPlacement.ts` — gesture
capture, pen-tap discrimination, cancel-as-outcome, dp→page-pixel conversion. All of that
is insert-agnostic. Copy rather than rewrite (see the `reference_tap_to_place` memory).

What does not: the insert itself. Likely completion is two-step —

1. `insertImage(pngPath)`
2. locate the new Picture element and write its `rect` via `modifyElements`

Picture rects *can* be written directly, bypassing the proportional-resize rule, and
Pictures are among the easiest elements to reshape programmatically because their geometry
is a rect rather than point data.

`insertPageElements(elements, page, layer)` might take a picture element with a rect in one
call and skip the two-step entirely. **Shape unknown — not used anywhere in the workspace.**
Worth five minutes before building the two-step.

## Known hazards

- **Never call `setLassoBoxState` before `modifyElements`.** Corrupts position *and* scale,
  position-dependently. Do not manage lasso state inside the sequence at all.
- **`modifyElements` still corrupts positions on notes containing H elements** (titled
  notes, `TYPE_TITLE = 100`) even with that removed. Simple, keyworded and starred notes
  are fine. Open bug from sn-restyle — an annotation placed on a titled note may land wrong.
- **The pen engine must be released on every close path** or PluginHost wedges and the
  device needs a reboot. See the reference file's "Building a real writing surface" section
  — the host must also never move or resize while the engine is bound.
- **PNG annotations cannot be edited afterwards**, only replaced — the same compromise
  flashcards made for handwritten card sides. Storing `.tch` instead would keep them
  editable, but the `.tch` reload path is the one thing from 2026-09-11 that was never
  verified correctly (`getAvailableUndo` is undo depth, not stroke count — use
  `getAvailableRepaintStep`).

## Also worth deciding before building

Shelf's placement machinery — collision avoidance via `contoursSrc`, native text
measurement, ladder steps — was all built for **text** via `insertText`. None of it applies
to an image. A placed annotation would land where the tap says and nothing would stop it
covering existing ink, which is a visible step down from how quotes are placed today.

That, more than the API work, is the reason this is not a small change.
