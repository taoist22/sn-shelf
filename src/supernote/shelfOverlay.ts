import {DeviceEventEmitter, NativeModules, type EmitterSubscription} from 'react-native';
import {shelfLog} from './shelfLog';

// Shelf's floating button (ShelfOverlayModule). Finger only — pen touches fall through to
// the page — with tap and long press told apart natively, because JS timers stop while the
// panel is hidden.

export type OverlayMenuItem = {
  id: string;
  label: string;
  /** A disabled row explains itself and reports nothing when touched. */
  enabled?: boolean;
};

type OverlayBridge = {
  show(): Promise<boolean>;
  hide(): Promise<boolean>;
  isShowing(): Promise<boolean>;
  showMenu(items: OverlayMenuItem[]): Promise<boolean>;
  hideMenu(): Promise<boolean>;
};

const ShelfOverlay = NativeModules.ShelfOverlay as OverlayBridge | undefined;

export const OVERLAY_TAP_EVENT = 'onShelfOverlayTap';
export const OVERLAY_LONG_PRESS_EVENT = 'onShelfOverlayLongPress';
export const OVERLAY_MENU_EVENT = 'onShelfOverlayMenu';

/** False when the installed native package predates the button. */
export function overlayAvailable(): boolean {
  return Boolean(ShelfOverlay?.show);
}

export async function showOverlayButton(): Promise<boolean> {
  if (!ShelfOverlay?.show) {
    return false;
  }
  try {
    return await ShelfOverlay.show();
  } catch (error) {
    await shelfLog(`overlay: could not show the button (${String(error)})`);
    return false;
  }
}

export async function hideOverlayButton(): Promise<void> {
  try {
    await ShelfOverlay?.hide?.();
  } catch {
    // Hiding must never fail loudly: the button is a convenience.
  }
}

export async function showOverlayMenu(items: OverlayMenuItem[]): Promise<void> {
  try {
    await ShelfOverlay?.showMenu?.(items);
  } catch (error) {
    await shelfLog(`overlay: could not show the menu (${String(error)})`);
  }
}

export async function hideOverlayMenu(): Promise<void> {
  try {
    await ShelfOverlay?.hideMenu?.();
  } catch {
    // as above
  }
}

export function onOverlayEvent(
  event: string,
  handler: (payload?: {id?: string}) => void,
): EmitterSubscription {
  return DeviceEventEmitter.addListener(event, handler);
}
