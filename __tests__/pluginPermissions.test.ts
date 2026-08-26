jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    hasPermission: jest.fn(),
    requestPermission: jest.fn(),
  },
}));

import {beforeEach, expect, it, jest} from '@jest/globals';
import {PluginManager} from 'sn-plugin-lib';
import {
  ensurePluginPermission,
  FILE_READ_PERMISSION,
} from '../src/supernote/pluginPermissions';

const manager = PluginManager as jest.Mocked<typeof PluginManager>;

beforeEach(() => {
  jest.clearAllMocks();
});

it('does not prompt when permission is already granted', async () => {
  manager.hasPermission.mockResolvedValue(1);
  await expect(
    ensurePluginPermission(FILE_READ_PERMISSION, 'read'),
  ).resolves.toBe(true);
  expect(manager.requestPermission).not.toHaveBeenCalled();
});

it('coalesces simultaneous permission prompts', async () => {
  manager.hasPermission.mockResolvedValue(0);
  let resolve!: (value: number) => void;
  manager.requestPermission.mockReturnValue(new Promise(r => (resolve = r)));
  const first = ensurePluginPermission(FILE_READ_PERMISSION, 'first');
  const second = ensurePluginPermission(FILE_READ_PERMISSION, 'second');
  resolve(1);
  await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  expect(manager.requestPermission).toHaveBeenCalledTimes(1);
});
