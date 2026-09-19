import {NativeModules} from 'react-native';
import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';
import type {InsertBackground, InsertPosition} from '../domain/pdfInsertion';

// Bridge to ShelfPdfEditModule (PDFBox-Android): in-place page insertion into
// the open PDF, with a per-PDF backup for undo. See docs/pdf-page-insertion-design.md.

export type PdfInsertResult = {
  path: string;
  originalCount: number;
  finalCount: number;
  firstInsertedIndex: number;
  count: number;
};

export type PdfUndoRecord = {
  path: string;
  originalCount: number;
  firstInsertedIndex: number;
  count: number;
  time: number;
  /** From getUndo: false when the PDF changed since the insert (undo refused). */
  matches?: boolean;
};

type ShelfPdfEditBridge = {
  insertPages(
    path: string,
    anchorIndex: number,
    position: InsertPosition,
    count: number,
    background: InsertBackground,
  ): Promise<PdfInsertResult>;
  getUndo(path: string): Promise<PdfUndoRecord | null>;
  undoLastInsert(path: string): Promise<PdfUndoRecord>;
};

type ApiResponse<T> = {success?: boolean; result?: T};

const ShelfPdfEdit = NativeModules.ShelfPdfEdit as ShelfPdfEditBridge | undefined;

function requireBridge(): ShelfPdfEditBridge {
  if (!ShelfPdfEdit) {
    throw new Error('Installed native package is missing PDF editing. Rebuild and reinstall the plugin.');
  }
  return ShelfPdfEdit;
}

export function insertPdfPages(
  path: string,
  anchorIndex: number,
  position: InsertPosition,
  count: number,
  background: InsertBackground,
): Promise<PdfInsertResult> {
  return requireBridge().insertPages(path, anchorIndex, position, count, background);
}

export async function getPdfUndo(path: string): Promise<PdfUndoRecord | null> {
  if (!ShelfPdfEdit) {
    return null;
  }
  try {
    return await ShelfPdfEdit.getUndo(path);
  } catch {
    return null;
  }
}

export function undoPdfInsert(path: string): Promise<PdfUndoRecord> {
  return requireBridge().undoLastInsert(path);
}

/**
 * Pages with handwriting (from the PDF's annotation sidecar), or null when it
 * cannot be read. May include pages whose marks were since erased.
 */
export async function readMarkedPages(path: string): Promise<number[] | null> {
  try {
    const res = (await PluginFileAPI.getMarkPages(path)) as ApiResponse<number[]>;
    return res?.success && Array.isArray(res.result) ? res.result : null;
  } catch {
    return null;
  }
}

/** The native module's messages are already user-facing; keep them as-is. */
export function pdfEditErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as {message: unknown}).message);
  }
  return String(error);
}

// ---- Moving handwriting between PDF pages ---------------------------------
// Only with the PDF CLOSED (device tests 2026-09-18): then getElements /
// insertElements / deleteElements on the PDF path read and write the .mark
// file itself and survive reopening. With the PDF open they change only the
// reader's live copy, which a reload discards; and clearMarkElements /
// getMarkPages are refused (102) for a PDF that is not the open file.

type MarkApiResponse<T> = {success?: boolean; result?: T; error?: {message?: string}};

async function recycleAll(elements: any[]): Promise<void> {
  for (const element of elements) {
    try {
      await element?.recycle?.();
    } catch {
      // best effort — unrecycled elements only cost native cache
    }
  }
}

async function readPage(path: string, page: number): Promise<any[]> {
  const res = (await PluginFileAPI.getElements(page, path)) as MarkApiResponse<any[]>;
  if (!res?.success || !Array.isArray(res.result)) {
    throw new Error(res?.error?.message ?? `Could not read the handwriting on page ${page + 1}.`);
  }
  return res.result;
}

/** Element numbers on a page, each once (getElements can repeat an element). */
function elementNumbers(elements: any[]): number[] {
  return [
    ...new Set(
      elements.map(el => el?.numInPage).filter((n): n is number => typeof n === 'number'),
    ),
  ];
}

async function deleteNumbers(path: string, page: number, nums: number[]): Promise<void> {
  if (nums.length === 0) {
    return;
  }
  const res = (await PluginFileAPI.deleteElements(path, page, nums)) as MarkApiResponse<boolean>;
  if (!res?.success) {
    throw new Error(res?.error?.message ?? `Could not clear the handwriting on page ${page + 1}.`);
  }
}

/** Number of annotation elements on a PDF page (0 when none or unreadable). */
export async function pageMarkCount(path: string, page: number): Promise<number> {
  try {
    const elements = await readPage(path, page);
    await recycleAll(elements);
    return elements.length;
  } catch {
    return 0;
  }
}

/** Deletes a page's handwriting. The PDF must be closed. */
export async function clearPageMarks(path: string, page: number): Promise<void> {
  const elements = await readPage(path, page);
  const nums = elementNumbers(elements);
  await recycleAll(elements);
  await deleteNumbers(path, page, nums);
}

/**
 * Copies a page's handwriting onto another page, then deletes the original.
 * The PDF must be closed. The original is deleted ONLY after the copy
 * succeeded. Returns false when the page had nothing to move. Throws on
 * failure, leaving `from` intact.
 */
export async function movePageMarks(path: string, from: number, to: number): Promise<boolean> {
  const elements = await readPage(path, from);
  const nums = elementNumbers(elements);
  try {
    if (elements.length === 0) {
      return false;
    }
    for (const element of elements) {
      element.pageNum = to;
    }
    const inserted = (await PluginFileAPI.insertElements(path, to, elements)) as MarkApiResponse<boolean>;
    if (!inserted?.success) {
      throw new Error(
        inserted?.error?.message ?? `Could not move the handwriting from page ${from + 1}.`,
      );
    }
  } finally {
    await recycleAll(elements);
  }
  await deleteNumbers(path, from, nums);
  return true;
}

/**
 * Opens `path` in the reader (page -1 = its last-used page) and waits until the
 * reader reports it as the open file. Used to step OUT of a PDF before editing
 * its handwriting, and back into it afterwards. Returns false on timeout.
 */
export async function openFileAndWait(path: string, page: number, timeoutMs = 10000): Promise<boolean> {
  try {
    await PluginFileAPI.openFile(path, page);
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = (await PluginCommAPI.getCurrentFilePath()) as MarkApiResponse<string>;
      if (res?.success && res.result === path) {
        return true;
      }
    } catch {
      // the reader is switching files; keep waiting
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}
