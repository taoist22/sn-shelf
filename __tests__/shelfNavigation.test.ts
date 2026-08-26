jest.mock('sn-plugin-lib', () => ({
  PluginCommAPI: {
    getCurrentFilePath: jest.fn(),
    jumpToPage: jest.fn(),
  },
  PluginFileAPI: {openFile: jest.fn()},
  PluginManager: {closePluginView: jest.fn()},
}));

jest.mock('../src/supernote/pluginPermissions', () => ({
  ensureFileReadPermission: jest.fn(),
}));

import {beforeEach, describe, expect, it, jest} from '@jest/globals';
import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';
import {makeShelfTarget} from '../src/domain/shelfItem';
import {
  isSdkOpenablePath,
  openShelfTarget,
} from '../src/supernote/nativeShelfNavigation';
import {ensureFileReadPermission} from '../src/supernote/pluginPermissions';

const comm = PluginCommAPI as jest.Mocked<typeof PluginCommAPI>;
const files = PluginFileAPI as jest.Mocked<typeof PluginFileAPI>;
const manager = PluginManager as jest.Mocked<typeof PluginManager>;
const permission = ensureFileReadPermission as jest.MockedFunction<
  typeof ensureFileReadPermission
>;

beforeEach(() => {
  jest.clearAllMocks();
  permission.mockResolvedValue(true);
  comm.getCurrentFilePath.mockResolvedValue({success: true, result: '/Note/Other.note'});
  comm.jumpToPage.mockResolvedValue({success: true, result: true} as any);
  files.openFile.mockResolvedValue({success: true, result: true});
});

describe('SDK-openable paths', () => {
  it('covers every format supported by the current SDK', () => {
    for (const extension of ['note', 'pdf', 'epub', 'cbz', 'xps', 'fb2']) {
      expect(isSdkOpenablePath(`/Document/file.${extension}`)).toBe(true);
    }
    expect(isSdkOpenablePath('/Document/file.docx')).toBe(false);
  });
});

describe('openShelfTarget', () => {
  it('opens a different file at the pinned zero-based page', async () => {
    const target = makeShelfTarget('/Document/Book.pdf', 8);
    await openShelfTarget(target);
    expect(files.openFile).toHaveBeenCalledWith(target.path, 8);
    expect(manager.closePluginView).toHaveBeenCalled();
  });

  it('uses -1 when the caller requests the last-used page', async () => {
    const target = makeShelfTarget('/Note/Working.note', 0);
    await openShelfTarget(target, {atLastUsedPage: true});
    expect(files.openFile).toHaveBeenCalledWith(target.path, -1);
  });

  it('jumps without reopening when the target file is already current', async () => {
    const target = makeShelfTarget('/Document/Book.epub', 3);
    comm.getCurrentFilePath.mockResolvedValue({success: true, result: target.path});
    await openShelfTarget(target);
    expect(comm.jumpToPage).toHaveBeenCalledWith(3);
    expect(files.openFile).not.toHaveBeenCalled();
  });

  it('stops before navigation when file access is denied', async () => {
    permission.mockResolvedValue(false);
    await expect(
      openShelfTarget(makeShelfTarget('/Document/Book.pdf', 0)),
    ).rejects.toThrow('File access was not allowed.');
    expect(files.openFile).not.toHaveBeenCalled();
  });
});
