import {describe, expect, it} from '@jest/globals';
import type {ShelfTarget} from '../src/domain/shelfItem';
import {
  createProject,
  deleteProject,
  moveGeneralItemToProject,
  resolveContext,
} from '../src/domain/shelfState';
import type {PersistedShelfState} from '../src/storage/nativeShelfStorage';

function target(overrides: Partial<ShelfTarget> = {}): ShelfTarget {
  return {
    id: 'id-1',
    path: '/Note/Ref.note',
    title: 'Ref',
    page: 0,
    kind: 'note',
    addedAt: 1,
    ...overrides,
  };
}

function stateWith(overrides: Partial<PersistedShelfState> = {}): PersistedShelfState {
  return {
    version: 2,
    general: [],
    projects: [],
    activeAnchorPath: null,
    headingTexts: {},
    inboxQuotes: [],
    ...overrides,
  };
}

function folderProject(
  anchorPath: string,
  overrides: Partial<PersistedShelfState['projects'][number]> = {},
): PersistedShelfState['projects'][number] {
  return {
    anchorPath,
    anchorTitle: anchorPath.split('/').pop() ?? anchorPath,
    anchorKind: 'folder' as const,
    workingNotePath: null,
    workingNoteTitle: null,
    references: [],
    quotes: [],
    ...overrides,
  };
}

describe('resolveContext', () => {
  it('returns general when no file is open', () => {
    expect(resolveContext(stateWith(), null)).toEqual({kind: 'general'});
  });

  it('returns general for an unaffiliated file', () => {
    const state = stateWith({
      projects: [
        {anchorPath: '/Note/A.note', anchorTitle: 'A', anchorKind: 'note' as const, workingNotePath: null, workingNoteTitle: null, references: [], quotes: []},
      ],
    });
    expect(resolveContext(state, '/Note/Other.note')).toEqual({kind: 'general'});
  });

  it('resolves a project anchor to its own project', () => {
    const state = stateWith({
      projects: [
        {anchorPath: '/Note/A.note', anchorTitle: 'A', anchorKind: 'note' as const, workingNotePath: null, workingNoteTitle: null, references: [], quotes: []},
      ],
    });
    const context = resolveContext(state, '/Note/A.note');
    expect(context.kind).toBe('project');
    if (context.kind === 'project') {
      expect(context.project.anchorPath).toBe('/Note/A.note');
      expect(context.isAnchor).toBe(true);
    }
    expect(state.activeAnchorPath).toBe('/Note/A.note');
  });

  it('resolves a pinned reference to its holding project', () => {
    const state = stateWith({
      projects: [
        {
          anchorPath: '/Note/A.note',
          anchorTitle: 'A',
          anchorKind: 'note' as const,
          workingNotePath: null,
          workingNoteTitle: null,
          references: [target({path: '/Document/Book.pdf', kind: 'pdf'})],
          quotes: [],
        },
      ],
    });
    const context = resolveContext(state, '/Document/Book.pdf');
    expect(context.kind).toBe('project');
    if (context.kind === 'project') {
      expect(context.project.anchorPath).toBe('/Note/A.note');
      expect(context.isAnchor).toBe(false);
    }
  });

  it('prefers anchor over pinned-reference when a note is both', () => {
    const state = stateWith({
      projects: [
        {
          anchorPath: '/Note/Class.note',
          anchorTitle: 'Class',
          anchorKind: 'note' as const,
          workingNotePath: null,
          workingNoteTitle: null,
          references: [target({path: '/Note/Assignment.note'})],
          quotes: [],
        },
        {
          anchorPath: '/Note/Assignment.note',
          anchorTitle: 'Assignment',
          anchorKind: 'note' as const,
          workingNotePath: null,
          workingNoteTitle: null,
          references: [],
          quotes: [],
        },
      ],
    });
    const context = resolveContext(state, '/Note/Assignment.note');
    expect(context.kind).toBe('project');
    if (context.kind === 'project') {
      expect(context.project.anchorPath).toBe('/Note/Assignment.note');
      expect(context.isAnchor).toBe(true);
    }
  });

  it('resolves files inside a folder project to that project', () => {
    const state = stateWith({
      projects: [folderProject('/storage/emulated/0/Note/ACC201')],
    });
    const context = resolveContext(
      state,
      '/storage/emulated/0/Note/ACC201/Week 3.note',
    );
    expect(context.kind).toBe('project');
    if (context.kind === 'project') {
      expect(context.project.anchorPath).toBe('/storage/emulated/0/Note/ACC201');
      expect(context.isAnchor).toBe(false);
    }
  });

  it('prefers the deepest containing folder project', () => {
    const state = stateWith({
      projects: [
        folderProject('/storage/emulated/0/Note'),
        folderProject('/storage/emulated/0/Note/ACC201'),
      ],
    });
    const context = resolveContext(
      state,
      '/storage/emulated/0/Note/ACC201/Week 3.note',
    );
    if (context.kind === 'project') {
      expect(context.project.anchorPath).toBe('/storage/emulated/0/Note/ACC201');
    } else {
      throw new Error('expected project context');
    }
  });

  it('marks the designated working note of a folder project as anchor', () => {
    const state = stateWith({
      projects: [
        folderProject('/storage/emulated/0/Note/ACC201', {
          workingNotePath: '/storage/emulated/0/Note/ACC201/Main.note',
          workingNoteTitle: 'Main',
        }),
      ],
    });
    const context = resolveContext(
      state,
      '/storage/emulated/0/Note/ACC201/Main.note',
    );
    if (context.kind === 'project') {
      expect(context.isAnchor).toBe(true);
    } else {
      throw new Error('expected project context');
    }
  });

  it('breaks reference ties toward the most recently seen project', () => {
    const shared = target({path: '/Document/Book.pdf', kind: 'pdf'});
    const state = stateWith({
      projects: [
        {anchorPath: '/Note/A.note', anchorTitle: 'A', anchorKind: 'note' as const, workingNotePath: null, workingNoteTitle: null, references: [shared], quotes: []},
        {anchorPath: '/Note/B.note', anchorTitle: 'B', anchorKind: 'note' as const, workingNotePath: null, workingNoteTitle: null, references: [shared], quotes: []},
      ],
      activeAnchorPath: '/Note/B.note',
    });
    const context = resolveContext(state, '/Document/Book.pdf');
    if (context.kind === 'project') {
      expect(context.project.anchorPath).toBe('/Note/B.note');
    } else {
      throw new Error('expected project context');
    }
  });
});

