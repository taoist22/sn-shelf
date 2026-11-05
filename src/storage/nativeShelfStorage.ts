import {NativeModules} from 'react-native';
import type {ShelfProject, ShelfQuote, ShelfTarget} from '../domain/shelfItem';
import {isQuoteInk} from '../domain/quoteInk';
import {
  clampInsertCount,
  isImageFile,
  type InsertPosition,
  MAX_TEMPLATES,
  parseTemplateSize,
  type TemplateSize,
} from '../domain/pdfInsertion';
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
  /** Where Insert Page does its heavy work; absent = 'same' (the PDF's storage). */
  pdfWorkSpace?: PdfWorkSpace;
  /** Recently inserted template images, newest first. */
  pdfTemplates?: string[];
  /** How much of the page a template image fills; absent = 'margin'. */
  pdfTemplateSize?: TemplateSize;
  /** Re-encode template images for e-ink; absent = on. */
  pdfTemplateShrink?: boolean;
  /** Last rule/grid/dot spacing in mm; absent = 8. */
  pdfTemplateSpacing?: number;
  /** Last Insert Page position and count, so the next insert repeats the last one. */
  pdfInsertPosition?: InsertPosition;
  pdfInsertCount?: number;
  /** Shelf's floating button: off unless the user turns it on. */
  overlayEnabled?: boolean;
  /** Whether a plain tap inserts straight away instead of opening the menu. */
  overlayTapInserts?: boolean;
};

export type PdfWorkSpace = 'same' | 'sd' | 'internal';

function parsePdfWorkSpace(value: unknown): PdfWorkSpace | undefined {
  return value === 'same' || value === 'sd' || value === 'internal' ? value : undefined;
}

function parsePdfTemplates(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string' && isImageFile(entry))
        .slice(0, MAX_TEMPLATES)
    : [];
}

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

/** Valid quotes only; malformed ink is dropped rather than losing the quote. */
function parseQuotes(value: unknown): ShelfQuote[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isShelfQuote).map(quote => {
    if (quote.ink === undefined || isQuoteInk(quote.ink)) {
      return quote;
    }
    const rest = {...quote};
    delete rest.ink;
    return rest;
  });
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
    quotes: parseQuotes(project.quotes),
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
/**
 * Reports what was in the saved file: a state, or nothing readable. Keeping
 * "unreadable" distinct from "empty" is what stops a truncated file being
 * treated as an empty shelf and then saved over (2026-11-04).
 */
export type ShelfLoad =
  | {status: 'loaded'; state: PersistedShelfState}
  | {status: 'empty'}
  | {status: 'unreadable'; detail: string};

export function parsePersistedShelfState(raw: string): PersistedShelfState {
  const strict = parseShelfStateStrict(raw);
  return strict.status === 'loaded' ? strict.state : emptyShelfState();
}

export function parseShelfStateStrict(raw: string): ShelfLoad {
  if (raw.trim() === '') {
    return {status: 'empty'};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {status: 'unreadable', detail: `not valid JSON (${String(error)})`};
  }
  if (!parsed || typeof parsed !== 'object') {
    return {status: 'unreadable', detail: 'not an object'};
  }
  return {status: 'loaded', state: readShelfStateObject(parsed)};
}

function readShelfStateObject(parsed: object): PersistedShelfState {

  const value = parsed as {
    version?: unknown;
    general?: unknown;
    projects?: unknown;
    activeAnchorPath?: unknown;
    headingTexts?: unknown;
    inboxQuotes?: unknown;
    pdfWorkSpace?: unknown;
    pdfTemplates?: unknown;
    pdfTemplateSize?: unknown;
    pdfTemplateShrink?: unknown;
    pdfTemplateSpacing?: unknown;
    pdfInsertPosition?: unknown;
    pdfInsertCount?: unknown;
    overlayEnabled?: unknown;
    overlayTapInserts?: unknown;
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
      inboxQuotes: parseQuotes(value.inboxQuotes),
      pdfWorkSpace: parsePdfWorkSpace(value.pdfWorkSpace),
      pdfTemplates: parsePdfTemplates(value.pdfTemplates),
      pdfTemplateSize: parseTemplateSize(value.pdfTemplateSize),
      pdfTemplateShrink:
        typeof value.pdfTemplateShrink === 'boolean' ? value.pdfTemplateShrink : undefined,
      pdfTemplateSpacing:
        typeof value.pdfTemplateSpacing === 'number' && value.pdfTemplateSpacing > 0
          ? value.pdfTemplateSpacing
          : undefined,
      pdfInsertPosition:
        value.pdfInsertPosition === 'before' || value.pdfInsertPosition === 'after'
          ? value.pdfInsertPosition
          : undefined,
      pdfInsertCount:
        typeof value.pdfInsertCount === 'number' ? clampInsertCount(value.pdfInsertCount) : undefined,
      overlayEnabled: typeof value.overlayEnabled === 'boolean' ? value.overlayEnabled : undefined,
      overlayTapInserts:
        typeof value.overlayTapInserts === 'boolean' ? value.overlayTapInserts : undefined,
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

export async function readShelfState(): Promise<ShelfLoad> {
  if (!ShelfStorage?.readState) {
    return {status: 'empty'};
  }
  let raw: string | null;
  try {
    raw = await ShelfStorage.readState();
  } catch (error) {
    return {status: 'unreadable', detail: `could not be read (${String(error)})`};
  }
  if (raw === null || raw === undefined) {
    return {status: 'empty'};
  }
  return parseShelfStateStrict(raw);
}

export async function savePersistedShelfState(
  state: PersistedShelfState,
): Promise<void> {
  if (!ShelfStorage?.writeState) {
    return;
  }
  await ShelfStorage.writeState(JSON.stringify(state));
}
