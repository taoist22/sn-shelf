jest.mock('../src/storage/nativeShelfStorage', () => {
  const actual = jest.requireActual('../src/storage/nativeShelfStorage') as object;
  return {
    ...actual,
    readShelfState: jest.fn(async () => ({status: 'empty'})),
    savePersistedShelfState: jest.fn(async () => undefined),
  };
});

import {describe, expect, it, jest} from '@jest/globals';
import {pageAfterInsert} from '../src/domain/pdfInsertion';
import {
  addQuoteToProject,
  createProjectFromNote,
  getGeneralItems,
  listProjects,
  saveGeneralItems,
  saveProjectReferences,
  shiftDocumentPages,
} from '../src/storage/sessionShelf';

const BOOK = '/storage/emulated/0/Document/Book.pdf';
const OTHER = '/storage/emulated/0/Document/Other.pdf';

function pin(path: string, page: number) {
  return {id: `${path}#${page}`, path, title: 'x', page, kind: 'pdf' as const, addedAt: 1};
}

describe('shiftDocumentPages', () => {
  it('moves pins and quotes on the edited PDF only, at or after the insert point', () => {
    const anchor = '/storage/emulated/0/Note/P.note';
    createProjectFromNote(anchor, 'P');
    saveProjectReferences(anchor, [pin(BOOK, 2), pin(BOOK, 7), pin(OTHER, 7)]);
    saveGeneralItems([pin(BOOK, 9)]);
    addQuoteToProject(anchor, {
      id: 'q',
      text: 't',
      sourcePath: BOOK,
      sourceTitle: 'Book',
      sourcePage: 6,
      sourceKind: 'pdf',
      capturedAt: 1,
    });

    const moved = shiftDocumentPages(BOOK, page => pageAfterInsert(page, 5, 3));

    const project = listProjects().find(p => p.anchorPath === anchor)!;
    expect(project.references.map(r => r.page)).toEqual([2, 10, 7]);
    expect(project.quotes[0].sourcePage).toBe(9);
    expect(getGeneralItems()[0].page).toBe(12);
    expect(moved).toBe(3);
  });
});
