import {PluginCommAPI, PluginDocAPI, PluginFileAPI, PluginManager, PluginNoteAPI, RattaFileSelector} from 'sn-plugin-lib';
import {
  formatPage,
  makeShelfTarget,
  normalizeDevicePath,
  type ShelfKind,
  type ShelfQuote,
  type ShelfTarget,
} from '../domain/shelfItem';
import {
  estimateWrappedLines,
  findPlacementBottom,
} from '../domain/quoteLayout';
import {scanPageObstacles, type ObstacleScan} from './pageObstacles';

type ApiResponse<T> = {
  success?: boolean;
  result?: T;
  error?: {message?: string};
};

function assertResult<T>(res: ApiResponse<T> | null | undefined, label: string): T {
  if (res?.success && res.result !== undefined && res.result !== null) {
    return res.result;
  }
  throw new Error(res?.error?.message ?? `${label} failed`);
}

export async function getCurrentTarget(): Promise<ShelfTarget> {
  const pathRes = (await PluginCommAPI.getCurrentFilePath()) as ApiResponse<string>;
  const pageRes = (await PluginCommAPI.getCurrentPageNum()) as ApiResponse<number>;
  const path = assertResult(pathRes, 'Current file path');
  const page = assertResult(pageRes, 'Current page');
  return makeShelfTarget(path, page);
}

export async function chooseShelfFiles(
  startFolder?: string,
): Promise<ShelfTarget[]> {
  const selected = (await RattaFileSelector.selectFile({
    selectType: 0, // 0 = normal (multi) selection; 1 = single-file mode
    maxNum: 9,
    title: 'Add to Shelf',
    rightButtonText: 'Add',
    // Start in the project's folder; without limitPath the user can still
    // navigate anywhere on the device.
    ...(startFolder ? {needSelectFolder: startFolder} : {}),
  })) as string[] | null | undefined;
  return (selected ?? [])
    .filter(path => typeof path === 'string' && path.length > 0)
    .map(path => makeShelfTarget(path, 0));
}

function linkTypeForKind(kind: ShelfKind): number {
  if (kind === 'note') {
    return 0;
  }
  if (kind === 'pdf' || kind === 'epub' || kind === 'document') {
    return 2;
  }
  return 1;
}

function linkTypeForTarget(target: ShelfTarget): number {
  return linkTypeForKind(target.kind);
}

function estimateLinkWidth(label: string, maxWidth: number): number {
  const estimated = Math.ceil(label.length * 17) + 48;
  return Math.max(300, Math.min(maxWidth, estimated));
}

/** Reads the text the user last selected in the open PDF/EPUB/document. */
export async function readSelectedText(): Promise<string> {
  const res = (await PluginDocAPI.getLastSelectedText()) as ApiResponse<string>;
  if (!res?.success) {
    throw new Error(res?.error?.message ?? 'Could not read selected text');
  }
  return (res.result ?? '').trim();
}

async function deviceWidth(): Promise<number> {
  const deviceType = (await PluginManager.getDeviceType()) as unknown;
  return Number(deviceType) === 5 ? 1920 : 1404;
}

// Bottom-up (LIFO) placement: quotes anchor near the page bottom and each
// successive placement on the same page stacks upward, avoiding collisions
// with content at the top. Session-scoped; resets when PluginHost restarts.
const placementCursors = new Map<string, number>();

// One obstacle scan per page per session (null = scan unavailable, use the
// blind cursor). Placed quotes are appended so batches stack correctly; ink
// added mid-session is missed, same staleness the cursor already accepts.
const obstacleScans = new Map<string, ObstacleScan | null>();

// Placement font and its metrics, calibrated from a device probe
// (2026-07-07): after an edit-mode move the reader rewrites the rect to its
// true text bounds — 315 chars wrapped to 8 lines in 960×313 at fontSize 30,
// giving lineHeight ≈ 1.31×fontSize and average char ≈ 0.5×fontSize (both
// ratios confirmed at fontSize 38). 36 is the native text tool's minimum
// size, so placing at 36 keeps the lasso re-fit from ever scaling up to it.
const QUOTE_FONT_SIZE = 36;
const CHAR_PX = Math.round(QUOTE_FONT_SIZE * 0.5); // 18
const LINE_PX = Math.round(QUOTE_FONT_SIZE * 1.32); // 48

export type PlaceQuoteOptions = {
  /** Insert the italic source jump-link beneath the quote. Default true;
   * quotes without an on-device source never get one regardless. */
  includeLink?: boolean;
  /** Skip the per-quote save — batch callers save once at the end. */
  skipSave?: boolean;
  /** Report 'page-full' instead of clamping into content at the page top. */
  strictFit?: boolean;
};

/**
 * Places a quote on the CURRENT note page: an editable text box with the
 * quote, optionally followed by a jump link back to the source. Inserts are
 * sequential — parallel insert calls freeze the device (see sn-query notes).
 */
