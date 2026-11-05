import {describe, expect, it} from '@jest/globals';
import {
  detectShelfKind,
  fileTitle,
  formatPage,
  isDocumentKind,
  makeShelfTarget,
  normalizeDevicePath,
  projectNoteTarget,
  samePath,
  targetOpensAtLastUsedPage,
} from '../src/domain/shelfItem';
import type {ShelfProject} from '../src/domain/shelfItem';

describe('detectShelfKind', () => {
  it('classifies known extensions case-insensitively', () => {
    expect(detectShelfKind('/Note/A.note')).toBe('note');
    expect(detectShelfKind('/Document/B.PDF')).toBe('pdf');
    expect(detectShelfKind('/Document/C.epub')).toBe('epub');
    expect(detectShelfKind('/Document/D.docx')).toBe('document');
    expect(detectShelfKind('/Document/E.doc')).toBe('document');
    expect(detectShelfKind('/Document/Comic.cbz')).toBe('document');
    expect(detectShelfKind('/Document/Book.xps')).toBe('document');
    expect(detectShelfKind('/Document/Novel.fb2')).toBe('document');
    expect(detectShelfKind('/Document/F.txt')).toBe('other');
  });
});

describe('isDocumentKind', () => {
  it('covers pdf, epub, and document only', () => {
    expect(isDocumentKind('pdf')).toBe(true);
    expect(isDocumentKind('epub')).toBe(true);
    expect(isDocumentKind('document')).toBe(true);
    expect(isDocumentKind('note')).toBe(false);
    expect(isDocumentKind('other')).toBe(false);
  });
});

describe('fileTitle', () => {
  it('strips the directory and extension', () => {
    expect(fileTitle('/Note/Folder/My Note.note')).toBe('My Note');
    expect(fileTitle('/Note/Folder')).toBe('Folder');
    expect(fileTitle('.hidden')).toBe('.hidden');
  });
});

describe('formatPage', () => {
  it('renders 0-based pages 1-based and clamps negatives', () => {
    expect(formatPage(0)).toBe('p. 1');
    expect(formatPage(4)).toBe('p. 5');
    expect(formatPage(-2)).toBe('p. 1');
  });
});

describe('normalizeDevicePath', () => {
  it('produces a full /storage/emulated/0 path from any variant', () => {
    expect(normalizeDevicePath('/storage/emulated/0/Note/A.note')).toBe(
      '/storage/emulated/0/Note/A.note',
    );
    expect(normalizeDevicePath('storage/emulated/0/Note/A.note')).toBe(
      '/storage/emulated/0/Note/A.note',
    );
    expect(normalizeDevicePath('/Note/A.note')).toBe(
      '/storage/emulated/0/Note/A.note',
    );
    expect(normalizeDevicePath('Note/A.note')).toBe(
      '/storage/emulated/0/Note/A.note',
    );
  });

  it('preserves absolute and relative SD-card paths', () => {
    expect(normalizeDevicePath('/storage/1234-ABCD/Projects/A.note')).toBe(
      '/storage/1234-ABCD/Projects/A.note',
    );
    expect(normalizeDevicePath('storage/1234-ABCD/Projects/A.note')).toBe(
      '/storage/1234-ABCD/Projects/A.note',
    );
  });
});

describe('samePath', () => {
  it('matches the same file however the path was reported', () => {
    expect(samePath('/Note/A.note', '/storage/emulated/0/Note/A.note')).toBe(true);
    expect(samePath('Note/A.note', '/storage/emulated/0/Note/A.note')).toBe(true);
    expect(samePath('storage/1234-ABCD/A.note', '/storage/1234-ABCD/A.note')).toBe(true);
  });

  it('keeps different files, and different volumes, apart', () => {
    expect(samePath('/Note/A.note', '/Note/B.note')).toBe(false);
    // Same name on the SD card is NOT the same file as the one in internal storage.
    expect(samePath('/storage/1234-ABCD/Note/A.note', '/Note/A.note')).toBe(false);
  });

  it('treats a missing path as no match', () => {
    expect(samePath(null, '/Note/A.note')).toBe(false);
    expect(samePath('/Note/A.note', undefined)).toBe(false);
    expect(samePath(null, null)).toBe(false);
  });
});

describe('makeShelfTarget', () => {
  it('derives title and kind from the path', () => {
    const target = makeShelfTarget('/Document/Book.pdf', 3);
    expect(target.title).toBe('Book');
    expect(target.kind).toBe('pdf');
    expect(target.page).toBe(3);
    expect(target.path).toBe('/Document/Book.pdf');
  });
});

describe('targetOpensAtLastUsedPage', () => {
  // A document card is a way back into a book, not a bookmark to one page: it resumes
  // wherever the reader got to. Before 2026-11-02 a pin stored openAtLastUsed: false and
  // honouring it reopened page 14 of a PDF the user had read to page 40.
  it('resumes a document however the pin was stored', () => {
    expect(
      targetOpensAtLastUsedPage(makeShelfTarget('/Document/Book.pdf', 3, true)),
    ).toBe(true);
    expect(
      targetOpensAtLastUsedPage(makeShelfTarget('/Document/Book.pdf', 3)),
    ).toBe(true);
    const legacyPin = {...makeShelfTarget('/Document/Book.pdf', 3), openAtLastUsed: false};
    expect(targetOpensAtLastUsedPage(legacyPin)).toBe(true);
  });

  it('still opens a note on the page it was pinned at', () => {
    expect(targetOpensAtLastUsedPage(makeShelfTarget('/Note/Working.note', 3))).toBe(false);
    expect(targetOpensAtLastUsedPage(makeShelfTarget('/Note/Working.note', 0))).toBe(true);
  });

  it('preserves legacy persisted behavior when the flag is absent', () => {
    const legacyNote = makeShelfTarget('/Note/Working.note', 0);
    delete legacyNote.openAtLastUsed;
    expect(targetOpensAtLastUsedPage(legacyNote)).toBe(true);
  });
});

describe('projectNoteTarget', () => {
  function project(overrides: Partial<ShelfProject> = {}): ShelfProject {
    return {
      anchorPath: '/Note/Working.note',
      anchorTitle: 'Working',
      anchorKind: 'note',
      workingNotePath: null,
      workingNoteTitle: null,
      references: [],
      quotes: [],
      ...overrides,
    };
  }

  it('uses the anchor for note projects', () => {
    const target = projectNoteTarget(project());
    expect(target?.path).toBe('/Note/Working.note');
    expect(target?.kind).toBe('note');
  });

  it('uses the designated working note for folder projects', () => {
    const target = projectNoteTarget(
      project({
        anchorPath: '/Note/ACC201',
        anchorKind: 'folder',
        workingNotePath: '/Note/ACC201/Main.note',
        workingNoteTitle: 'Main',
      }),
    );
    expect(target?.path).toBe('/Note/ACC201/Main.note');
    expect(target?.title).toBe('Main');
  });

  it('returns null for folder projects without a working note', () => {
    expect(
      projectNoteTarget(project({anchorPath: '/Note/ACC201', anchorKind: 'folder'})),
    ).toBeNull();
  });

  it('falls back to the file name when a working note has no stored title', () => {
    const target = projectNoteTarget(
      project({
        anchorPath: '/Note/ACC201',
        anchorKind: 'folder',
        workingNotePath: '/Note/ACC201/Main.note',
      }),
    );
    expect(target?.title).toBe('Main');
  });
});
