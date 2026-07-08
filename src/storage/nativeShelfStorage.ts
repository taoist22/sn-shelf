import {NativeModules} from 'react-native';
import type {ShelfProject, ShelfQuote, ShelfTarget} from '../domain/shelfItem';
import {fileTitle} from '../domain/shelfItem';

export type HeadingText = {
  /** Stable identity of a title: page + position + size. */
  key: string;
  page: number;
  text: string;
};

export type PersistedShelfState = {
  version: 2;
  general: ShelfTarget[];
  projects: ShelfProject[];
  activeAnchorPath: string | null;
  /** OCR results for note headings, keyed by note path. */
  headingTexts: Record<string, HeadingText[]>;
  /** Quotes imported from INBOX files; not tied to any project. */
  inboxQuotes: ShelfQuote[];
};

type ShelfStorageModule = {
  readState(): Promise<string | null>;
  writeState(json: string): Promise<boolean>;
};

const ShelfStorage = NativeModules.ShelfStorage as ShelfStorageModule | undefined;

function isShelfTarget(value: unknown): value is ShelfTarget {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const target = value as Partial<ShelfTarget>;
  return (
    typeof target.id === 'string' &&
    typeof target.path === 'string' &&
    typeof target.title === 'string' &&
    typeof target.page === 'number' &&
    typeof target.kind === 'string' &&
    typeof target.addedAt === 'number'
  );
}

function isShelfQuote(value: unknown): value is ShelfQuote {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const quote = value as Partial<ShelfQuote>;
  return (
    typeof quote.id === 'string' &&
    typeof quote.text === 'string' &&
    typeof quote.sourcePath === 'string' &&
    typeof quote.sourceTitle === 'string' &&
    typeof quote.sourcePage === 'number' &&
    typeof quote.sourceKind === 'string' &&
    typeof quote.capturedAt === 'number'
  );
}

function parseProject(value: unknown): ShelfProject | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const project = value as Partial<ShelfProject>;
  if (typeof project.anchorPath !== 'string' || !project.anchorPath) {
    return null;
  }
  return {
    anchorPath: project.anchorPath,
    anchorTitle:
      typeof project.anchorTitle === 'string' && project.anchorTitle
        ? project.anchorTitle
        : fileTitle(project.anchorPath),
    anchorKind: project.anchorKind === 'folder' ? 'folder' : 'note',
    workingNotePath:
      typeof project.workingNotePath === 'string' && project.workingNotePath
        ? project.workingNotePath
        : null,
    workingNoteTitle:
      typeof project.workingNoteTitle === 'string' && project.workingNoteTitle
        ? project.workingNoteTitle
        : null,
    references: Array.isArray(project.references)
      ? project.references.filter(isShelfTarget)
      : [],
    quotes: Array.isArray(project.quotes)
      ? project.quotes.filter(isShelfQuote)
      : [],
  };
}

function isHeadingText(value: unknown): value is HeadingText {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Partial<HeadingText>;
  return (
    typeof entry.key === 'string' &&
    typeof entry.page === 'number' &&
    typeof entry.text === 'string'
  );
}

function parseHeadingTexts(value: unknown): Record<string, HeadingText[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, HeadingText[]> = {};
  for (const [path, entries] of Object.entries(value)) {
    if (Array.isArray(entries)) {
      out[path] = entries.filter(isHeadingText);
    }
  }
  return out;
}

export function emptyShelfState(): PersistedShelfState {
  return {
    version: 2,
    general: [],
    projects: [],
    activeAnchorPath: null,
    headingTexts: {},
    inboxQuotes: [],
  };
}

/**
 * Parses the persisted JSON, migrating the legacy v1 flat shape
 * ({items, returnTarget}) into the project-scoped v2 shape. Legacy pins
 * follow the working note into its project so the visible shelf is
 * unchanged after upgrade; without a working note they land in general.
 */
export function parsePersistedShelfState(raw: string): PersistedShelfState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyShelfState();
  }
  if (!parsed || typeof parsed !== 'object') {
    return emptyShelfState();
  }

  const value = parsed as {
    version?: unknown;
    general?: unknown;
    projects?: unknown;
    activeAnchorPath?: unknown;
    headingTexts?: unknown;
    inboxQuotes?: unknown;
    items?: unknown;
    returnTarget?: unknown;
  };

  if (value.version === 2) {
    const projects = Array.isArray(value.projects)
      ? value.projects
          .map(parseProject)
          .filter((project): project is ShelfProject => project !== null)
      : [];
    const activeAnchorPath =
      typeof value.activeAnchorPath === 'string' &&
      projects.some(project => project.anchorPath === value.activeAnchorPath)
        ? value.activeAnchorPath
        : null;
    return {
      version: 2,
      general: Array.isArray(value.general)
        ? value.general.filter(isShelfTarget)
        : [],
      projects,
      activeAnchorPath,
      headingTexts: parseHeadingTexts(value.headingTexts),
      inboxQuotes: Array.isArray(value.inboxQuotes)
        ? value.inboxQuotes.filter(isShelfQuote)
        : [],
    };
  }

  // Legacy v1 migration.
  const items = Array.isArray(value.items)
    ? value.items.filter(isShelfTarget)
    : [];
  const returnTarget = isShelfTarget(value.returnTarget)
    ? value.returnTarget
    : null;

  if (returnTarget && returnTarget.kind === 'note') {
    return {
      version: 2,
      general: [],
      projects: [
        {
          anchorPath: returnTarget.path,
          anchorTitle: returnTarget.title,
          anchorKind: 'note',
          workingNotePath: null,
          workingNoteTitle: null,
          references: items,
          quotes: [],
        },
      ],
      activeAnchorPath: returnTarget.path,
      headingTexts: {},
      inboxQuotes: [],
    };
  }

  return {
    version: 2,
    general: items,
    projects: [],
    activeAnchorPath: null,
    headingTexts: {},
    inboxQuotes: [],
  };
}

export async function loadPersistedShelfState(): Promise<PersistedShelfState | null> {
  const raw = await ShelfStorage?.readState();
  if (!raw) {
    return null;
  }
  return parsePersistedShelfState(raw);
}

export async function savePersistedShelfState(
  state: PersistedShelfState,
): Promise<void> {
  if (!ShelfStorage?.writeState) {
    return;
  }
  await ShelfStorage.writeState(JSON.stringify(state));
}
