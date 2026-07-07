import {NativeModules} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {isDocumentKind, type ShelfTarget} from '../domain/shelfItem';

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
  const navigation = requireShelfNavigation();

  if (target.kind === 'note') {
    // Page 0 tells the native side to omit the page extra, so the note
    // editor opens on its own last-used page.
    const page = options?.atLastUsedPage ? 0 : Math.max(1, target.page + 1);
    await navigation.openNoteAfterDelay(target.path, page, OPEN_DELAY_MS);
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
