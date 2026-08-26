import {NativeModules} from 'react-native';
import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';
import {isDocumentKind, type ShelfTarget} from '../domain/shelfItem';
import {ensureFileReadPermission} from './pluginPermissions';

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

export async function openShelfTarget(
  target: ShelfTarget,
  options?: {atLastUsedPage?: boolean},
): Promise<void> {
  if (!(await ensureFileReadPermission())) {
    throw new Error('File access was not allowed.');
  }

  const page = options?.atLastUsedPage ? -1 : Math.max(0, target.page);

  if (isSdkOpenablePath(target.path)) {
    try {
      const currentRes = (await PluginCommAPI.getCurrentFilePath()) as
        | ApiResponse<string>
        | undefined;
      if (currentRes?.success && currentRes.result === target.path) {
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
        PluginManager.closePluginView();
        return;
      }
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
    await navigation.openDocumentAfterDelay(target.path, OPEN_DELAY_MS);
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
