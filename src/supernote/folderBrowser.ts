import {NativeModules} from 'react-native';
import {ensureFileReadPermission} from './pluginPermissions';

export type ShelfFolderEntry = {name: string; path: string; isFolder?: boolean};

type ShelfFolderBridge = {
  getStorageRoots(): Promise<string[]>;
  listFolderEntries(path: string): Promise<ShelfFolderEntry[]>;
  listNoteBrowserEntries?(path: string): Promise<ShelfFolderEntry[]>;
};

const ShelfNavigation = NativeModules.ShelfNavigation as ShelfFolderBridge | undefined;
const INTERNAL_ROOT = '/storage/emulated/0';

export async function listShelfStorageRoots(): Promise<string[]> {
  if (!ShelfNavigation?.getStorageRoots) {
    return [INTERNAL_ROOT];
  }
  try {
    const detected = await ShelfNavigation.getStorageRoots();
    return Array.from(new Set([INTERNAL_ROOT, ...(Array.isArray(detected) ? detected : [])]))
      .filter(path => typeof path === 'string' && path.startsWith('/storage/'));
  } catch {
    return [INTERNAL_ROOT];
  }
}

export async function listShelfFolders(path: string): Promise<ShelfFolderEntry[]> {
  if (!(await ensureFileReadPermission())) {
    throw new Error('File access was not allowed.');
  }
  if (!ShelfNavigation?.listFolderEntries) {
    throw new Error('Installed native package is missing folder browsing support.');
  }
  const entries = await ShelfNavigation.listFolderEntries(path);
  return Array.isArray(entries)
    ? entries.filter(entry => entry?.path && entry?.name).sort((a, b) => a.name.localeCompare(b.name))
    : [];
}

/** Folders first, then .note files, each alphabetical. */
export async function listShelfNotesAndFolders(path: string): Promise<ShelfFolderEntry[]> {
  if (!(await ensureFileReadPermission())) {
    throw new Error('File access was not allowed.');
  }
  if (!ShelfNavigation?.listNoteBrowserEntries) {
    throw new Error('Installed native package is missing note browsing support. Rebuild and reinstall the plugin.');
  }
  const entries = await ShelfNavigation.listNoteBrowserEntries(path);
  return Array.isArray(entries)
    ? entries
        .filter(entry => entry?.path && entry?.name)
        .sort((a, b) =>
          a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1,
        )
    : [];
}
