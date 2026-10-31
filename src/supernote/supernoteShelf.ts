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
  largestClearBand,
} from '../domain/quoteLayout';
import {scanPageObstacles, type ObstacleScan} from './pageObstacles';
import {insertInkStrokes, invalidateStrokeStyles} from './inkStrokes';
import {inkScale} from '../domain/quoteInk';
import {isImageFile} from '../domain/pdfInsertion';
import {measurePlacedText} from './textMetrics';
import {ensureFileReadPermission} from './pluginPermissions';

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

export async function chooseShelfFiles(): Promise<ShelfTarget[]> {
  if (!(await ensureFileReadPermission())) {
    throw new Error('File access was not allowed.');
  }
  // Opens at the picker's own starting point. Starting it in a project folder
  // (needSelectFolder) made Up leave the picker instead of moving up a folder
  // (device report, 2026-09-19).
  const selected = (await RattaFileSelector.selectFile({
    selectType: 0, // 0 = normal (multi) selection; 1 = single-file mode
    maxNum: 9,
    title: 'Add to Shelf',
    rightButtonText: 'Add',
  })) as string[] | null | undefined;
  return (selected ?? [])
    .filter(path => typeof path === 'string' && path.length > 0)
    .map(path => makeShelfTarget(path, 0, true));
}

/**
 * Picks ONE image with the device's own file picker, for an Insert Page template.
 * The picker has no type filter, so a wrong pick is caught here rather than in
 * PDFBox. Returns null when the user backs out.
 */
