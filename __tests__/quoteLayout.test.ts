import {describe, expect, it} from '@jest/globals';
import {
  estimateWrappedLines,
  findPlacementBottom,
  type Rect,
} from '../src/domain/quoteLayout';

describe('estimateWrappedLines', () => {
  it('fits short text on one line', () => {
    expect(estimateWrappedLines('a few words', 20)).toBe(1);
  });

  it('wraps whole words, not raw character counts', () => {
    // 'aaaa bbbb cccc' is 14 chars; naive length/10 says 2 lines fit,
    // but 'cccc' cannot share line 2 boundaries: aaaa bbbb=9, cccc→line 2.
    expect(estimateWrappedLines('aaaa bbbb cccc', 10)).toBe(2);
    // A word that would straddle the boundary drags wholly to the next line.
    expect(estimateWrappedLines('aaaaaaaa bbbbbbbb', 10)).toBe(2);
  });

  it('counts explicit newlines and blank lines', () => {
    expect(estimateWrappedLines('one\ntwo', 20)).toBe(2);
    expect(estimateWrappedLines('one\n\ntwo', 20)).toBe(3);
  });

  it('hard-wraps words longer than a line', () => {
    expect(estimateWrappedLines('a'.repeat(120), 50)).toBe(3);
    // Preceding partial line flushes first: 10 chars, then 50+50+20.
    expect(estimateWrappedLines(`${'b'.repeat(10)} ${'a'.repeat(120)}`, 50)).toBe(4);
  });

  it('is defensive about degenerate widths', () => {
    expect(estimateWrappedLines('anything', 0)).toBe(1);
    expect(estimateWrappedLines('', 50)).toBe(1);
  });
});

describe('findPlacementBottom', () => {
  const base = {
    obstacles: [] as Rect[],
    inkBottom: 0,
    boxLeft: 180,
    boxRight: 1140,
    boxHeight: 400,
    startBottom: 2400,
    topLimit: 120,
    gap: 24,
  };

  it('uses the page bottom on an empty page', () => {
    expect(findPlacementBottom(base)).toBe(2400);
  });

  it('stacks above an obstacle in the box column', () => {
    const obstacle = {left: 180, top: 2000, right: 1140, bottom: 2400};
    expect(findPlacementBottom({...base, obstacles: [obstacle]})).toBe(1976);
  });

  it('ignores obstacles outside the box column', () => {
    const rightHalf = {left: 1200, top: 1000, right: 1900, bottom: 2400};
    expect(findPlacementBottom({...base, obstacles: [rightHalf]})).toBe(2400);
  });

  it('never places above the handwriting line', () => {
    // Ink reaches down to 2300; a 400-tall box cannot sit below it.
    expect(findPlacementBottom({...base, inkBottom: 2300})).toBeNull();
    // With shallower ink the box fits underneath.
    expect(findPlacementBottom({...base, inkBottom: 1500})).toBe(2400);
  });

  it('reports full when obstacles leave no band', () => {
    const wall = {left: 0, top: 200, right: 1920, bottom: 2400};
    expect(findPlacementBottom({...base, obstacles: [wall]})).toBeNull();
  });

  it('finds a band between ink above and a placed quote below', () => {
    const placed = {left: 180, top: 1800, right: 1140, bottom: 2400};
    const result = findPlacementBottom({
      ...base,
      obstacles: [placed],
      inkBottom: 900,
    });
    expect(result).toBe(1776);
  });
});
