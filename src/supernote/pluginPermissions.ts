import {PluginManager} from 'sn-plugin-lib';

export const FILE_READ_PERMISSION = 'plugin.permission.FILE:READ';
export const FILE_WRITE_PERMISSION = 'plugin.permission.FILE:WRITE';
export const FILE_DELETE_PERMISSION = 'plugin.permission.FILE:DELETE';

const pendingRequests = new Map<string, Promise<boolean>>();

export async function ensurePluginPermission(
  permission: string,
  description: string,
): Promise<boolean> {
  const manager = PluginManager as typeof PluginManager & {
    hasPermission?: (name: string) => Promise<number>;
    requestPermission?: (name: string, desc?: string) => Promise<number>;
  };

  if (
    typeof manager.hasPermission !== 'function' ||
    typeof manager.requestPermission !== 'function'
  ) {
    return true;
  }

  const pending = pendingRequests.get(permission);
  if (pending) {
    return pending;
  }

  const request = (async () => {
    try {
      if (Number(await manager.hasPermission!(permission)) > 0) {
        return true;
      }
      return (
        Number(await manager.requestPermission!(permission, description)) > 0
      );
    } catch {
      return false;
    }
  })();

  pendingRequests.set(permission, request);
  try {
    return await request;
  } finally {
    pendingRequests.delete(permission);
  }
}

export function ensureFileReadPermission(): Promise<boolean> {
  return ensurePluginPermission(
    FILE_READ_PERMISSION,
    'Allow Shelf to browse, open, and read metadata from your selected files.',
  );
}

export function ensureFileWritePermission(): Promise<boolean> {
  return ensurePluginPermission(
    FILE_WRITE_PERMISSION,
    'Allow Shelf to create cached previews for pinned notes and to add pages to PDFs you choose.',
  );
}

export function ensureFileDeletePermission(): Promise<boolean> {
  return ensurePluginPermission(
    FILE_DELETE_PERMISSION,
    'Allow Shelf to remove a shelf-quote text file after it is safely imported.',
  );
}
