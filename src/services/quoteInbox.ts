import {FileUtils} from 'sn-plugin-lib';
import {isImportFileName, quoteFromImportFile} from '../domain/quoteImport';
import {addQuoteToInbox, flushShelfState} from '../storage/sessionShelf';

const INBOX_DIR = '/storage/emulated/0/INBOX';

/**
 * Pulls INBOX/shelf-quote-*.txt files (dropped over Browse & Access by the
 * desktop/tablet capture shortcuts) into the imported-quotes inbox, then
 * deletes them — but only once the shelf state is safely on disk. Blank
 * files are deleted without importing. Returns how many quotes were added.
 */
export async function importInboxQuotes(): Promise<number> {
  const entries = await FileUtils.listFiles(INBOX_DIR).catch(() => null);
  if (!entries || !Array.isArray(entries)) {
    return 0;
  }

  const consumed: string[] = [];
  let added = 0;
  for (const entry of entries) {
    // listFiles returns strings (name or full path depending on firmware)
    // or {path} descriptors depending on lib version.
    const raw =
      typeof entry === 'string' ? entry : (entry as {path?: string}).path ?? '';
    const name = raw.split('/').pop() ?? raw;
    if (!isImportFileName(name)) {
      continue;
    }
    const path = `${INBOX_DIR}/${name}`;
    let text: string;
    try {
      // fetch over file:// reports HTTP status 0 on Android; the body is
      // still the file content, so response.ok must be ignored.
      const response = await fetch(`file://${path}`);
      text = await response.text();
    } catch {
      continue; // Unreadable now; retried on the next import.
    }
    const quote = quoteFromImportFile(name, text);
    if (quote && addQuoteToInbox(quote)) {
      added += 1;
    }
    // Blank files and already-imported ids are consumed too.
    consumed.push(path);
  }

  if (consumed.length === 0) {
    return 0;
  }

  const saved = await flushShelfState();
  if (!saved) {
    // Keep the files; filename-as-id makes the next attempt a clean retry.
    return added;
  }
  for (const path of consumed) {
    try {
      await FileUtils.deleteFile(path);
    } catch {
      // Best effort; a leftover file is skipped as a duplicate next time.
    }
  }
  return added;
}
