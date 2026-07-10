import {NativeModules} from 'react-native';

type ShelfTextMetricsModule = {
  measureTextLayout(options: {
    text: string;
    width: number;
    fontSize: number;
  }): Promise<{layoutHeight?: number; lineCount?: number} | null>;
};

const ShelfTextMetrics = NativeModules.ShelfTextMetrics as
  | ShelfTextMetricsModule
  | undefined;

/**
 * Horizontal inset the reader applies to text inside a text-box frame —
 * measure against (frameWidth - inset) or wraps come out one word early.
 * Calibrated by the textboxHelper project (device-tested constant).
 */
export const TEXT_FRAME_INSET = 30;

export type PlacedTextMeasurement = {
  /** StaticLayout's own height — smaller line spacing than the reader's. */
  layoutHeight: number;
  /** Exact wrap count — probe-confirmed identical to the reader's. */
  lineCount: number;
};

/**
 * Measures text with Android's layout engine. Probe findings (2026-07-07):
 * StaticLayout WRAPS exactly like the reader (line counts match) but uses
 * a smaller line height (~1.18×fs vs the reader's ~1.33×fs) — so callers
 * should combine lineCount with the device-calibrated line height rather
 * than trusting layoutHeight. Null when the module is missing or fails.
 */
export async function measurePlacedText(
  text: string,
  frameWidth: number,
  fontSize: number,
): Promise<PlacedTextMeasurement | null> {
  if (!ShelfTextMetrics?.measureTextLayout) {
    return null;
  }
  try {
    const result = await ShelfTextMetrics.measureTextLayout({
      text,
      width: Math.max(24, frameWidth - TEXT_FRAME_INSET),
      fontSize,
    });
    const layoutHeight = result?.layoutHeight;
    const lineCount = result?.lineCount;
    if (
      typeof layoutHeight !== 'number' ||
      typeof lineCount !== 'number' ||
      layoutHeight <= 0 ||
      lineCount <= 0
    ) {
      return null;
    }
    return {layoutHeight, lineCount};
  } catch {
    return null;
  }
}
