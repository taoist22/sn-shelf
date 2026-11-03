// Page arithmetic for inserting pages into a PDF. All indices are zero-based
// (what the SDK reports); the UI shows page numbers one-based.
// No SDK imports here — this file is unit-tested.

export const MAX_INSERT_PAGES = 20;

export type InsertPosition = 'before' | 'after';
export type InsertBackground = 'blank' | 'lined' | 'grid' | 'dots' | 'image';

/**
 * Spacings offered per drawn background, in millimetres AS SEEN ON THE DEVICE — Shelf
 * compensates for the reader shrinking the page to fit, so these match the device's own
 * templates rather than measuring 8 mm on a page nobody prints.
 */
const SPACINGS: Record<string, number[]> = {
  lined: [6, 8, 10],
  grid: [5, 10],
  dots: [5, 10],
};

export function spacingsFor(background: InsertBackground): number[] {
  return SPACINGS[background] ?? [];
}

/** Keeps a remembered spacing usable when the background changes (8 mm → 10 mm grid). */
export function spacingFor(background: InsertBackground, remembered: number): number {
  const options = spacingsFor(background);
  if (options.length === 0) {
    return 0;
  }
  if (options.includes(remembered)) {
    return remembered;
  }
  return options.reduce((best, option) =>
    Math.abs(option - remembered) < Math.abs(best - remembered) ? option : best,
  );
}

export function backgroundLabel(background: InsertBackground): string {
  switch (background) {
    case 'blank':
      return 'Blank';
    case 'lined':
      return 'Lined';
    case 'grid':
      return 'Grid';
    case 'dots':
      return 'Dots';
    default:
      return 'Image…';
  }
}

export const DRAWN_BACKGROUNDS: InsertBackground[] = ['blank', 'lined', 'grid', 'dots'];

/** How many recently used template images Shelf offers on the Insert Page screen. */
export const MAX_TEMPLATES = 5;

/** How much of the page a template image fills. */
export type TemplateSize = 'full' | 'margin' | 'small';

const TEMPLATE_SCALES: Record<TemplateSize, number> = {
  full: 1,
  margin: 0.94,
  small: 0.86,
};

export const TEMPLATE_SIZES = Object.keys(TEMPLATE_SCALES) as TemplateSize[];

export function templateScale(size: TemplateSize): number {
  return TEMPLATE_SCALES[size] ?? TEMPLATE_SCALES.margin;
}

export function parseTemplateSize(value: unknown): TemplateSize | undefined {
  return value === 'full' || value === 'margin' || value === 'small' ? value : undefined;
}

/** Label for the size control: the plain name plus what it actually does. */
export function templateSizeLabel(size: TemplateSize): string {
  const percent = Math.round(templateScale(size) * 100);
  const name = size === 'full' ? 'Full' : size === 'margin' ? 'Margin' : 'Small';
  return size === 'full' ? name : `${name} (${percent}%)`;
}

const IMAGE_SUFFIXES = ['.png', '.jpg', '.jpeg'];

/** What the device picker may hand back and PDFBox can draw. */
export function isImageFile(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_SUFFIXES.some(suffix => lower.endsWith(suffix));
}

/** Newest first, no duplicates, capped — the recent-template list. */
export function rememberTemplate(recents: string[], path: string): string[] {
  if (!path) {
    return recents.slice(0, MAX_TEMPLATES);
  }
  return [path, ...recents.filter(entry => entry !== path)].slice(0, MAX_TEMPLATES);
}

export function clampInsertCount(count: number): number {
  if (!Number.isFinite(count)) {
    return 1;
  }
  return Math.min(MAX_INSERT_PAGES, Math.max(1, Math.round(count)));
}

/** Index the first new page will have; new pages occupy [first, first + count). */
export function firstInsertedIndex(anchor: number, position: InsertPosition): number {
  return position === 'after' ? anchor + 1 : anchor;
}

/** Where an original page ends up after the insert. */
export function pageAfterInsert(page: number, first: number, count: number): number {
  return page >= first ? page + count : page;
}

/**
 * Where a page of the edited PDF ends up after undo. Pages that were
 * inserted no longer exist; references to them move to the page that
 * followed them (or the last page before them, at the end of the document).
 */
export function pageAfterUndo(
  page: number,
  first: number,
  count: number,
  originalCount: number,
): number {
  if (page >= first + count) {
    return page - count;
  }
  if (page >= first) {
    return Math.min(first, Math.max(0, originalCount - 1));
  }
  return page;
}

/** Pages with handwriting that the insert would shift. */
export function shiftedMarkedPages(markedPages: number[], first: number): number[] {
  return markedPages.filter(page => page >= first).sort((a, b) => a - b);
}

// ---- Moving handwriting with its pages ------------------------------------
//
// The PDF's handwriting sidecar is indexed by page, so after an insert every
// marked page from `first` on must move up by `count` — and back on undo.

export type MarkMove = {from: number; to: number};

/**
 * Moves for an insert, HIGHEST page first: each target has already been
 * emptied (or never had marks) before anything is copied onto it.
 */
export function planInsertMoves(markedPages: number[], first: number, count: number): MarkMove[] {
  return shiftedMarkedPages(markedPages, first)
    .sort((a, b) => b - a)
    .map(page => ({from: page, to: page + count}));
}

/**
 * Undo: handwriting on the inserted pages is cleared (those pages go away),
 * then later pages move back down, LOWEST page first.
 */
export function planUndoMoves(
  markedPages: number[],
  first: number,
  count: number,
): {clear: number[]; moves: MarkMove[]} {
  const unique = [...new Set(markedPages)].sort((a, b) => a - b);
  return {
    clear: unique.filter(page => page >= first && page < first + count),
    moves: unique
      .filter(page => page >= first + count)
      .map(page => ({from: page, to: page - count})),
  };
}

/** Undo moves already made, in reverse order. */
export function rollbackMoves(done: MarkMove[]): MarkMove[] {
  return [...done].reverse().map(move => ({from: move.to, to: move.from}));
}
