import type {ShelfProject, ShelfQuote, ShelfTarget} from '../domain/shelfItem';
import {shelfLog} from '../supernote/shelfLog';

/** Fire-and-forget log line: the savers that need it are synchronous. */
function logLine(line: string): void {
  shelfLog(line).catch(() => {
    // logging must never break the feature it describes
  });
}
import {normalizeDevicePath, projectNoteTarget} from '../domain/shelfItem';
import {
  type InsertPosition,
  rememberTemplate,
  type TemplateSize,
} from '../domain/pdfInsertion';
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
  readShelfState,
  savePersistedShelfState,
  type HeadingText,
  type PdfWorkSpace,
  type PersistedShelfState,
} from './nativeShelfStorage';

let state: PersistedShelfState = emptyShelfState();
let hydration: Promise<void> | null = null;
/** Set once the saved shelf has actually been read, not merely requested. */
let hydrationFinished = false;
/**
 * Set when the saved shelf could not be read. Saving is then refused: the file
 * may hold the user's only copy of their shelf, and writing the empty
 * in-memory state over it would destroy it.
 */
let storageProblem: string | null = null;

/** Why the shelf is not being saved, for the panel to show; null when all is well. */
export function shelfStorageProblem(): string | null {
  return storageProblem;
}

/** One compact line describing the whole shelf, for the diagnostic log. */
export function summarizeShelfState(): string {
  const projects = state.projects
    .map(
      project =>
        `${project.anchorKind} "${project.anchorPath}" refs=${project.references.length}`,
    )
    .join(' | ');
  return `general=${state.general.length} projects=${state.projects.length}${
    projects ? ` [${projects}]` : ''
  } active=${state.activeAnchorPath ?? 'none'}`;
}

function persist(): void {
  if (!hydrationFinished) {
    // Before the read finishes the in-memory shelf is still the empty
    // starting state, so saving it would wipe the stored one.
    logLine('state: save skipped, the saved shelf has not been read yet');
    return;
  }
  if (storageProblem) {
    logLine(`state: save refused, ${storageProblem}`);
    return;
  }
  savePersistedShelfState(state).catch(error => {
    logLine(`state: save failed (${String(error)})`);
  });
}

/**
 * Reads the saved shelf once. Concurrent callers await the SAME read rather
 * than racing past it: the guard used to be set before the await, so a second
 * caller carried on with the empty starting state.
 */
export function hydrateShelfState(): Promise<void> {
  if (!hydration) {
    hydration = (async () => {
      const load = await readShelfState();
      if (load.status === 'loaded') {
        state = load.state;
      } else if (load.status === 'unreadable') {
        storageProblem = `the saved shelf ${load.detail}`;
      }
      hydrationFinished = true;
      await shelfLog(
        load.status === 'loaded'
          ? `shelf loaded: ${summarizeShelfState()}`
          : load.status === 'empty'
            ? 'shelf loaded: nothing saved yet'
            : `shelf NOT loaded: ${load.detail}; saving is disabled to protect the file`,
      );
    })();
  }
  return hydration;
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

/** Where Insert Page works: the PDF's own storage unless the user chose otherwise. */
export function getPdfWorkSpace(): PdfWorkSpace {
  return state.pdfWorkSpace ?? 'same';
}

export function setPdfWorkSpace(space: PdfWorkSpace): void {
  state.pdfWorkSpace = space;
  persist();
}

/** Template images used recently, newest first, for the Insert Page screen. */
export function getPdfTemplates(): string[] {
  return state.pdfTemplates ?? [];
}

/** How much of the page a template image fills; the choice sticks between inserts. */
export function getPdfTemplateSize(): TemplateSize {
  return state.pdfTemplateSize ?? 'margin';
}

export function setPdfTemplateSize(size: TemplateSize): void {
  state.pdfTemplateSize = size;
  persist();
}

/** Whether template images are re-encoded for e-ink; on unless the user turned it off. */
export function getPdfTemplateShrink(): boolean {
  return state.pdfTemplateShrink ?? true;
}

export function setPdfTemplateShrink(shrink: boolean): void {
  state.pdfTemplateShrink = shrink;
  persist();
}

/** Last rule/grid/dot spacing the user chose, in millimetres as seen on the device. */
export function getPdfTemplateSpacing(): number {
  return state.pdfTemplateSpacing ?? 8;
}

export function setPdfTemplateSpacing(spacing: number): void {
  state.pdfTemplateSpacing = spacing;
  persist();
}

/** Last Insert Page position and count: the defaults the next insert repeats. */
export function getPdfInsertPosition(): InsertPosition {
  return state.pdfInsertPosition ?? 'after';
}

export function setPdfInsertPosition(position: InsertPosition): void {
  state.pdfInsertPosition = position;
  persist();
}

export function getPdfInsertCount(): number {
  return state.pdfInsertCount ?? 1;
}

export function setPdfInsertCount(count: number): void {
  state.pdfInsertCount = count;
  persist();
}

/** Shelf's floating button: off by default, so installing can't make things worse. */
export function getOverlayEnabled(): boolean {
  return state.overlayEnabled ?? false;
}

export function setOverlayEnabled(enabled: boolean): void {
  state.overlayEnabled = enabled;
  persist();
}

export function getOverlayTapInserts(): boolean {
  return state.overlayTapInserts ?? false;
}

export function setOverlayTapInserts(tapInserts: boolean): void {
  state.overlayTapInserts = tapInserts;
  persist();
}

export function rememberPdfTemplate(path: string): string[] {
  state.pdfTemplates = rememberTemplate(getPdfTemplates(), path);
  persist();
  return state.pdfTemplates;
}
