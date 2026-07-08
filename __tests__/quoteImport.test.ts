import {describe, expect, it} from '@jest/globals';
import {
  importFileTimestamp,
  isImportFileName,
  isImportedQuote,
  quoteFromImportFile,
} from '../src/domain/quoteImport';
import type {ShelfQuote} from '../src/domain/shelfItem';

const NOW = 1751900000000;

describe('isImportFileName', () => {
  it('accepts shelf-quote text files only', () => {
    expect(isImportFileName('shelf-quote-2026-07-07-163836.txt')).toBe(true);
    expect(isImportFileName('shelf-quote-test.txt')).toBe(true);
    expect(isImportFileName('shelf-quote-.txt')).toBe(true);
    expect(isImportFileName('localsend-plugin.log')).toBe(false);
    expect(isImportFileName('data_structures.pdf')).toBe(false);
    expect(isImportFileName('shelf-quote-2026.txt.bak')).toBe(false);
    expect(isImportFileName('quote-2026-07-07.txt')).toBe(false);
  });
});

describe('importFileTimestamp', () => {
  it('parses the canonical filename timestamp as local time', () => {
    const stamp = importFileTimestamp('shelf-quote-2026-07-07-163836.txt', NOW);
    expect(stamp).toBe(new Date(2026, 6, 7, 16, 38, 36).getTime());
  });

  it('falls back to now for non-timestamped names', () => {
    expect(importFileTimestamp('shelf-quote-test.txt', NOW)).toBe(NOW);
    expect(importFileTimestamp('shelf-quote-2026-07.txt', NOW)).toBe(NOW);
  });
});

describe('quoteFromImportFile', () => {
  it('builds an imported quote with the filename as id', () => {
    const quote = quoteFromImportFile(
      'shelf-quote-2026-07-07-163836.txt',
      'The palest ink is better than the best memory.\n',
      NOW,
    );
    expect(quote).not.toBeNull();
    expect(quote?.id).toBe('shelf-quote-2026-07-07-163836.txt');
    expect(quote?.text).toBe('The palest ink is better than the best memory.');
    expect(quote?.sourcePath).toBe('');
    expect(quote?.sourceTitle).toBe('Imported');
    expect(quote?.sourceKind).toBe('other');
    expect(quote?.capturedAt).toBe(new Date(2026, 6, 7, 16, 38, 36).getTime());
  });

  it('rejects blank files', () => {
    expect(quoteFromImportFile('shelf-quote-test.txt', '', NOW)).toBeNull();
    expect(quoteFromImportFile('shelf-quote-test.txt', '  \n\n', NOW)).toBeNull();
  });
});

describe('isImportedQuote', () => {
  it('keys on the empty sourcePath marker', () => {
    const imported = quoteFromImportFile(
      'shelf-quote-test.txt',
      'text',
      NOW,
    ) as ShelfQuote;
    expect(isImportedQuote(imported)).toBe(true);
    expect(
      isImportedQuote({...imported, sourcePath: '/Document/A.pdf'}),
    ).toBe(false);
  });
});
