import type {ShelfQuote} from './shelfItem';

/**
 * Imported quotes arrive as INBOX/shelf-quote-*.txt files dropped over
 * Browse & Access (Mac/iPad capture shortcuts). The filename doubles as the
 * quote id so a re-import after a failed delete is a no-op instead of a
 * duplicate. An empty sourcePath marks a quote as imported: there is no
 * on-device source to link back to.
 */
const IMPORT_FILE_PATTERN = /^shelf-quote-.*\.txt$/;

const IMPORT_TIMESTAMP_PATTERN =
  /^shelf-quote-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.txt$/;

export function isImportFileName(name: string): boolean {
  return IMPORT_FILE_PATTERN.test(name);
}

export function isImportedQuote(quote: ShelfQuote): boolean {
  return quote.sourcePath === '';
}

/** Capture time from the filename; falls back to now for foreign names. */
export function importFileTimestamp(name: string, now: number): number {
  const match = IMPORT_TIMESTAMP_PATTERN.exec(name);
  if (!match) {
    return now;
  }
  const [, year, month, day, hour, minute, second] = match;
  const stamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
  return Number.isFinite(stamp) ? stamp : now;
}

/** Builds the quote for an import file, or null when the text is blank. */
export function quoteFromImportFile(
  name: string,
  rawText: string,
  now: number = Date.now(),
): ShelfQuote | null {
  const text = rawText.trim();
  if (!text) {
    return null;
  }
  return {
    id: name,
    text,
    sourcePath: '',
    sourceTitle: 'Imported',
    sourcePage: 0,
    sourceKind: 'other',
    capturedAt: importFileTimestamp(name, now),
  };
}
