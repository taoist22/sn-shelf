# SN Shelf Navigation Direction

SN Shelf is a curated floating reference shelf and navigation stack, not an
automatic backlink scanner.

## Product Model

- Pinned references: user-chosen notes, PDFs, folders, or documents.
- Recent shelf jumps: places opened through SN Shelf.
- Return stack: explicit places SN Shelf records before opening another target.

The return stack should only claim what SN Shelf actually knows. If the current
note/page cannot be detected reliably, use explicit user-driven return targets
instead of pretending to have full browser-style history.

## Implementation Guidance

- Prefer direct Android intents for opening known targets.
- Notes can open through
  `com.ratta.supernote.note/com.ratta.supernote.note.view.NoteInsidePagesActivity`
  with `ACTION_VIEW`, `file_path`, 1-based `page`, and
  `FLAG_ACTIVITY_NEW_TASK`.
- Close the plugin view shortly after launch so the target note comes forward.
- Keep native overlay or bubble work as a later phase unless the main shelf flow
  already works.

## Non-Goals

- Do not build broad backlink discovery.
- Do not scan folders or whole libraries with `PluginFileAPI.getElements`.
- Avoid product-critical link aggregation until Supernote exposes a lightweight
  link metadata API.
