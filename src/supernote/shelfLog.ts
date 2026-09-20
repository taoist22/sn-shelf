import {NativeModules} from 'react-native';

// Diagnostic log for Insert Page: EXPORT/shelf-log.txt, downloadable with
// Browse & Access. Written by ShelfPdfEditModule; never throws.

type LogBridge = {log?(line: string): Promise<null>};

const ShelfPdfEdit = NativeModules.ShelfPdfEdit as LogBridge | undefined;

export const SHELF_LOG_FILE = 'EXPORT/shelf-log.txt';

export async function shelfLog(line: string): Promise<void> {
  try {
    await ShelfPdfEdit?.log?.(line);
  } catch {
    // logging must never break the feature it describes
  }
}