describe('project operations', () => {
  it('createProject is idempotent', () => {
    const state = stateWith();
    const first = createProject(state, '/Note/A.note', 'A');
    const second = createProject(state, '/Note/A.note', 'A');
    expect(first).toBe(second);
    expect(state.projects).toHaveLength(1);
  });

  it('deleteProject moves references to general without duplicating', () => {
    const shared = target({id: 'shared', path: '/Document/Book.pdf', kind: 'pdf'});
    const extra = target({id: 'extra', path: '/Note/Ref.note'});
    const state = stateWith({
      general: [shared],
      projects: [
        {
          anchorPath: '/Note/A.note',
          anchorTitle: 'A',
          anchorKind: 'note' as const,
          workingNotePath: null,
          workingNoteTitle: null,
          references: [
            {...shared, id: 'shared-copy'},
            extra,
          ],
          quotes: [],
        },
      ],
      activeAnchorPath: '/Note/A.note',
    });

    deleteProject(state, '/Note/A.note');

    expect(state.projects).toHaveLength(0);
    expect(state.general.map(item => item.path)).toEqual([
      '/Note/Ref.note',
      '/Document/Book.pdf',
    ]);
    expect(state.activeAnchorPath).toBeNull();
  });

  it('moveGeneralItemToProject moves an item into project references', () => {
    const item = target({id: 'move-me'});
    const state = stateWith({
      general: [item],
      projects: [
        {anchorPath: '/Note/A.note', anchorTitle: 'A', anchorKind: 'note' as const, workingNotePath: null, workingNoteTitle: null, references: [], quotes: []},
      ],
    });

    const moved = moveGeneralItemToProject(state, 'move-me', '/Note/A.note');

    expect(moved?.id).toBe('move-me');
    expect(state.general).toHaveLength(0);
    expect(state.projects[0].references).toHaveLength(1);
  });

  it('moveGeneralItemToProject drops the item from general even when a duplicate exists', () => {
    const item = target({id: 'move-me'});
    const state = stateWith({
      general: [item],
      projects: [
        {
          anchorPath: '/Note/A.note',
          anchorTitle: 'A',
          anchorKind: 'note' as const,
          workingNotePath: null,
          workingNoteTitle: null,
          references: [{...item, id: 'already-there'}],
          quotes: [],
        },
      ],
    });

    moveGeneralItemToProject(state, 'move-me', '/Note/A.note');

    expect(state.general).toHaveLength(0);
    expect(state.projects[0].references).toHaveLength(1);
  });
});
