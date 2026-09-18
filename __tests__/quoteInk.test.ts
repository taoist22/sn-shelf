import {describe, expect, it} from '@jest/globals';
import {
  MAX_INK_POINTS,
  inkFromEngine,
  inkScale,
  isQuoteInk,
  mapPressure,
  placeStroke,
  pressureRange,
  type QuoteInk,
} from '../src/domain/quoteInk';

function ink(): QuoteInk {
  const result = inkFromEngine(
    [
      [500, 300, 0.1, 700, 340, 0.2],
      [520, 380, 0.3],
    ],
    94,
  );
  if (result.kind !== 'ink') {
    throw new Error('expected ink');
  }
  return result.ink;
}

describe('inkFromEngine', () => {
  it('stores strokes relative to the ink top-left with raw pressure', () => {
    const value = ink();
    expect(value.width).toBe(200);
    expect(value.height).toBe(80);
    expect(value.strokes[0]).toEqual({xy: [0, 0, 200, 40], press: [0.1, 0.2]});
    expect(value.strokes[1]).toEqual({xy: [20, 80], press: [0.3]});
    expect(value.lineSpacingPx).toBe(94);
  });

  it('reports empty ink', () => {
    expect(inkFromEngine([], 94)).toEqual({kind: 'empty'});
    expect(inkFromEngine([[1, 2]], 94)).toEqual({kind: 'empty'});
  });

  it('refuses ink over the point cap instead of truncating it', () => {
    const flat = Array.from({length: (MAX_INK_POINTS + 1) * 3}, (_, i) => i);
    expect(inkFromEngine([flat], 94)).toEqual({kind: 'too-large', points: MAX_INK_POINTS + 1});
  });
});

describe('isQuoteInk', () => {
  it('accepts stored ink and rejects malformed data', () => {
    expect(isQuoteInk(JSON.parse(JSON.stringify(ink())))).toBe(true);
    expect(isQuoteInk({...ink(), version: 2})).toBe(false);
    expect(isQuoteInk({...ink(), strokes: [{xy: [1, 2, 3], press: [1]}]})).toBe(false);
    expect(isQuoteInk(null)).toBe(false);
  });
});

describe('placement', () => {
  it('translates 1:1 when the ink fits', () => {
    expect(inkScale(ink(), 1000)).toBe(1);
    expect(placeStroke(ink().strokes[0], {x: 180, y: 900}, 1)).toEqual([
      {x: 180, y: 900},
      {x: 380, y: 940},
    ]);
  });

  it('shrinks ink wider than the room, never enlarges', () => {
    expect(inkScale(ink(), 100)).toBe(0.5);
    expect(placeStroke(ink().strokes[0], {x: 0, y: 0}, 0.5)[1]).toEqual({x: 100, y: 20});
  });
});

describe('pressure', () => {
  it('maps the engine range onto the page range', () => {
    const from = pressureRange(ink());
    expect(from.min).toBeCloseTo(0.1);
    expect(from.max).toBeCloseTo(0.3);
    const to = {min: 199, max: 1119};
    expect(mapPressure(0.1, from, to)).toBe(199);
    expect(mapPressure(0.3, from, to)).toBe(1119);
    expect(mapPressure(0.2, from, to)).toBe(659);
  });
});
