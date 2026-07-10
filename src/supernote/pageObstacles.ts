import {PluginFileAPI} from 'sn-plugin-lib';
import type {Rect} from '../domain/quoteLayout';

export type ObstacleScan = {
  /**
   * Precise pixel rects: text boxes, titles, links, pictures, and — via
   * `contoursSrc` — real per-stroke ink bounding boxes.
   *
   * History: a first version used each stroke's `maxX`/`maxY` (EMR max
   * corner) as a cheap proxy for its bounds. A device probe (2026-07-07)
   * proved that field returns the PAGE's absolute EMR maximum for every
   * stroke, not a per-stroke value — six visibly distinct strokes all
   * reported the identical corner — which blocked nearly the entire page
   * regardless of where ink actually was. `contoursSrc` replaced it after
   * a second probe confirmed distinct, small (≤39-point) per-stroke
   * bounding boxes already in pixel coordinates. See
   * references/stroke-geometry-for-collision-avoidance.md for both
   * findings.
   */
  rects: Rect[];
};

type ApiResponse<T> = {
  success?: boolean;
  result?: T;
  error?: {message?: string};
};

type ContourAccessor = {
  size(): Promise<number>;
  get(index: number): Promise<{x?: number; y?: number}[] | null>;
};

// Denser pages are too expensive to scan — getElements materializes native
// trail caches per call and can hit error 206 on handwriting-heavy pages.
// See ~/supernote-plugins/references/get-elements-link-aggregation-warning.md.
const MAX_SCAN_ELEMENTS = 600;

// Each stroke's real bounding box costs extra native round trips beyond the
// initial getElements() batch (one contoursSrc.size() + one get() per
// contour). Device-confirmed cheap per call (≤39 points, 1-2 contours per
// stroke seen), but the ROUND-TRIP COUNT on an ink-dense page is untested —
// cap total contour reads per scan so a dense page degrades (fewer strokes
// get real bounds) instead of stalling the scan.
const MAX_CONTOUR_READS = 400;
const MAX_CONTOURS_PER_STROKE = 8;

/**
 * One targeted, current-page scan for collision-aware quote placement.
 * Reads only cheap fields (never the stroke point accessors), recycles every
 * element immediately, and returns null on any failure or overly dense page
 * so the caller can fall back to blind cursor placement.
 */
export async function scanPageObstacles(
  path: string,
  page: number,
): Promise<ObstacleScan | null> {
  try {
    // NB: param order differs between these two calls — counts takes the
    // path first, getElements takes the page first (lib 0.1.43 typings).
    const countRes = (await PluginFileAPI.getElementCounts(
      path,
      page,
    )) as ApiResponse<number>;
    if (
      !countRes?.success ||
      typeof countRes.result !== 'number' ||
      countRes.result > MAX_SCAN_ELEMENTS
    ) {
      return null;
    }
    if (countRes.result === 0) {
      return {rects: []};
    }

    const elementsRes = (await PluginFileAPI.getElements(
      page,
      path,
    )) as ApiResponse<unknown[]>;
    if (!elementsRes?.success || !Array.isArray(elementsRes.result)) {
      return null;
    }

    const rects: Rect[] = [];
    const seenUuids = new Set<string>();
    let contourReadsLeft = MAX_CONTOUR_READS;
    // Sequential on purpose: parallel native calls flood the bridge.
    for (const entry of elementsRes.result) {
      const element = entry as {
        uuid?: string;
        type?: number;
        recycle?: () => Promise<void>;
        contoursSrc?: ContourAccessor;
      };
      try {
        // Device-observed (2026-07-09): getElements can return the SAME
        // element more than once (2x, then 3x, across separate calls on an
        // untouched, never-moved textbox) — likely the native-side element
        // cache the SDK warns about, see
        // references/get-elements-link-aggregation-warning.md. Duplicate
        // identical rects don't break the placement math,
        // but they DO waste the contour-read budget on stroke duplicates,
        // so skip anything with a uuid we've already processed THIS scan,
        // before spending any extra reads on it.
        if (element?.uuid) {
          if (seenUuids.has(element.uuid)) {
            continue;
          }
          seenUuids.add(element.uuid);
        }
        const rect = elementRect(element);
        if (rect) {
          rects.push(rect);
        } else if (
          element?.type === 0 &&
          element.contoursSrc &&
          contourReadsLeft > 0
        ) {
          const stroke = await readStrokeRect(element.contoursSrc, contourReadsLeft);
          contourReadsLeft -= stroke.reads;
          if (stroke.rect) {
            rects.push(stroke.rect);
          }
        }
      } finally {
        try {
          await element?.recycle?.();
        } catch {
          // Best effort; a missed recycle is the platform's leak, not fatal.
        }
      }
    }
    return {rects};
  } catch {
    return null;
  }
}

/**
 * Merges a stroke's contours (pixel-coordinate points, device-confirmed
 * cheap) into one bounding rect, capped per stroke and against the
 * scan-wide read budget so a single dense stroke can't exhaust it alone.
 */
async function readStrokeRect(
  accessor: ContourAccessor,
  readsAvailable: number,
): Promise<{rect: Rect | null; reads: number}> {
  const contourCount = await accessor.size();
  const cap = Math.min(contourCount, MAX_CONTOURS_PER_STROKE, readsAvailable);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let reads = 0;
  for (let i = 0; i < cap; i += 1) {
    const points = await accessor.get(i);
    reads += 1;
    for (const point of points ?? []) {
      if (Number.isFinite(point.x)) {
        minX = Math.min(minX, point.x as number);
        maxX = Math.max(maxX, point.x as number);
      }
      if (Number.isFinite(point.y)) {
        minY = Math.min(minY, point.y as number);
        maxY = Math.max(maxY, point.y as number);
      }
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {rect: null, reads};
  }
  return {rect: {left: minX, top: minY, right: maxX, bottom: maxY}, reads};
}

function elementRect(element: unknown): Rect | null {
  const candidate = element as {
    textBox?: {textRect?: Rect};
    picture?: {rect?: Rect};
    title?: {X?: number; Y?: number; width?: number; height?: number};
    link?: {X?: number; Y?: number; width?: number; height?: number};
  } | null;
  if (!candidate) {
    return null;
  }
  const box = candidate.textBox?.textRect ?? candidate.picture?.rect;
  if (
    box &&
    [box.left, box.top, box.right, box.bottom].every(Number.isFinite)
  ) {
    return {left: box.left, top: box.top, right: box.right, bottom: box.bottom};
  }
  const cornerBox = candidate.title ?? candidate.link;
  if (
    cornerBox &&
    Number.isFinite(cornerBox.X) &&
    Number.isFinite(cornerBox.Y)
  ) {
    const x = cornerBox.X as number;
    const y = cornerBox.Y as number;
    return {
      left: x,
      top: y,
      right: x + (cornerBox.width ?? 0),
      bottom: y + (cornerBox.height ?? 0),
    };
  }
  return null;
}
