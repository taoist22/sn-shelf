import {PluginFileAPI, PointUtils} from 'sn-plugin-lib';
import type {Rect} from '../domain/quoteLayout';

export type ObstacleScan = {
  /** Precise pixel rects: text boxes, titles, links, pictures. */
  rects: Rect[];
  /** Lowest pixel row any handwriting stroke reaches; 0 = no ink seen. */
  inkBottom: number;
};

type ApiResponse<T> = {
  success?: boolean;
  result?: T;
  error?: {message?: string};
};

// Denser pages are too expensive to scan — getElements materializes native
// trail caches per call and can hit error 206 on handwriting-heavy pages.
// See ~/supernote-plugins/references/get-elements-link-aggregation-warning.md.
const MAX_SCAN_ELEMENTS = 600;

/**
 * One targeted, current-page scan for collision-aware quote placement.
 * Reads only cheap fields (never the stroke point accessors), recycles every
 * element immediately, and returns null on any failure or overly dense page
 * so the caller can fall back to blind cursor placement.
 */
export async function scanPageObstacles(
  path: string,
  page: number,
  pageSize: {width: number; height: number},
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
      return {rects: [], inkBottom: 0};
    }

    const elementsRes = (await PluginFileAPI.getElements(
      page,
      path,
    )) as ApiResponse<unknown[]>;
    if (!elementsRes?.success || !Array.isArray(elementsRes.result)) {
      return null;
    }

    const rects: Rect[] = [];
    let inkBottom = 0;
    // Sequential on purpose: parallel native calls flood the bridge.
    for (const entry of elementsRes.result) {
      const element = entry as {
        type?: number;
        maxX?: number;
        maxY?: number;
        recycle?: () => Promise<void>;
      };
      try {
        const rect = elementRect(element);
        if (rect) {
          rects.push(rect);
        } else if (
          element?.type === 0 &&
          Number.isFinite(element.maxX) &&
          Number.isFinite(element.maxY)
        ) {
          // Strokes expose only their EMR max corner without touching the
          // heavy point accessors. Assumption under device test: converting
          // that corner yields the stroke's LOWEST pixel row. If placements
          // ever land on ink, this mapping is flipped — revisit here.
          const corner = (await PointUtils.emrPoint2Android(
            {x: element.maxX as number, y: element.maxY as number},
            pageSize,
          )) as {x?: number; y?: number} | null;
          if (corner && Number.isFinite(corner.y)) {
            inkBottom = Math.max(inkBottom, corner.y as number);
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
    return {rects, inkBottom};
  } catch {
    return null;
  }
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
