import type {QuoteInk} from './quoteInk';

export type ShelfKind = 'note' | 'pdf' | 'epub' | 'document' | 'other';

export type ShelfTarget = {
  id: string;
  path: string;
  title: string;
  page: number;
  kind: ShelfKind;
  addedAt: number;
  /** True for Browse/working-note entries that should resume the file. */
  openAtLastUsed?: boolean;
};

export function detectShelfKind(path: string): ShelfKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.note')) {
    return 'note';
  }
  if (lower.endsWith('.pdf')) {
    return 'pdf';
  }
  if (lower.endsWith('.epub')) {
    return 'epub';
  }
  if (
    lower.endsWith('.doc') ||
    lower.endsWith('.docx') ||
    lower.endsWith('.cbz') ||
    lower.endsWith('.xps') ||
    lower.endsWith('.fb2')
  ) {
    return 'document';
  }
  return 'other';
}

export function isDocumentKind(kind: ShelfKind): boolean {
  return kind === 'pdf' || kind === 'epub' || kind === 'document';
}

export type ShelfQuote = {
  id: string;
  text: string;
  sourcePath: string;
  sourceTitle: string;
  sourcePage: number;
  sourceKind: ShelfKind;
  capturedAt: number;
  /** Handwritten note written on the capture screen, placed under the quote. */
  ink?: QuoteInk;
};

export type ProjectAnchorKind = 'note' | 'folder';

export type ShelfProject = {
  anchorPath: string;
  anchorTitle: string;
  anchorKind: ProjectAnchorKind;
  /** Folder projects can designate a working note inside the folder. */
  workingNotePath: string | null;
  workingNoteTitle: string | null;
  references: ShelfTarget[];
  quotes: ShelfQuote[];
};

/**
 * The note target the project header opens: the anchor itself for note
 * projects, the designated working note for folder projects (null when a
 * folder project has none — callers open the folder instead).
 */
export function projectNoteTarget(project: ShelfProject): ShelfTarget | null {
  const path =
    project.anchorKind === 'note' ? project.anchorPath : project.workingNotePath;
  if (!path) {
    return null;
  }
  const title =
    project.anchorKind === 'note'
      ? project.anchorTitle
      : project.workingNoteTitle ?? fileTitle(path);
  return {
    id: path,
    path,
    title,
    page: 0,
    kind: 'note',
    addedAt: 0,
    openAtLastUsed: true,
  };
}

export function normalizeDevicePath(path: string): string {
  // Preserve absolute paths on every mounted volume, including SD cards.
  // Older code treated every leading slash as internal-storage-relative and
  // turned /storage/1234-ABCD/... into /storage/emulated/0/storage/....
  if (path.startsWith('/storage/')) {
    return path;
  }
  if (path.startsWith('storage/')) {
    return `/${path}`;
  }
  if (path.startsWith('/')) {
    return `/storage/emulated/0${path}`;
  }
  return `/storage/emulated/0/${path}`;
}

/**
 * Whether two paths name the same file. The same file arrives in different
 * forms depending on which API produced it (the picker, the reader, the native
 * folder browser), so every comparison of a stored path against a live one has
 * to normalize first. Comparing raw strings let the same note anchor two
 * projects and made "is this file already open?" answer no while it was open.
 */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return normalizeDevicePath(a) === normalizeDevicePath(b);
}

export function fileTitle(path: string): string {
  const name = path.split('/').filter(Boolean).pop() ?? path;
  return name.replace(/\.[^/.]+$/, '') || name;
}

export function formatPage(page: number): string {
  return `p. ${Math.max(0, page) + 1}`;
}

export function makeShelfTarget(
  path: string,
  page: number,
  /**
   * Defaults to what the kind deserves rather than to false. The old default of false was
   * stored on every pinned card, so a PDF pinned once at page 14 reopened at page 14 for
   * ever, whatever the reader's own bookmark said (device report, 2026-11-02).
   */
  openAtLastUsed = isDocumentKind(detectShelfKind(path)) || page === 0,
): ShelfTarget {
  return {
    id: `${path}:${page}:${Date.now()}`,
    path,
    title: fileTitle(path),
    page,
    kind: detectShelfKind(path),
    addedAt: Date.now(),
    openAtLastUsed,
  };
}

/**
 * Whether opening this card should resume the reader's own place rather than jump to the
 * page the card remembers.
 *
 * A document ALWAYS resumes: you read through a PDF, so its card is a way back into it, not
 * a bookmark to one page. This deliberately ignores a stored `false` — cards pinned before
 * 2026-11-02 carry one, and honouring it sent the user back to page 14 of a book they had
 * read to page 40. A quote's source link still jumps to its exact page, because that call
 * passes the page itself rather than coming through here.
 */
export function targetOpensAtLastUsedPage(target: ShelfTarget): boolean {
  if (isDocumentKind(target.kind)) {
    return true;
  }
  if (typeof target.openAtLastUsed === 'boolean') {
    return target.openAtLastUsed;
  }
  return target.kind === 'note' && target.page === 0;
}
