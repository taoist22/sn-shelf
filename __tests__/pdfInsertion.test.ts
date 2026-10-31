import {describe, expect, it} from '@jest/globals';
import {
  MAX_INSERT_PAGES,
  MAX_TEMPLATES,
  clampInsertCount,
  isImageFile,
  parseTemplateSize,
  rememberTemplate,
  TEMPLATE_SIZES,
  templateScale,
  templateSizeLabel,
  firstInsertedIndex,
  pageAfterInsert,
  pageAfterUndo,
  shiftedMarkedPages,
} from '../src/domain/pdfInsertion';

describe('insert position', () => {
  it('puts new pages after or before the current page', () => {
    expect(firstInsertedIndex(4, 'after')).toBe(5);
    expect(firstInsertedIndex(4, 'before')).toBe(4);
    expect(firstInsertedIndex(0, 'before')).toBe(0);
  });

  it('keeps the page count within 1..MAX', () => {
    expect(clampInsertCount(0)).toBe(1);
    expect(clampInsertCount(3.4)).toBe(3);
    expect(clampInsertCount(999)).toBe(MAX_INSERT_PAGES);
    expect(clampInsertCount(Number.NaN)).toBe(1);
  });
});

describe('page shifts', () => {
  // 10-page PDF, 3 pages inserted after page index 4 → new pages are 5, 6, 7.
  const first = 5;
  const count = 3;

  it('moves only pages at or after the insert point', () => {
    expect(pageAfterInsert(4, first, count)).toBe(4);
    expect(pageAfterInsert(5, first, count)).toBe(8);
    expect(pageAfterInsert(9, first, count)).toBe(12);
  });

  it('undo reverses the insert for original pages', () => {
    for (let page = 0; page < 10; page++) {
      expect(pageAfterUndo(pageAfterInsert(page, first, count), first, count, 10)).toBe(page);
    }
  });

  it('undo sends references to removed pages to the page that followed them', () => {
    expect(pageAfterUndo(6, first, count, 10)).toBe(5);
  });

  it('undo of pages added at the very end lands on the last original page', () => {
    // 10-page PDF, 2 pages inserted after the last page (index 9) → 10, 11.
    expect(pageAfterUndo(11, 10, 2, 10)).toBe(9);
  });

  it('reports handwriting that would shift', () => {
    expect(shiftedMarkedPages([9, 0, 5, 4], 5)).toEqual([5, 9]);
    expect(shiftedMarkedPages([0, 1], 5)).toEqual([]);
  });
});

import {planInsertMoves, planUndoMoves, rollbackMoves} from '../src/domain/pdfInsertion';

// Simulates the sidecar: page → marks, applying moves as copy-then-clear.
function apply(sidecar: Map<number, string>, moves: {from: number; to: number}[]) {
  for (const {from, to} of moves) {
    const marks = sidecar.get(from);
    if (marks === undefined) {
      continue;
    }
    if (sidecar.has(to)) {
      throw new Error(`would overwrite page ${to}`);
    }
    sidecar.set(to, marks);
    sidecar.delete(from);
  }
  return sidecar;
}

describe('moving handwriting with its pages', () => {
  it('insert moves every later marked page up without overwriting', () => {
    // Writing on pages 0,1,2,3; insert 2 pages after page 0 → first new index 1.
    const sidecar = new Map([[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd']]);
    const moves = planInsertMoves([...sidecar.keys()], 1, 2);
    expect(moves.map(m => m.from)).toEqual([3, 2, 1]);
    apply(sidecar, moves);
    expect([...sidecar.entries()].sort()).toEqual([[0, 'a'], [3, 'b'], [4, 'c'], [5, 'd']]);
  });

  it('undo clears the added pages and moves the rest back', () => {
    // After the insert above, the user also wrote on added page 2.
    const sidecar = new Map([[0, 'a'], [2, 'new'], [3, 'b'], [4, 'c'], [5, 'd']]);
    const plan = planUndoMoves([...sidecar.keys()], 1, 2);
    expect(plan.clear).toEqual([2]);
    plan.clear.forEach(page => sidecar.delete(page));
    apply(sidecar, plan.moves);
    expect([...sidecar.entries()].sort()).toEqual([[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd']]);
  });

  it('rollback of a half-finished insert restores the original layout', () => {
    const sidecar = new Map([[1, 'b'], [2, 'c'], [3, 'd']]);
    const moves = planInsertMoves([...sidecar.keys()], 1, 1);
    const done = moves.slice(0, 2); // failed on the third
    apply(sidecar, done);
    apply(sidecar, rollbackMoves(done));
    expect([...sidecar.entries()].sort()).toEqual([[1, 'b'], [2, 'c'], [3, 'd']]);
  });
});

describe('template images', () => {
  it('accepts only images PDFBox can draw', () => {
    expect(isImageFile('/MyStyle/Cornell.png')).toBe(true);
    expect(isImageFile('/MyStyle/Scan.JPG')).toBe(true);
    expect(isImageFile('/MyStyle/grid.svg')).toBe(false);
    expect(isImageFile('/Document/Book.pdf')).toBe(false);
  });

  it('keeps the newest first, without duplicates, capped', () => {
    let recents: string[] = [];
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) {
      recents = rememberTemplate(recents, `/MyStyle/${name}.png`);
    }
    expect(recents).toEqual([
      '/MyStyle/f.png',
      '/MyStyle/e.png',
      '/MyStyle/d.png',
      '/MyStyle/c.png',
      '/MyStyle/b.png',
    ]);
    expect(rememberTemplate(recents, '/MyStyle/c.png')[0]).toBe('/MyStyle/c.png');
    expect(rememberTemplate(recents, '/MyStyle/c.png')).toHaveLength(MAX_TEMPLATES);
  });

  it('leaves the list alone when nothing was chosen', () => {
    expect(rememberTemplate(['/MyStyle/a.png'], '')).toEqual(['/MyStyle/a.png']);
  });
});

describe('template size', () => {
  it('fills the page only at Full', () => {
    expect(templateScale('full')).toBe(1);
    expect(templateScale('margin')).toBeLessThan(1);
    expect(templateScale('small')).toBeLessThan(templateScale('margin'));
    expect(templateScale('small')).toBeGreaterThan(0.5);
  });

  it('offers all three sizes, labelled with what they do', () => {
    expect(TEMPLATE_SIZES).toEqual(['full', 'margin', 'small']);
    expect(templateSizeLabel('full')).toBe('Full');
    expect(templateSizeLabel('margin')).toBe('Margin (94%)');
  });

  it('ignores a stored size it does not recognise', () => {
    expect(parseTemplateSize('margin')).toBe('margin');
    expect(parseTemplateSize('enormous')).toBeUndefined();
    expect(parseTemplateSize(undefined)).toBeUndefined();
  });
});

describe('removing a page Shelf added', () => {
  // Removal reuses the undo planner (clear the page, move later pages down), and
  // putting the page back reuses the insert planner (move them up again).
  it('clears the removed page and moves later handwriting down', () => {
    const plan = planUndoMoves([2, 5, 7], 5, 1);
    expect(plan.clear).toEqual([5]);
    expect(plan.moves).toEqual([
      {from: 7, to: 6},
    ]);
  });

  it('moves handwriting back up when the page is restored', () => {
    expect(planInsertMoves([2, 6], 5, 1)).toEqual([{from: 6, to: 7}]);
  });

  it('leaves pages before the removed one alone', () => {
    const plan = planUndoMoves([0, 1], 5, 1);
    expect(plan.clear).toEqual([]);
    expect(plan.moves).toEqual([]);
  });
});
