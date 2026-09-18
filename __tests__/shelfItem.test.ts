import {describe, expect, it} from '@jest/globals';
import {
  detectShelfKind,
  fileTitle,
  formatPage,
  isDocumentKind,
  makeShelfTarget,
  normalizeDevicePath,
  projectNoteTarget,
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
  it('distinguishes Browse entries from exact-page pins', () => {
    expect(
      targetOpensAtLastUsedPage(makeShelfTarget('/Document/Book.pdf', 3, true)),
    ).toBe(true);
    expect(
      targetOpensAtLastUsedPage(makeShelfTarget('/Document/Book.pdf', 3)),
    ).toBe(false);
  });

  it('preserves legacy persisted behavior when the flag is absent', () => {
    const legacyDocument = makeShelfTarget('/Document/Book.pdf', 3);
    delete legacyDocument.openAtLastUsed;
    expect(targetOpensAtLastUsedPage(legacyDocument)).toBe(true);
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
