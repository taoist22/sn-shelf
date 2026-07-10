export type Rect = {left: number; top: number; right: number; bottom: number};

/**
 * Word-aware line estimate for a fixed-width text frame. The plugin has no
 * font metrics, so charsPerLine is itself an estimate — but simulating the
 * wrap word by word (a word that doesn't fit drags wholly to the next line)
 * and honoring explicit newlines removes the systematic under-count that
 * made placed frames too short, which the reader then "fixed" by shrinking
 * the font on the next re-layout.
 */
export function estimateWrappedLines(
  text: string,
  charsPerLine: number,
): number {
  if (charsPerLine <= 0) {
    return 1;
  }
  let total = 0;
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      total += 1; // A blank line keeps its height.
      continue;
    }
    let lines = 1;
    let used = 0;
    for (const word of words) {
      const needed = used === 0 ? word.length : used + 1 + word.length;
      if (needed <= charsPerLine) {
        used = needed;
        continue;
      }
      if (word.length <= charsPerLine) {
        lines += 1;
        used = word.length;
        continue;
      }
      // A word longer than the line hard-wraps across full lines.
      if (used > 0) {
        lines += 1;
      }
      lines += Math.ceil(word.length / charsPerLine) - 1;
      used = word.length % charsPerLine || charsPerLine;
    }
    total += lines;
  }
  return Math.max(1, total);
}

export type PlacementParams = {
  /** Known-precise pixel rects on the page (text boxes, titles, links…). */
  obstacles: Rect[];
  /** Lowest pixel row handwriting reaches; 0 when the page has no ink. */
  inkBottom: number;
  boxLeft: number;
  boxRight: number;
  boxHeight: number;
  /** Where the bottom-up search starts (page bottom margin). */
  startBottom: number;
  /** Highest allowed top edge (page top margin). */
  topLimit: number;
  gap: number;
};

/**
 * Largest obstacle-free vertical run in the box's column, in pixels — used
 * to tell the user HOW MUCH room exists when a quote doesn't fit.
 */
export function largestClearBand(params: {
  obstacles: Rect[];
  boxLeft: number;
  boxRight: number;
  startBottom: number;
  topLimit: number;
}): number {
  const spans = params.obstacles
    .filter(
      obstacle =>
        obstacle.left < params.boxRight &&
        obstacle.right > params.boxLeft &&
        obstacle.bottom > params.topLimit &&
        obstacle.top < params.startBottom,
    )
    .map(obstacle => ({
      top: Math.max(obstacle.top, params.topLimit),
      bottom: Math.min(obstacle.bottom, params.startBottom),
    }))
    .sort((a, b) => a.top - b.top);
  let best = 0;
  let cursor = params.topLimit;
  for (const span of spans) {
    if (span.top > cursor) {
      best = Math.max(best, span.top - cursor);
    }
    cursor = Math.max(cursor, span.bottom);
  }
  return Math.max(best, params.startBottom - cursor);
}

/**
 * Finds the lowest bottom edge for a box that clears every obstacle and sits
 * entirely below the handwriting, searching bottom-up. Returns null when the
 * page has no clear band — the caller reports "page full" rather than ever
 * placing on top of existing content.
 */
export function findPlacementBottom(params: PlacementParams): number | null {
  const {obstacles, inkBottom, boxLeft, boxRight, boxHeight} = params;
  let bottom = params.startBottom;
  // Each conflict moves the candidate strictly upward; the guard only backs
  // up the proof against a degenerate obstacle list.
  for (let guard = 0; guard < 200; guard += 1) {
    const top = bottom - boxHeight;
    if (top < params.topLimit || (inkBottom > 0 && top < inkBottom + params.gap)) {
      return null;
    }
    const conflicts = obstacles.filter(
      obstacle =>
        obstacle.left < boxRight &&
        obstacle.right > boxLeft &&
        obstacle.top < bottom &&
        obstacle.bottom > top,
    );
    if (conflicts.length === 0) {
      return bottom;
    }
    bottom = Math.min(...conflicts.map(obstacle => obstacle.top)) - params.gap;
  }
  return null;
}
