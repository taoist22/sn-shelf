import {NativeModules} from 'react-native';

type ShelfClipboardModule = {
  setText(text: string): Promise<boolean>;
};

const ShelfClipboard = NativeModules.ShelfClipboard as
  | ShelfClipboardModule
  | undefined;

/** Puts text on the system clipboard; false when unavailable. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!ShelfClipboard?.setText) {
    return false;
  }
  try {
    return (await ShelfClipboard.setText(text)) === true;
  } catch {
    return false;
  }
}