export async function insertQuoteIntoCurrentNote(
  quote: ShelfQuote,
  options: PlaceQuoteOptions = {},
): Promise<'placed' | 'page-full'> {
  const current = await getCurrentTarget();
  if (current.kind !== 'note') {
    throw new Error(
      quote.sourcePath.length > 0
        ? 'Open the working note page before placing a quote.'
        : 'Open a note page before placing an imported quote.',
    );
  }

  const sizeRes = (await PluginFileAPI.getPageSize(
    current.path,
    current.page,
  )) as ApiResponse<{width: number; height: number}>;
  const width = sizeRes?.success && sizeRes.result ? sizeRes.result.width : await deviceWidth();
  const height =
    sizeRes?.success && sizeRes.result
      ? sizeRes.result.height
      : width >= 1920
        ? 2560
        : 1872;

  // Half-page column, anchored left: the right half stays free for
  // handwriting around the quote and the collision surface halves.
  const left = 180;
  const textWidth = Math.round(width / 2);
  const charsPerLine = Math.max(8, Math.floor(textWidth / CHAR_PX));
  const lines = estimateWrappedLines(quote.text, charsPerLine);
  // Near-tight frame: the reader re-fits the font to FILL the frame on a
  // plain lasso move (probe-confirmed), so every pixel of slack becomes
  // font growth. Small padding only; no safety line.
  const textHeight = Math.min(1400, lines * LINE_PX + 16);

  // Imported quotes (empty sourcePath) have no on-device source, so no
  // jump link is placed beneath them; project quotes can opt out.
  const withLink =
    quote.sourcePath.length > 0 && options.includeLink !== false;

  const linkHeight = 64;
  const gap = 12;
  const blockHeight = textHeight + (withLink ? gap + linkHeight : 0);
  const cursorKey = `${current.path}#${current.page}`;

  // Collision-aware placement when a page scan is affordable; blind
  // bottom-up cursor otherwise. The scan runs once per page per session.
  let scan = obstacleScans.get(cursorKey);
  if (scan === undefined) {
    scan = await scanPageObstacles(current.path, current.page, {
      width,
      height,
    });
    obstacleScans.set(cursorKey, scan);
  }

  let linkBottom: number;
  if (scan) {
    const found = findPlacementBottom({
      obstacles: scan.rects,
      inkBottom: scan.inkBottom,
      boxLeft: left,
      boxRight: left + textWidth,
      boxHeight: blockHeight,
      startBottom: height - 160,
      topLimit: 120,
      gap: 24,
    });
    if (found === null) {
      // Never place on top of existing content when we can see it.
      return 'page-full';
    }
    linkBottom = found;
  } else {
    const bottomLimit = placementCursors.get(cursorKey) ?? height - 160;
    if (options.strictFit && bottomLimit - blockHeight < 120) {
      return 'page-full';
    }
    linkBottom = bottomLimit;
  }

  const linkTop = withLink ? linkBottom - linkHeight : linkBottom;
  const textBottom = withLink ? linkTop - gap : linkBottom;
  const textTop = Math.max(120, textBottom - textHeight);

  const textRes = (await PluginNoteAPI.insertText({
    textContentFull: quote.text,
    textRect: {left, top: textTop, right: left + textWidth, bottom: textBottom},
    fontSize: QUOTE_FONT_SIZE,
    textAlign: 0,
    textBold: 0,
    textItalics: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    textEditable: 0,
  } as any)) as ApiResponse<boolean>;
  if (!textRes?.success) {
    throw new Error(textRes?.error?.message ?? 'Could not insert quote text');
  }

  if (withLink) {
    const label = `— ${quote.sourceTitle}, ${formatPage(quote.sourcePage)}`;
    const linkWidth = estimateLinkWidth(label, textWidth);
    const linkRes = (await PluginNoteAPI.insertTextLink({
      category: 0,
      linkType: linkTypeForKind(quote.sourceKind),
      destPath: normalizeDevicePath(quote.sourcePath),
      destPage: Math.max(0, quote.sourcePage),
      style: 0,
      rect: {left, top: linkTop, right: left + linkWidth, bottom: linkBottom},
      fontSize: 28,
      fullText: label,
      showText: label,
      isItalic: 1,
    } as any)) as ApiResponse<number>;
    if (!linkRes?.success) {
      throw new Error(
        linkRes?.error?.message ??
          'Quote placed, but the source link could not be inserted',
      );
    }
  }

  // Record the placed block so later placements (and batches) stack above
  // it; the cursor stays maintained for the scanless fallback path.
  if (scan) {
    scan.rects.push({
      left,
      top: textTop,
      right: left + textWidth,
      bottom: linkBottom,
    });
  }
  placementCursors.set(cursorKey, textTop - 24);

  if (!options.skipSave) {
    await saveCurrentNoteQuietly();
  }
  return 'placed';
}

/** Best-effort save; the visible elements usually exist immediately. */
export async function saveCurrentNoteQuietly(): Promise<void> {
  try {
    await PluginNoteAPI.saveCurrentNote();
  } catch {
    // Best effort.
  }
}

export async function insertShelfLink(target: ShelfTarget): Promise<void> {
  const current = await getCurrentTarget();
  if (current.kind !== 'note') {
    throw new Error('Open a note page before placing a jump link.');
  }

  const pageWidth = await deviceWidth();
  const label = `SN Shelf: ${target.title} (${formatPage(target.page)})`;
  const width = estimateLinkWidth(label, pageWidth - 440);
  const left = 220;
  const top = 220;
  const height = 72;
  const linkType = linkTypeForTarget(target);

  const res = (await PluginNoteAPI.insertTextLink({
    category: 0,
    linkType,
    destPath: normalizeDevicePath(target.path),
    destPage: Math.max(0, target.page),
    style: 0,
    rect: {left, top, right: left + width, bottom: top + height},
    fontSize: 30,
    fullText: label,
    showText: label,
    isItalic: 0,
  } as any)) as ApiResponse<number>;

  if (!res?.success) {
    throw new Error(res?.error?.message ?? 'Could not place jump link');
  }

  try {
    await PluginNoteAPI.saveCurrentNote();
  } catch {
    // The visible link usually exists immediately; save is best-effort here.
  }
}
