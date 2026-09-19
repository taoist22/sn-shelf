import type {ShelfProject, ShelfQuote, ShelfTarget} from '../domain/shelfItem';
import {normalizeDevicePath, projectNoteTarget} from '../domain/shelfItem';
import {
  createProject,
  deleteProject,
  findProject,
  moveGeneralItemToProject,
  resolveContext,
  setWorkingNote,
  type ShelfContext,
} from '../domain/shelfState';
import {
  emptyShelfState,
  loadPersistedShelfState,
  savePersistedShelfState,
  type HeadingText,
  type PersistedShelfState,
} from './nativeShelfStorage';

let state: PersistedShelfState = emptyShelfState();
let isHydrated = false;

function persist(): void {
  savePersistedShelfState(state).catch(() => {
    // Persistence is best-effort; the in-memory shelf remains usable.
  });
}

export async function hydrateShelfState(): Promise<void> {
  if (isHydrated) {
    return;
  }
  isHydrated = true;

  const persisted = await loadPersistedShelfState();
  if (persisted) {
    state = persisted;
  }
}

/** Every target that may own a cached thumbnail (pins + working notes). */
export function listAllPinnedTargets(): ShelfTarget[] {
  const targets: ShelfTarget[] = [...state.general];
  for (const project of state.projects) {
    targets.push(...project.references);
    const noteTarget = projectNoteTarget(project);
    if (noteTarget) {
      targets.push(noteTarget);
    }
  }
  return targets;
}

/** Derives the Shelf view from the currently open file. */
export function resolveShelfContext(currentPath: string | null): ShelfContext {
  const context = resolveContext(state, currentPath);
  persist();
  return context;
}

export function listProjects(): ShelfProject[] {
  return state.projects;
}

export function getGeneralItems(): ShelfTarget[] {
  return state.general;
}

export function saveGeneralItems(items: ShelfTarget[]): void {
  state.general = items;
  persist();
}

export function saveProjectReferences(
  anchorPath: string,
  items: ShelfTarget[],
): void {
  const project = findProject(state, anchorPath);
  if (!project) {
    return;
  }
  project.references = items;
  persist();
}

export function createProjectFromNote(
  anchorPath: string,
  anchorTitle?: string,
): ShelfProject {
  const project = createProject(state, anchorPath, anchorTitle, 'note');
  persist();
  return project;
}

export function createProjectFromFolder(
  folderPath: string,
  folderTitle?: string,
): ShelfProject {
  const project = createProject(state, folderPath, folderTitle, 'folder');
  persist();
  return project;
}

export function setProjectWorkingNote(
  anchorPath: string,
  notePath: string,
  noteTitle?: string,
): void {
  setWorkingNote(state, anchorPath, notePath, noteTitle);
  persist();
}

export function getInboxQuotes(): ShelfQuote[] {
  return state.inboxQuotes;
}

/** Adds an imported quote; no-op when its id (filename) is already known. */
export function addQuoteToInbox(quote: ShelfQuote): boolean {
  if (state.inboxQuotes.some(entry => entry.id === quote.id)) {
    return false;
  }
  state.inboxQuotes = [quote, ...state.inboxQuotes];
  return true;
}

export function removeQuoteFromInbox(quoteId: string): void {
  state.inboxQuotes = state.inboxQuotes.filter(quote => quote.id !== quoteId);
  persist();
}

/**
 * Awaited persist for callers that must know the state is on disk before
 * acting (the INBOX importer deletes source files only after a good save).
 */
export async function flushShelfState(): Promise<boolean> {
  try {
    await savePersistedShelfState(state);
    return true;
  } catch {
    return false;
  }
}

export function addQuoteToProject(
  anchorPath: string,
  quote: ShelfQuote,
): boolean {
  const project = findProject(state, anchorPath);
  if (!project) {
    return false;
  }
  project.quotes = [quote, ...project.quotes];
  persist();
  return true;
}

export function removeQuoteFromProject(
  anchorPath: string,
  quoteId: string,
): void {
  const project = findProject(state, anchorPath);
  if (!project) {
    return;
  }
  project.quotes = project.quotes.filter(quote => quote.id !== quoteId);
  persist();
}

export function getHeadingTexts(notePath: string): HeadingText[] {
  return state.headingTexts[notePath] ?? [];
}

export function saveHeadingTexts(
  notePath: string,
  entries: HeadingText[],
): void {
  state.headingTexts[notePath] = entries;
  persist();
}

export function removeProject(anchorPath: string): void {
  deleteProject(state, anchorPath);
  persist();
}

export function moveToProject(
  itemId: string,
  anchorPath: string,
): ShelfTarget | null {
  const moved = moveGeneralItemToProject(state, itemId, anchorPath);
  persist();
  return moved;
}

/**
 * After pages were inserted into (or removed from) a document, moves Shelf's
 * own references to it — pins and captured quotes — to their new page
 * numbers. Links already placed inside notes cannot be reached from here.
 * Returns how many references moved.
 */
export function shiftDocumentPages(
  documentPath: string,
  mapPage: (page: number) => number,
): number {
  const target = normalizeDevicePath(documentPath);
  let moved = 0;
  const shiftTarget = (item: ShelfTarget): ShelfTarget => {
    if (normalizeDevicePath(item.path) !== target) {
      return item;
    }
    const page = mapPage(item.page);
    if (page === item.page) {
      return item;
    }
    moved += 1;
    return {...item, page};
  };
  const shiftQuote = (quote: ShelfQuote): ShelfQuote => {
    if (!quote.sourcePath || normalizeDevicePath(quote.sourcePath) !== target) {
      return quote;
    }
    const sourcePage = mapPage(quote.sourcePage);
    if (sourcePage === quote.sourcePage) {
      return quote;
    }
    moved += 1;
    return {...quote, sourcePage};
  };
  state.general = state.general.map(shiftTarget);
  for (const project of state.projects) {
    project.references = project.references.map(shiftTarget);
    project.quotes = project.quotes.map(shiftQuote);
  }
  state.inboxQuotes = state.inboxQuotes.map(shiftQuote);
  if (moved > 0) {
    persist();
  }
  return moved;
}
