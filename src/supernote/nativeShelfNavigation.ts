import {NativeModules} from 'react-native';
import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';
import {isDocumentKind, type ShelfTarget} from '../domain/shelfItem';
import {ensureFileReadPermission} from './pluginPermissions';
import {nativeDelay} from './pdfEdit';
import {shelfLog} from './shelfLog';

type ApiResponse<T> = {
  success?: boolean;
  result?: T;
  error?: {message?: string};
};

type ShelfNavigationModule = {
  openNote(filePath: string, page: number): Promise<boolean>;
  openNoteAfterDelay(
    filePath: string,
    page: number,
    delayMs: number,
  ): Promise<boolean>;
  openDocumentAfterDelay(filePath: string, delayMs: number): Promise<boolean>;
  openFolderAfterDelay(folderPath: string, delayMs: number): Promise<boolean>;
};

const OPEN_DELAY_MS = 180;

const ShelfNavigation = NativeModules.ShelfNavigation as
  | ShelfNavigationModule
  | undefined;

const SDK_OPEN_EXTENSIONS = new Set([
  'note',
  'pdf',
  'epub',
  'cbz',
  'xps',
  'fb2',
]);

export function isSdkOpenablePath(path: string): boolean {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  return SDK_OPEN_EXTENSIONS.has(extension);
}

function apiError(response: ApiResponse<unknown> | null | undefined): string {
  return response?.error?.message ?? 'The Supernote file API could not open it.';
}

function requireShelfNavigation(): ShelfNavigationModule {
  if (!ShelfNavigation?.openNote) {
    throw new Error('ShelfNavigation native module is not available.');
  }
  return ShelfNavigation;
}

/**
 * Reports where the reader actually landed, a moment after Shelf asked it to open
 * something. Fire-and-forget: it must not delay closing the panel. Added because
 * "it opened a random page before where I left off" could not be diagnosed — Shelf
 * logged what it asked for but never what happened (device report, 2026-11-02).
 */
function logWhereTheReaderLanded(expected: string, requestedPage: number): void {
  // Deliberately not awaited: closing the panel must not wait for this.
  (async () => {
    try {
      await nativeDelay(1200);
      const fileRes = (await PluginCommAPI.getCurrentFilePath()) as ApiResponse<string>;
      const pageRes = (await PluginCommAPI.getCurrentPageNum()) as ApiResponse<number>;
      const landed = fileRes?.success ? String(fileRes.result) : 'unknown';
      const page = pageRes?.success ? pageRes.result : 'unknown';
      await shelfLog(
        `landed on ${landed === expected ? 'the right file' : landed} page ${
          typeof page === 'number' ? page + 1 : page
        } (asked for ${requestedPage < 0 ? 'its last-used page' : `page ${requestedPage + 1}`})`,
      );
    } catch (error) {
      await shelfLog(`could not check where the reader landed: ${String(error)}`);
    }
  })();

}

export async function openShelfTarget(
  target: ShelfTarget,
  options?: {atLastUsedPage?: boolean},
): Promise<void> {
  if (!(await ensureFileReadPermission())) {
    throw new Error('File access was not allowed.');
  }

  const page = options?.atLastUsedPage ? -1 : Math.max(0, target.page);
  await shelfLog(
    `open card: ${target.kind} ${target.path} ${
      page < 0 ? 'at its last-used page' : `at page ${page + 1}`
    }`,
  );

  if (isSdkOpenablePath(target.path)) {
    try {
      const currentRes = (await PluginCommAPI.getCurrentFilePath()) as
        | ApiResponse<string>
        | undefined;
      if (currentRes?.success && currentRes.result === target.path) {
        await shelfLog('already open: jumping within the file');
        if (page >= 0) {
          const jumpRes = (await PluginCommAPI.jumpToPage(page)) as ApiResponse<boolean>;
          if (!jumpRes?.success || !jumpRes.result) {
            throw new Error(apiError(jumpRes));
          }
        }
        PluginManager.closePluginView();
        return;
      }

      const openRes = (await PluginFileAPI.openFile(
        target.path,
        page,
      )) as ApiResponse<boolean>;
      if (openRes?.success && openRes.result) {
        await shelfLog('opened with the SDK');
        logWhereTheReaderLanded(target.path, page);
        PluginManager.closePluginView();
        return;
      }
      await shelfLog(`SDK openFile refused (${JSON.stringify(openRes)}); using the intent`);
      // Retain the proven native intent path as a compatibility fallback.
    } catch {
      // Fall through to native navigation below.
    }
  }

  const navigation = requireShelfNavigation();

  if (target.kind === 'note') {
    // Page 0 tells the native side to omit the page extra, so the note
    // editor opens on its own last-used page.
    const nativePage = options?.atLastUsedPage ? 0 : Math.max(1, target.page + 1);
    await navigation.openNoteAfterDelay(target.path, nativePage, OPEN_DELAY_MS);
  } else if (isDocumentKind(target.kind)) {
    if (!navigation.openDocumentAfterDelay) {
      throw new Error(
        'Installed native package is missing document open support. Rebuild and reinstall the plugin.',
      );
    }
    await shelfLog('opened with the document intent');
    await navigation.openDocumentAfterDelay(target.path, OPEN_DELAY_MS);
    logWhereTheReaderLanded(target.path, page);
  } else {
    throw new Error('Direct open supports notes and documents. Use Link for other items.');
  }

  PluginManager.closePluginView();
}

/** Opens a folder in the file manager and closes the plugin panel. */
export async function openShelfFolder(folderPath: string): Promise<void> {
  const navigation = requireShelfNavigation();
  if (!navigation.openFolderAfterDelay) {
    throw new Error(
      'Installed native package is missing folder open support. Rebuild and reinstall the plugin.',
    );
  }
  await navigation.openFolderAfterDelay(folderPath, OPEN_DELAY_MS);
  PluginManager.closePluginView();
}
