jest.mock('../src/supernote/pluginPermissions', () => ({
  ensureFileReadPermission: jest.fn(),
}));

import {beforeEach, describe, expect, it, jest} from '@jest/globals';
import {NativeModules} from 'react-native';
import {ensureFileReadPermission} from '../src/supernote/pluginPermissions';

const permission = ensureFileReadPermission as jest.MockedFunction<
  typeof ensureFileReadPermission
>;

const bridge = {
  getStorageRoots: jest.fn(async (): Promise<string[]> => []),
  listFolderEntries: jest.fn(
    async (_path: string): Promise<Array<{name: string; path: string}>> => [],
  ),
  listNoteBrowserEntries: jest.fn(
    async (
      _path: string,
    ): Promise<Array<{name: string; path: string; isFolder: boolean}>> => [],
  ),
};

NativeModules.ShelfNavigation = bridge;

const {
  listShelfFolders,
  listShelfNotesAndFolders,
  listShelfStorageRoots,
} = require('../src/supernote/folderBrowser') as typeof import('../src/supernote/folderBrowser');

beforeEach(() => {
  jest.clearAllMocks();
  permission.mockResolvedValue(true);
});

describe('listShelfStorageRoots', () => {
  it('includes internal storage and detected SD volumes once', async () => {
    bridge.getStorageRoots.mockResolvedValue([
      '/storage/emulated/0',
      '/storage/1234-ABCD',
      '/storage/1234-ABCD',
    ]);
    await expect(listShelfStorageRoots()).resolves.toEqual([
      '/storage/emulated/0',
      '/storage/1234-ABCD',
    ]);
  });

  it('falls back to internal storage when detection fails', async () => {
    bridge.getStorageRoots.mockRejectedValue(new Error('unavailable'));
    await expect(listShelfStorageRoots()).resolves.toEqual([
      '/storage/emulated/0',
    ]);
  });
});

describe('listShelfFolders', () => {
  it('filters malformed entries and sorts folder names', async () => {
    bridge.listFolderEntries.mockResolvedValue([
      {name: 'Zulu', path: '/storage/emulated/0/Zulu'},
      {name: '', path: '/storage/emulated/0/Bad'},
      {name: 'Alpha', path: '/storage/emulated/0/Alpha'},
    ]);
    await expect(listShelfFolders('/storage/emulated/0')).resolves.toEqual([
      {name: 'Alpha', path: '/storage/emulated/0/Alpha'},
      {name: 'Zulu', path: '/storage/emulated/0/Zulu'},
    ]);
  });

  it('does not call native browsing when file permission is denied', async () => {
    permission.mockResolvedValue(false);
    await expect(listShelfFolders('/storage/emulated/0')).rejects.toThrow(
      'File access was not allowed.',
    );
    expect(bridge.listFolderEntries).not.toHaveBeenCalled();
  });
});

describe('listShelfNotesAndFolders', () => {
  it('lists folders first, then notes, each alphabetical', async () => {
    bridge.listNoteBrowserEntries.mockResolvedValue([
      {name: 'b.note', path: '/n/b.note', isFolder: false},
      {name: 'Zulu', path: '/n/Zulu', isFolder: true},
      {name: 'a.note', path: '/n/a.note', isFolder: false},
      {name: 'Alpha', path: '/n/Alpha', isFolder: true},
    ]);
    const entries = await listShelfNotesAndFolders('/n');
    expect(entries.map(entry => entry.name)).toEqual(['Alpha', 'Zulu', 'a.note', 'b.note']);
  });

  it('does not call native browsing when file permission is denied', async () => {
    permission.mockResolvedValue(false);
    await expect(listShelfNotesAndFolders('/n')).rejects.toThrow(
      'File access was not allowed.',
    );
    expect(bridge.listNoteBrowserEntries).not.toHaveBeenCalled();
  });
});
