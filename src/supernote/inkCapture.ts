import {
  NativeModules,
  requireNativeComponent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {inkFromEngine, type InkFromEngine} from '../domain/quoteInk';

// Bridge to ShelfInkModule / ShelfInkViewManager (the firmware pen engine on
// the quote-capture screen). Everything fails soft: without the module or the
// engine, the capture screen just has no writing area.

type ShelfInkBridge = {
  isAvailable(): Promise<boolean>;
  activate(): Promise<string>;
  clear(): Promise<string>;
  refreshRegion(): Promise<string>;
  deactivate(): Promise<string>;
  readStrokes(): Promise<{strokeCount: number; strokes: number[][]}>;
};

const ShelfInk = NativeModules.ShelfInk as ShelfInkBridge | undefined;

/** Recorded with each note; guide lines themselves are a later step. */
export const INK_LINE_SPACING_PX = 94;

/** Host for the pen engine; give it a FIXED size and position. */
export const ShelfInkSurface = requireNativeComponent<{
  style?: StyleProp<ViewStyle>;
}>('ShelfInkSurface');

export async function isInkAvailable(): Promise<boolean> {
  try {
    return Boolean(ShelfInk && (await ShelfInk.isAvailable()));
  } catch {
    return false;
  }
}

/**
 * Binds the engine and reports the native result: 'active' on success, else
 * the reason ('no-surface', 'no-engine', 'enable-failed', 'not-laid-out',
 * 'no-module', or an error message) — shown on screen, never swallowed.
 *
 * Releases any previous engine first (sn-flashcards: re-binding a reused
 * instance kept a stale writable region). Only call this once the screen has
 * finished drawing — i.e. from a user tap, never on mount.
 */
export async function activateInk(): Promise<string> {
  if (!ShelfInk) {
    return 'no-module';
  }
  try {
    await ShelfInk.deactivate();
  } catch {
    // nothing bound — fine
  }
  let state = 'not-laid-out';
  for (let attempt = 0; attempt < 12 && state === 'not-laid-out'; attempt++) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    try {
      state = await ShelfInk.activate();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return state;
}

/** After the window may have shifted (keyboard): re-read the host, keep the ink. */
export async function refreshInkRegion(): Promise<void> {
  try {
    await ShelfInk?.refreshRegion();
  } catch {
    // best effort
  }
}

export async function clearInk(): Promise<void> {
  try {
    await ShelfInk?.clear();
  } catch {
    // best effort
  }
}

/** Every exit from the capture screen must come through here. */
export async function releaseInk(): Promise<void> {
  try {
    await ShelfInk?.deactivate();
  } catch {
    // best effort — the view manager also releases on unmount
  }
}

export async function readInk(): Promise<InkFromEngine> {
  if (!ShelfInk) {
    return {kind: 'empty'};
  }
  const result = await ShelfInk.readStrokes();
  return inkFromEngine(result.strokes ?? [], INK_LINE_SPACING_PX);
}
