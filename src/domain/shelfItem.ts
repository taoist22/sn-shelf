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
  openAtLastUsed = false,
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

/** Preserves the pre-0.2.5 behavior for persisted pins without the flag. */
export function targetOpensAtLastUsedPage(target: ShelfTarget): boolean {
  if (typeof target.openAtLastUsed === 'boolean') {
    return target.openAtLastUsed;
  }
  return isDocumentKind(target.kind) ||
    (target.kind === 'note' && target.page === 0);
}
