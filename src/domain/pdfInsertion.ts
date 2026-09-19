// Page arithmetic for inserting pages into a PDF. All indices are zero-based
// (what the SDK reports); the UI shows page numbers one-based.
// No SDK imports here — this file is unit-tested.

export const MAX_INSERT_PAGES = 20;

export type InsertPosition = 'before' | 'after';
export type InsertBackground = 'blank' | 'lined';

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
