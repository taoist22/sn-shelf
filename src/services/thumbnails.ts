import {FileUtils, NativePluginManager, PluginFileAPI} from 'sn-plugin-lib';
import type {ShelfTarget} from '../domain/shelfItem';

type ApiResponse<T> = {
  success?: boolean;
  result?: T;
  error?: {message?: string};
};

/** Session-scoped revision per thumb so a refresh produces a new file name
 * (and therefore a new Image URI — RN caches file:// sources by URI). */
const revisions = new Map<string, number>();
const inFlight = new Map<string, Promise<string | null>>();

let dirPromise: Promise<string | null> | null = null;

async function thumbsDir(): Promise<string | null> {
  if (!dirPromise) {
    dirPromise = (async () => {
      // Slow call — cache for the whole session (see api-quick-ref §1b).
      const base = await NativePluginManager.getPluginDirPath();
      if (!base) {
        return null;
      }
      const dir = `${base}/thumbs`;
      const exists = await FileUtils.exists(dir);
      if (!exists) {
        await FileUtils.makeDir(dir);
      }
      return dir;
    })().catch(() => null);
  }
  return dirPromise;
}

function thumbKey(target: ShelfTarget): string {
  // djb2 over path; page keeps per-page pins distinct.
  let hash = 5381;
  for (let i = 0; i < target.path.length; i++) {
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) + hash + target.path.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(16)}_p${target.page}`;
}

function thumbFile(dir: string, key: string): string {
  const rev = revisions.get(key) ?? 0;
  return `${dir}/${key}_r${rev}.png`;
}

/**
 * Returns a file path to a rendered page thumbnail for a note target,
 * generating it on first request. Returns null for documents (no page-render
 * API for PDF/EPUB) and on any failure — callers show a glyph card instead.
 */
export async function ensureThumbnail(
  target: ShelfTarget,
): Promise<string | null> {
  if (target.kind !== 'note') {
    return null;
  }
  const key = thumbKey(target);
  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }

  const task = (async () => {
    const dir = await thumbsDir();
    if (!dir) {
      return null;
    }
    const pngPath = thumbFile(dir, key);
    if (await FileUtils.exists(pngPath)) {
      return pngPath;
    }
    const res = (await PluginFileAPI.generateNotePng({
      notePath: target.path,
      page: target.page,
      times: 1,
      pngPath,
      type: 1, // white background — matches the e-ink panel
    })) as ApiResponse<boolean>;
    if (!res?.success || !res.result) {
      return null;
    }
    return pngPath;
  })().catch(() => null);

  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

/** Deletes the cached thumbnail and renders a fresh one under a new name. */
export async function refreshThumbnail(
  target: ShelfTarget,
): Promise<string | null> {
  if (target.kind !== 'note') {
    return null;
  }
  const key = thumbKey(target);
  const dir = await thumbsDir();
  if (dir) {
    const stale = thumbFile(dir, key);
    try {
      await FileUtils.deleteFile(stale);
    } catch {
      // Best effort; the revision bump makes the old file irrelevant anyway.
    }
  }
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  return ensureThumbnail(target);
}
