import {describe, expect, it} from '@jest/globals';
import {
  PDF_MAX_BYTES,
  PDF_WARN_BYTES,
  estimateInsertSeconds,
  formatFileSize,
  pdfSizeLevel,
  pdfTooLargeMessage,
} from '../src/domain/pdfSize';

const MB = 1024 * 1024;

describe('pdfSizeLevel', () => {
  it('passes an ordinary PDF', () => {
    expect(pdfSizeLevel(738 * 1024)).toBe('ok');
  });

  it('warns from 10 MB and refuses past 25 MB', () => {
    expect(pdfSizeLevel(PDF_WARN_BYTES - 1)).toBe('ok');
    expect(pdfSizeLevel(PDF_WARN_BYTES)).toBe('large');
    expect(pdfSizeLevel(PDF_MAX_BYTES)).toBe('large');
    expect(pdfSizeLevel(PDF_MAX_BYTES + 1)).toBe('tooLarge');
  });

  it('never blocks on a size it could not read', () => {
    expect(pdfSizeLevel(0)).toBe('ok');
    expect(pdfSizeLevel(-1)).toBe('ok');
    expect(pdfSizeLevel(Number.NaN)).toBe('ok');
  });
});

describe('formatFileSize', () => {
  it('reads as a person would write it', () => {
    expect(formatFileSize(738 * 1024)).toBe('738 KB');
    expect(formatFileSize(2.5 * MB)).toBe('2.5 MB');
    expect(formatFileSize(38.5 * MB)).toBe('39 MB');
    expect(formatFileSize(0)).toBe('an unknown size');
  });
});

describe('estimateInsertSeconds', () => {
  it('lands near the measured 38.5 MB run', () => {
    expect(estimateInsertSeconds(38.5 * MB)).toBe(35);
  });

  it('never promises less than five seconds', () => {
    expect(estimateInsertSeconds(1024)).toBe(5);
  });
});

describe('pdfTooLargeMessage', () => {
  it('states the size and the limit, and nothing else', () => {
    const message = pdfTooLargeMessage(38.5 * MB);
    expect(message).toBe("This PDF is 39 MB. Shelf can't load PDFs over 25 MB.");
  });
});
