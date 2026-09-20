import {
  type PdfSizeLevel,
  pdfLargeNote,
  pdfSizeLevel,
  pdfTooLargeMessage,
} from '../domain/pdfSize';
import type {ShelfTarget} from '../domain/shelfItem';
import {getFileSize} from './pdfEdit';

export type PdfSizeCheck = {
  level: PdfSizeLevel;
  bytes: number;
  /** Why it was refused, or how slow it will be; empty when there is nothing to say. */
  message: string;
};

const PASSES: PdfSizeCheck = {level: 'ok', bytes: 0, message: ''};

/**
 * Shelf's size gate. Only PDFs are weighed: they are the only files Shelf rewrites,
 * and the only ones the device struggles to read. See domain/pdfSize.ts for the limits.
 */
export async function checkPdfSize(target: {
  path: string;
  title: string;
  kind: ShelfTarget['kind'];
}): Promise<PdfSizeCheck> {
  if (target.kind !== 'pdf') {
    return PASSES;
  }
  const bytes = await getFileSize(target.path);
  const level = pdfSizeLevel(bytes);
  if (level === 'tooLarge') {
    return {level, bytes, message: pdfTooLargeMessage(bytes)};
  }
  if (level === 'large') {
    return {level, bytes, message: pdfLargeNote(bytes)};
  }
  return {level, bytes, message: ''};
}
