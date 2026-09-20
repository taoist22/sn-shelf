// How big a PDF Shelf will take on.
//
// Measured on a Manta (2026-09-19): a 738 KB PDF gains a page in 2.4s, while a
// 38.5 MB / 930-page book took 34s — and the device's own reader was already
// slow to open it and to turn its pages. A document that large is a device
// problem before it is a Shelf problem, so Shelf declines it rather than
// pretending to cope. Compressing or splitting the PDF is the real fix.

const MB = 1024 * 1024;

/** Allowed, but slow enough to say so first. */
export const PDF_WARN_BYTES = 10 * MB;
/** Refused outright. */
export const PDF_MAX_BYTES = 25 * MB;

/** The cap in whole megabytes, for messages that mention it. */
export const PDF_LIMIT_MB = PDF_MAX_BYTES / MB;

export type PdfSizeLevel = 'ok' | 'large' | 'tooLarge';

/** An unknown or unreadable size never blocks: the operation decides for itself. */
export function pdfSizeLevel(bytes: number): PdfSizeLevel {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 'ok';
  }
  if (bytes > PDF_MAX_BYTES) {
    return 'tooLarge';
  }
  if (bytes >= PDF_WARN_BYTES) {
    return 'large';
  }
  return 'ok';
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 'an unknown size';
  }
  const mb = bytes / MB;
  if (mb < 1) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/** Rough insert time from the measured ~0.9 seconds per megabyte, to the nearest 5s. */
export function estimateInsertSeconds(bytes: number): number {
  const mb = Math.max(0, bytes) / MB;
  return Math.max(5, Math.round((mb * 0.9) / 5) * 5);
}

/**
 * Deliberately short: it is shown large and bold, and the title is already on
 * screen. The "can't load PDFs over" wording is what the screen matches on to
 * render it that way, so keep it if you reword this.
 */
export function pdfTooLargeMessage(bytes: number): string {
  return `This PDF is ${formatFileSize(bytes)}. Shelf can't load PDFs over ${PDF_LIMIT_MB} MB.`;
}

export function pdfLargeNote(bytes: number): string {
  return `This PDF is ${formatFileSize(bytes)}; adding a page takes about ${estimateInsertSeconds(bytes)} seconds.`;
}

/** Standing notice for the Shelf screen, so the refusal is never a surprise. */
export const PDF_LIMIT_HINT = `PDFs over ${PDF_MAX_BYTES / MB} MB aren't added to Shelf; over ${PDF_WARN_BYTES / MB} MB is slow.`;