export async function chooseTemplateImage(): Promise<string | null> {
  if (!(await ensureFileReadPermission())) {
    throw new Error('File access was not allowed.');
  }
  const selected = (await RattaFileSelector.selectFile({
    selectType: 0, // 0 = normal selection; 1 opens the file and never resolves
    maxNum: 1,
    title: 'Choose a template image',
    rightButtonText: 'Use',
  })) as string[] | null | undefined;
  const path = (selected ?? []).find(
    entry => typeof entry === 'string' && entry.length > 0,
  );
  if (!path) {
    return null;
  }
  if (!isImageFile(path)) {
    throw new Error('That is not a PNG or JPEG. Choose an image file.');
  }
  return path;
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

// One obstacle scan per page per PANEL OPEN (null = scan unavailable, use
// the blind cursor). Placed quotes are appended so batches stack correctly.
// The screen invalidates this when the panel reopens so ink written between
// visits is seen by the next placement.
const obstacleScans = new Map<string, ObstacleScan | null>();

/** Called when the panel reopens: the user may have written on the page. */
export function invalidateObstacleScans(): void {
  obstacleScans.clear();
  invalidateStrokeStyles();
}

// Placement font and its metrics, calibrated from a device probe
// (2026-07-07): after an edit-mode move the reader rewrites the rect to its
// true text bounds — 315 chars wrapped to 8 lines in 960×313 at fontSize 30,
// giving lineHeight ≈ 1.31×fontSize and average char ≈ 0.5×fontSize (both
// ratios confirmed at fontSize 38). 36 is the native text tool's minimum
// size, so placing at 36 keeps the lasso re-fit from ever scaling up to it.
const QUOTE_FONT_SIZE = 36;
const CHAR_PX = Math.round(QUOTE_FONT_SIZE * 0.5); // 18
const LINE_PX = Math.round(QUOTE_FONT_SIZE * 1.32); // 48
// Box top → first baseline, as a multiple of font size (sn-datetime calibration).
const BASELINE_OFFSET_RATIO = 2.05;

export type PlaceQuoteResult =
  | {
      status: 'placed';
      warning?: string;
      /** The text went in but the handwriting did not: the caller must keep
       * the quote, since Shelf holds the only copy of that ink. */
      inkFailed?: boolean;
    }
  | {status: 'no-room-here'}
  | {
      status: 'page-full';
      /** How tall this quote is, in text lines. */
      neededLines: number;
      /** The largest clear run in the column, in text lines. */
      availableLines: number;
    };

export type PlaceQuoteOptions = {
  /** Insert the italic source jump-link beneath the quote. Default true;
   * quotes without an on-device source never get one regardless. */
  includeLink?: boolean;
  /** Skip the per-quote save — batch callers save once at the end. */
  skipSave?: boolean;
  /** Report 'page-full' instead of clamping into content at the page top. */
  strictFit?: boolean;
  /** Tap-to-place: top-left of the block in page px. Skips auto-stacking;
   * a block that would run off the page reports 'no-room-here'. */
  at?: {x: number; y: number};
  /** Progress text for the "placing" screen — writing ink takes seconds. */
  onProgress?: (message: string) => void;
};

/**
 * Places a quote on the CURRENT note page: an editable text box with the
 * quote, optionally followed by a jump link back to the source. Inserts are
 * sequential — parallel insert calls freeze the device (see sn-query notes).
 */
export async function insertQuoteIntoCurrentNote(
  quote: ShelfQuote,
  options: PlaceQuoteOptions = {},
): Promise<PlaceQuoteResult> {
  const current = await getCurrentTarget();
  if (current.kind !== 'note') {
    throw new Error(
      'Open a note page before placing a quote.',
    );
  }
  // No canHandwrite() check: while the Shelf panel is open, the firmware
  // answers for the PANEL (never writable), not the note beneath it, so the
  // check refused every placement from v0.2.5 on. sn-datetime hit the same
  // trap (DateTimePicker.tsx). The note-kind check above is the real guard.

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
  // Exact wrap count from the platform's own text layout when the native
  // module is available (its line HEIGHT differs from the reader's, so we
  // pair its lineCount with our probe-calibrated LINE_PX); word-wrap
  // estimate otherwise. The reader re-fits the font to FILL the frame on a
  // plain lasso move, so slack grows the font and under-sizing shrinks it.
  const measured = await measurePlacedText(
    quote.text,
    textWidth,
    QUOTE_FONT_SIZE,
  );
  const charsPerLine = Math.max(8, Math.floor(textWidth / CHAR_PX));
  const lines = measured?.lineCount ?? estimateWrappedLines(quote.text, charsPerLine);
  const textHeight = Math.min(1400, lines * LINE_PX + (measured ? 8 : 16));

  // Imported quotes (empty sourcePath) have no on-device source, so no
  // jump link is placed beneath them; project quotes can opt out.
  const withLink =
    quote.sourcePath.length > 0 && options.includeLink !== false;

  const linkHeight = 64;
  const gap = 12;
  const inkGap = 24;
  const margin = 40;
  const ink = quote.ink;
  const inkScaleValue = ink ? inkScale(ink, width - left - margin) : 1;
  const inkHeight = ink ? Math.round(ink.height * inkScaleValue) : 0;
  const inkWidth = ink ? Math.round(ink.width * inkScaleValue) : 0;
  const textBlockHeight = textHeight + (withLink ? gap + linkHeight : 0);
  const blockHeight = textBlockHeight + (ink ? inkGap + inkHeight : 0);
  const blockWidth = Math.max(textWidth, inkWidth);
  const cursorKey = `${current.path}#${current.page}`;

  if (options.at) {
    // The tap marks where the quote starts: x is the block's left edge
    // (nudged left only if the block would run off the right edge), and the
    // quote's FIRST BASELINE lands on the tapped line. insertText puts the
    // baseline ~2.05×fontSize below the box top (calibrated in sn-datetime,
    // see reference_inserttext_vertical_geometry), so the box starts above
    // the tap. No stacking or collision checks: the user chose the spot.
    const tapLeft = Math.round(
      Math.max(margin, Math.min(options.at.x, width - margin - blockWidth)),
    );
    const tapTop = Math.round(
      Math.max(margin, options.at.y - QUOTE_FONT_SIZE * BASELINE_OFFSET_RATIO),
    );
    if (tapTop + blockHeight > height - margin) {
      return {status: 'no-room-here'};
    }
    return insertBlock(quote, {
      notePath: current.path,
      page: current.page,
      pageSize: {width, height},
      left: tapLeft,
      textTop: tapTop,
      textWidth,
      textHeight,
      withLink,
      linkHeight,
      gap,
      inkGap,
      inkScale: inkScaleValue,
      skipSave: options.skipSave,
      cursorKey,
      scan: obstacleScans.get(cursorKey) ?? null,
      onProgress: options.onProgress,
    });
  }

  // Collision-aware placement when a page scan is affordable; blind
  // bottom-up cursor otherwise. The scan runs once per page per session.
  let scan = obstacleScans.get(cursorKey);
  if (scan === undefined) {
    scan = await scanPageObstacles(current.path, current.page);
    obstacleScans.set(cursorKey, scan);
  }

  let linkBottom: number;
  if (scan) {
    const found = findPlacementBottom({
      obstacles: scan.rects,
      inkBottom: 0, // strokes are rect obstacles now (contoursSrc bounds)
      boxLeft: left,
      boxRight: left + blockWidth,
      boxHeight: blockHeight,
      startBottom: height - 140,
      topLimit: 120,
      gap: 16,
    });
    if (found === null) {
      // Never place on top of existing content when we can see it — but
      // tell the user how big the quote is vs the room that exists.
      const band = largestClearBand({
        obstacles: scan.rects,
        boxLeft: left,
        boxRight: left + blockWidth,
        startBottom: height - 140,
        topLimit: 120,
      });
      return {
        status: 'page-full',
        neededLines: Math.ceil(blockHeight / LINE_PX),
        availableLines: Math.max(0, Math.floor(band / LINE_PX)),
      };
    }
    linkBottom = found;
  } else {
    const bottomLimit = placementCursors.get(cursorKey) ?? height - 160;
    if (options.strictFit && bottomLimit - blockHeight < 120) {
      return {
        status: 'page-full',
        neededLines: Math.ceil(blockHeight / LINE_PX),
        availableLines: Math.max(0, Math.floor((bottomLimit - 120) / LINE_PX)),
      };
    }
    linkBottom = bottomLimit;
  }

  // The found bottom is the bottom of the whole block (text, link, ink).
  const textTop = Math.max(120, linkBottom - blockHeight);
  return insertBlock(quote, {
    notePath: current.path,
    page: current.page,
    pageSize: {width, height},
    left,
    textTop,
    textWidth,
    textHeight,
    withLink,
    linkHeight,
    gap,
    inkGap,
    inkScale: inkScaleValue,
    skipSave: options.skipSave,
    cursorKey,
    scan,
    onProgress: options.onProgress,
  });
}

type BlockLayout = {
  notePath: string;
  page: number;
  pageSize: {width: number; height: number};
  left: number;
  textTop: number;
  textWidth: number;
  textHeight: number;
  withLink: boolean;
  linkHeight: number;
  gap: number;
  inkGap: number;
  inkScale: number;
  skipSave?: boolean;
  cursorKey: string;
  scan: ObstacleScan | null;
  onProgress?: (message: string) => void;
};

/**
 * Inserts, top to bottom: the quote text, its source link, its handwriting.
 * Sequential — parallel insert calls freeze the device.
 */
async function insertBlock(quote: ShelfQuote, layout: BlockLayout): Promise<PlaceQuoteResult> {
  const {left, textTop, textWidth, textHeight, withLink, linkHeight, gap} = layout;
  const textBottom = textTop + textHeight;
  const linkTop = textBottom + gap;
  const linkBottom = withLink ? linkTop + linkHeight : textBottom;

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

  const warnings: string[] = [];
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
      // The editable quote already exists. Report the partial result as
      // placed so callers remove it from the queue instead of duplicating
      // the text on retry.
      warnings.push(
        linkRes?.error?.message ??
          'Quote placed, but the source link could not be inserted.',
      );
    }
  }

  let blockBottom = linkBottom;
  let inkFailed = false;
  if (quote.ink) {
    const inkTop = linkBottom + layout.inkGap;
    const inkError = await insertInkStrokes(
      quote.ink,
      {x: left, y: inkTop},
      layout.inkScale,
      layout.notePath,
      layout.page,
      layout.pageSize,
      (done, total) =>
        layout.onProgress?.(`Writing your note… ${done} of ${total} strokes`),
    );
    if (inkError) {
      inkFailed = true;
      warnings.push(
        `Quote placed, but the handwriting could not be inserted (${inkError}). The quote stays in Shelf so the handwriting is not lost.`,
      );
    } else {
      blockBottom = inkTop + Math.round(quote.ink.height * layout.inkScale);
    }
  }

  // Record the placed block so later placements (and batches) stack above
  // it; the cursor stays maintained for the scanless fallback path.
  if (layout.scan) {
    layout.scan.rects.push({
      left,
      top: textTop,
      right:
        left +
        Math.max(textWidth, quote.ink ? Math.round(quote.ink.width * layout.inkScale) : 0),
      bottom: blockBottom,
    });
  }
  placementCursors.set(layout.cursorKey, textTop - 24);

  if (!layout.skipSave) {
    await saveCurrentNoteQuietly();
  }
  return {
    status: 'placed',
    warning: warnings.length ? warnings.join(' ') : undefined,
    inkFailed,
  };
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
