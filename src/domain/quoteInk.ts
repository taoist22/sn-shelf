// Handwritten notes on captured quotes, as stored geometry.
//
// The capture screen's pen engine reports strokes in host-view pixels, which
// are 1:1 with note-page pixels (measured 2026-09-18). Shelf stores them
// relative to the ink's own top-left so placement is a plain translation,
// and keeps the RAW engine pressure: mapping it onto a page's pressure range
// depends on the destination, so it happens at placement time.
// No SDK imports here — this file is unit-tested.

export type InkStrokeData = {
  /** [x, y, x, y, …] in px, relative to the ink's top-left. */
  xy: number[];
  /** Raw engine pressure per point (measured 0.001–0.30). */
  press: number[];
};

export type QuoteInk = {
  version: 1;
  width: number;
  height: number;
  lineSpacingPx: number;
  strokes: InkStrokeData[];
};

/** Keeps a quote's ink small enough for the Shelf state file. */
export const MAX_INK_POINTS = 6000;

export type InkFromEngine =
  | {kind: 'empty'}
  | {kind: 'too-large'; points: number}
  | {kind: 'ink'; ink: QuoteInk};

/** Native readStrokes: each stroke flattened as [x, y, press, x, y, press, …]. */
export function inkFromEngine(flatStrokes: number[][], lineSpacingPx: number): InkFromEngine {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let points = 0;
  for (const flat of flatStrokes) {
    for (let i = 0; i + 2 < flat.length; i += 3) {
      minX = Math.min(minX, flat[i]);
      minY = Math.min(minY, flat[i + 1]);
      maxX = Math.max(maxX, flat[i]);
      maxY = Math.max(maxY, flat[i + 1]);
      points += 1;
    }
  }
  if (points === 0) {
    return {kind: 'empty'};
  }
  if (points > MAX_INK_POINTS) {
    return {kind: 'too-large', points};
  }
  const strokes: InkStrokeData[] = [];
  for (const flat of flatStrokes) {
    const xy: number[] = [];
    const press: number[] = [];
    for (let i = 0; i + 2 < flat.length; i += 3) {
      xy.push(Math.round(flat[i] - minX), Math.round(flat[i + 1] - minY));
      press.push(flat[i + 2]);
    }
    if (press.length > 0) {
      strokes.push({xy, press});
    }
  }
  return {
    kind: 'ink',
    ink: {
      version: 1,
      width: Math.max(1, Math.round(maxX - minX)),
      height: Math.max(1, Math.round(maxY - minY)),
      lineSpacingPx,
      strokes,
    },
  };
}

/** Loose shape check for persisted ink; anything else is dropped on load. */
export function isQuoteInk(value: unknown): value is QuoteInk {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const ink = value as Partial<QuoteInk>;
  return (
    ink.version === 1 &&
    typeof ink.width === 'number' &&
    typeof ink.height === 'number' &&
    typeof ink.lineSpacingPx === 'number' &&
    Array.isArray(ink.strokes) &&
    ink.strokes.every(
      stroke =>
        stroke &&
        Array.isArray(stroke.xy) &&
        Array.isArray(stroke.press) &&
        stroke.xy.length === stroke.press.length * 2,
    )
  );
}

/** 1:1 unless the ink is wider than the room available, never enlarged. */
export function inkScale(ink: QuoteInk, maxWidth: number): number {
  return Math.min(1, Math.max(0.1, maxWidth / ink.width));
}

export type PlacedPoint = {x: number; y: number};

/** Page-pixel points for one stroke, with the ink's top-left at `origin`. */
export function placeStroke(
  stroke: InkStrokeData,
  origin: PlacedPoint,
  scale: number,
): PlacedPoint[] {
  const points: PlacedPoint[] = [];
  for (let i = 0; i + 1 < stroke.xy.length; i += 2) {
    points.push({
      x: Math.round(origin.x + stroke.xy[i] * scale),
      y: Math.round(origin.y + stroke.xy[i + 1] * scale),
    });
  }
  return points;
}

export type Range = {min: number; max: number};

export function pressureRange(ink: QuoteInk): Range {
  let min = Infinity;
  let max = -Infinity;
  for (const stroke of ink.strokes) {
    for (const p of stroke.press) {
      min = Math.min(min, p);
      max = Math.max(max, p);
    }
  }
  return Number.isFinite(min) ? {min, max} : {min: 0, max: 0};
}

/** Engine pressure mapped linearly onto the page's range (flat input → top). */
export function mapPressure(value: number, from: Range, to: Range): number {
  const span = from.max - from.min;
  const t = span > 0 ? (value - from.min) / span : 1;
  return Math.round(to.min + Math.min(1, Math.max(0, t)) * (to.max - to.min));
}
