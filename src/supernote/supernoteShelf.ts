import {PluginCommAPI, PluginDocAPI, PluginFileAPI, PluginManager, PluginNoteAPI, RattaFileSelector} from 'sn-plugin-lib';
import {
  formatPage,
  makeShelfTarget,
  normalizeDevicePath,
  type ShelfKind,
  type ShelfQuote,
  type ShelfTarget,
} from '../domain/shelfItem';

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
  return Math.max(360, Math.min(maxWidth - 440, estimated));
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

/**
 * Places a quote on the CURRENT note page: an editable text box with the
 * quote, then a jump link back to the source beneath it. Inserts are
 * sequential — parallel insert calls freeze the device (see sn-query notes).
 */
export async function insertQuoteIntoCurrentNote(
  quote: ShelfQuote,
): Promise<void> {
  const current = await getCurrentTarget();
  if (current.kind !== 'note') {
    throw new Error('Open the working note page before placing a quote.');
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

  const left = 180;
  const textWidth = width - 2 * left;
  // Rough height from an estimated chars-per-line at fontSize 30.
  const lines = Math.max(1, Math.ceil(quote.text.length / (textWidth / 16)));
  const textHeight = Math.min(900, lines * 44 + 24);

  const cursorKey = `${current.path}#${current.page}`;
  const bottomLimit = placementCursors.get(cursorKey) ?? height - 160;
  const linkHeight = 64;
  const gap = 12;
  const linkBottom = bottomLimit;
  const linkTop = linkBottom - linkHeight;
  const textBottom = linkTop - gap;
  const textTop = Math.max(120, textBottom - textHeight);

  const textRes = (await PluginNoteAPI.insertText({
    textContentFull: `“${quote.text}”`,
    textRect: {left, top: textTop, right: left + textWidth, bottom: textBottom},
    fontSize: 30,
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

  const label = `— ${quote.sourceTitle}, ${formatPage(quote.sourcePage)}`;
  const linkWidth = estimateLinkWidth(label, width);
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

  // Next placement on this page stacks above this quote.
  placementCursors.set(cursorKey, textTop - 24);

  try {
    await PluginNoteAPI.saveCurrentNote();
  } catch {
    // The visible elements usually exist immediately; save is best-effort.
  }
}

export async function insertShelfLink(target: ShelfTarget): Promise<void> {
  const current = await getCurrentTarget();
  if (current.kind !== 'note') {
    throw new Error('Open a note page before placing a jump link.');
  }

  const pageWidth = await deviceWidth();
  const label = `SN Shelf: ${target.title} (${formatPage(target.page)})`;
  const width = estimateLinkWidth(label, pageWidth);
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
