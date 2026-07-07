# SN Shelf

Curated shelf for quickly jumping between active Supernote notes and reference pages.

## Prototype Scope

This first prototype tests the navigation workflow before adding durable storage:

- **Add Current Page** records the current file path and page number.
- **Choose File** adds a note/document through Supernote's file picker.
- **Open** records the current file/page as the Return target, then opens a `.note`
  file directly through Supernote's exported Android note activity.
- **Return** opens the last recorded working note/page through the same direct path.
- **Link** keeps the earlier fallback of placing a native Supernote jump link on the
  current note page.
- Shelf state is in-session only; it survives closing/reopening the plugin panel while
  PluginHost remains alive, but it is not yet persisted across device restarts.

Design note: [docs/navigation-direction.md](docs/navigation-direction.md) records the
shift away from broad backlink discovery and toward a curated reference shelf with an
explicit return stack.

## Standard Workflow

Use the same checks for every new Supernote plugin:

```bash
npm install
npm run typecheck
npm run lint
npm run test:coverage
npm run build
npm run validate:package
```

React Native is locked to `0.79.2` because it must match the Supernote PluginHost runtime.

`npm run build` and `./buildPlugin.sh` automatically apply the local Metro watcher patch used in this workspace to avoid recurring `EMFILE: too many open files, watch` failures during one-shot bundle builds.

## Structure

```text
src/
  app/        app composition and high-level wiring
  screens/    visible plugin screens
  domain/     plugin-specific business logic
  services/   integrations and side-effect wrappers
  supernote/  Supernote API adapters
  storage/    persistence adapters
  utils/      small pure helpers
```

Tiny plugins do not need to fill every folder. Prefer the smallest structure that keeps UI, logic, and device integration easy to find.

## Package Validation

After every build, run:

```bash
npm run validate:package
```

For native-backed plugins, use:

```bash
npm run validate:package -- --native
```

This catches the known failure mode where a `.snplg` is produced but the native package is missing.

## Credits

- Bookshelf icon created by [Freepik - Flaticon](https://www.flaticon.com/free-icons/furniture-and-household).
