// Inserts a quote's stored handwriting into the OPEN note as real strokes.
//
// Recipe verified on device 2026-09-18 with sn-strokeprobe (plugin-scope
// memory reference_plugin_stroke_insertion): createElement(0), fill the
// stroke accessors with EMR points + pressures, insertPageElements, save.
// Stroke style is copied from an existing stroke on the page when there is
// one (the proven path); otherwise from the current pen, with the values
// measured on that run as the fallback.

import {PluginCommAPI, PluginFileAPI, PointUtils} from 'sn-plugin-lib';
import {
  mapPressure,
  placeStroke,
  pressureRange,
  type PlacedPoint,
  type QuoteInk,
  type Range,
} from '../domain/quoteInk';

type ApiResponse<T> = {
  success?: boolean;
  result?: T;
  error?: {code?: number; message?: string};
};

type PageSize = {width: number; height: number};

type StrokeStyle = {
  penType: number;
  penColor: number;
  thickness: number;
  maxX: number;
  maxY: number;
  pressure: Range;
  flagPerPoint: boolean;
};

// Measured on the Manta, 2026-09-18: a real pen stroke stored thickness 1200
// and pressures 199–1119.
const FALLBACK_THICKNESS = 1200;
const FALLBACK_PRESSURE: Range = {min: 199, max: 1119};
const FALLBACK_PEN_TYPE = 10;

const styleCache = new Map<string, StrokeStyle>();

/** Called when the panel reopens, alongside the obstacle-scan reset. */
export function invalidateStrokeStyles(): void {
  styleCache.clear();
}

async function styleFromPage(notePath: string, page: number): Promise<StrokeStyle | null> {
  const res = (await PluginFileAPI.getElements(page, notePath)) as ApiResponse<any[]>;
  if (!res?.success || !Array.isArray(res.result)) {
    return null;
  }
  try {
    const element = res.result.find(el => el?.type === 0 && el?.stroke);
    if (!element) {
      return null;
    }
    const stroke = element.stroke;
    const nPoints: number = await stroke.points.size();
    const nPress: number = await stroke.pressures.size();
    const nFlag: number = await stroke.flagDraw.size();
    const pressures: number[] =
      nPress > 0 ? await stroke.pressures.getRange(0, Math.min(nPress, 400)) : [];
    const min = pressures.length ? Math.min(...pressures) : FALLBACK_PRESSURE.min;
    const max = pressures.length ? Math.max(...pressures) : FALLBACK_PRESSURE.max;
    return {
      penType: stroke.penType,
      penColor: stroke.penColor,
      thickness: element.thickness,
      maxX: element.maxX,
      maxY: element.maxY,
      pressure: max > min ? {min, max} : FALLBACK_PRESSURE,
      flagPerPoint: nFlag > 0 && nFlag === nPoints,
    };
  } finally {
    for (const el of res.result) {
      try {
        await el?.recycle?.();
      } catch {
        // best effort — unrecycled elements accumulate in the native cache
      }
    }
  }
}

async function styleFromPen(pageSize: PageSize): Promise<StrokeStyle> {
  let penType = FALLBACK_PEN_TYPE;
  let penColor = 0;
  try {
    const res = (await PluginCommAPI.getPenInfo()) as ApiResponse<{type: number; color: number}>;
    if (res?.success && res.result) {
      penType = typeof res.result.type === 'number' ? res.result.type : penType;
      penColor = typeof res.result.color === 'number' ? res.result.color : penColor;
    }
  } catch {
    // keep fallbacks
  }
  return {
    penType,
    penColor,
    thickness: FALLBACK_THICKNESS,
    maxX: PointUtils.getRealMaxX(pageSize),
    maxY: PointUtils.getRealMaxY(pageSize),
    pressure: FALLBACK_PRESSURE,
    flagPerPoint: true,
  };
}

async function resolveStyle(notePath: string, page: number, pageSize: PageSize): Promise<StrokeStyle> {
  const key = `${notePath}#${page}`;
  const cached = styleCache.get(key);
  if (cached) {
    return cached;
  }
  let style: StrokeStyle | null = null;
  try {
    style = await styleFromPage(notePath, page);
  } catch {
    style = null;
  }
  const resolved = style ?? (await styleFromPen(pageSize));
  styleCache.set(key, resolved);
  return resolved;
}

async function buildStroke(
  points: PlacedPoint[],
  pressures: number[],
  style: StrokeStyle,
  page: number,
  pageSize: PageSize,
): Promise<any> {
  const res = (await PluginCommAPI.createElement(0)) as ApiResponse<any>;
  if (!res?.success || !res.result?.stroke) {
    throw new Error(res?.error?.message ?? 'Could not create a stroke element');
  }
  const el = res.result;
  el.pageNum = page;
  el.layerNum = 0;
  el.thickness = style.thickness;
  el.maxX = style.maxX;
  el.maxY = style.maxY;
  el.stroke.penType = style.penType;
  el.stroke.penColor = style.penColor;
  // Sequential on purpose: parallel bridge calls freeze the device.
  for (let i = 0; i < points.length; i++) {
    await el.stroke.points.add(i, PointUtils.androidPoint2Emr(points[i], pageSize));
    await el.stroke.pressures.add(i, pressures[i]);
    if (style.flagPerPoint) {
      await el.stroke.flagDraw.add(i, true);
    }
  }
  return el;
}

/**
 * Inserts `ink` with its top-left at `origin` (page px), scaled by `scale`.
 * Returns an error message, or null on success. Never throws.
 */
export async function insertInkStrokes(
  ink: QuoteInk,
  origin: PlacedPoint,
  scale: number,
  notePath: string,
  page: number,
  pageSize: PageSize,
  onProgress?: (done: number, total: number) => void,
): Promise<string | null> {
  const elements: any[] = [];
  try {
    const style = await resolveStyle(notePath, page, pageSize);
    const from = pressureRange(ink);
    const total = ink.strokes.length;
    for (const [index, stroke] of ink.strokes.entries()) {
      onProgress?.(index, total);
      const points = placeStroke(stroke, origin, scale);
      const pressures = stroke.press.map(p => mapPressure(p, from, style.pressure));
      elements.push(await buildStroke(points, pressures, style, page, pageSize));
    }
    onProgress?.(total, total);
    const res = (await PluginCommAPI.insertPageElements(elements, page, null)) as ApiResponse<boolean>;
    if (!res?.success) {
      return res?.error?.message ?? 'The note did not accept the handwriting.';
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    for (const el of elements) {
      try {
        await el?.recycle?.();
      } catch {
        // best effort
      }
    }
  }
}
