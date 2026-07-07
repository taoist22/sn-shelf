/** Emitted from index.js whenever the SN Shelf toolbar button is pressed. */
export const SHELF_OPENED_EVENT = 'snshelf:opened';

/** Emitted from index.js when the Capture Quote toolbar button is pressed. */
export const SHELF_CAPTURE_EVENT = 'snshelf:capture';

// The capture button can open the panel before the screen has mounted its
// listeners (Pattern 5); the press is parked here and consumed on mount.
let pendingCapture = false;

export function setPendingCapture(): void {
  pendingCapture = true;
}

export function consumePendingCapture(): boolean {
  const value = pendingCapture;
  pendingCapture = false;
  return value;
}
