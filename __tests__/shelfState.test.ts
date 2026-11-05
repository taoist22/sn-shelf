import {describe, expect, it} from '@jest/globals';
import {
  emptyShelfState,
  parsePersistedShelfState,
} from '../src/storage/nativeShelfStorage';
import type {ShelfTarget} from '../src/domain/shelfItem';
import {
  createProject,
  findProject,
  moveGeneralItemToProject,
} from '../src/domain/shelfState';

function target(overrides: Partial<ShelfTarget> = {}): ShelfTarget {
  return {
    id: 'id-1',
    path: '/storage/emulated/0/Note/Working.note',
    title: 'Working',
    page: 3,
    kind: 'note',
    addedAt: 1,
    ...overrides,
  };
}

describe('parsePersistedShelfState', () => {
  it('returns an empty state for invalid JSON', () => {
    expect(parsePersistedShelfState('not json')).toEqual(emptyShelfState());
  });

  it('migrates legacy items into the working-note project', () => {
    const pin = target({id: 'pin-1', path: '/Note/Ref.note', title: 'Ref'});
    const workingNote = target();
    const state = parsePersistedShelfState(
      JSON.stringify({items: [pin], returnTarget: workingNote}),
    );

    expect(state.version).toBe(2);
    expect(state.general).toEqual([]);
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].anchorPath).toBe(workingNote.path);
    expect(state.projects[0].references).toEqual([pin]);
    expect(state.projects[0].quotes).toEqual([]);
    expect(state.activeAnchorPath).toBe(workingNote.path);
  });

  it('migrates legacy items to general when there is no working note', () => {
    const pin = target({id: 'pin-1'});
    const state = parsePersistedShelfState(JSON.stringify({items: [pin]}));

    expect(state.general).toEqual([pin]);
    expect(state.projects).toEqual([]);
    expect(state.activeAnchorPath).toBeNull();
  });

  it('migrates legacy items to general when the return target was a document', () => {
    const pin = target({id: 'pin-1'});
    const pdf = target({path: '/Document/Book.pdf', kind: 'pdf'});
    const state = parsePersistedShelfState(
      JSON.stringify({items: [pin], returnTarget: pdf}),
    );

    expect(state.general).toEqual([pin]);
    expect(state.projects).toEqual([]);
    expect(state.activeAnchorPath).toBeNull();
  });

  it('round-trips a v2 state', () => {
    const pin = target({id: 'pin-1'});
    const original = {
      version: 2,
      general: [target({id: 'gen-1'})],
      projects: [
        {
          anchorPath: '/Note/Working.note',
          anchorTitle: 'Working',
          anchorKind: 'note' as const,
          workingNotePath: null,
          workingNoteTitle: null,
          references: [pin],
          quotes: [
            {
              id: 'q-1',
              text: 'A captured quote.',
              sourcePath: '/Document/Book.pdf',
              sourceTitle: 'Book',
              sourcePage: 4,
              sourceKind: 'pdf',
              capturedAt: 2,
            },
          ],
        },
      ],
      activeAnchorPath: '/Note/Working.note',
      headingTexts: {
        '/Note/Working.note': [{key: '0:10:20:300x40', page: 0, text: 'Intro'}],
      },
      inboxQuotes: [
        {
          id: 'shelf-quote-2026-07-07-163836.txt',
          text: 'An imported quote.',
          sourcePath: '',
          sourceTitle: 'Imported',
          sourcePage: 0,
          sourceKind: 'other',
          capturedAt: 3,
        },
      ],
      pdfTemplates: ['/MyStyle/Cornell.png'],
      pdfTemplateSize: 'margin' as const,
      pdfTemplateShrink: false,
    };

    expect(parsePersistedShelfState(JSON.stringify(original))).toEqual(original);
  });

  it('defaults inboxQuotes for states saved before the import feature', () => {
    const state = parsePersistedShelfState(
      JSON.stringify({version: 2, general: [], projects: []}),
    );
    expect(state.inboxQuotes).toEqual([]);
  });

  it('drops malformed entries and clears an active path with no matching project', () => {
    const state = parsePersistedShelfState(
      JSON.stringify({
        version: 2,
        general: [target({id: 'ok'}), {bogus: true}],
        projects: [{anchorPath: '/Note/A.note', references: [{}], quotes: 'no'}],
        activeAnchorPath: '/Note/Missing.note',
        inboxQuotes: [{id: 'missing-fields'}],
      }),
    );

    expect(state.general).toHaveLength(1);
    expect(state.projects[0].references).toEqual([]);
    expect(state.projects[0].quotes).toEqual([]);
    expect(state.activeAnchorPath).toBeNull();
    expect(state.inboxQuotes).toEqual([]);
  });
});

describe('quote ink persistence', () => {
  const quote = {
    id: 'q-1',
    text: 'A passage',
    sourcePath: '/storage/emulated/0/Document/Book.pdf',
    sourceTitle: 'Book',
    sourcePage: 11,
    sourceKind: 'pdf',
    capturedAt: 1,
  };
  const ink = {
    version: 1,
    width: 200,
    height: 80,
    lineSpacingPx: 94,
    strokes: [{xy: [0, 0, 200, 40], press: [0.1, 0.2]}],
  };

  function stateWith(quotes: unknown[]) {
    return parsePersistedShelfState(
      JSON.stringify({
        version: 2,
        general: [],
        projects: [
          {
            anchorPath: '/Note/Project.note',
            anchorTitle: 'Project',
            anchorKind: 'note',
            references: [],
            quotes,
          },
        ],
        inboxQuotes: quotes,
      }),
    );
  }

  it('keeps valid handwriting with project and imported quotes', () => {
    const state = stateWith([{...quote, ink}]);
    expect(state.projects[0].quotes[0].ink).toEqual(ink);
    expect(state.inboxQuotes[0].ink).toEqual(ink);
  });

  it('drops damaged handwriting but keeps the quote', () => {
    const state = stateWith([{...quote, ink: {...ink, strokes: [{xy: [1], press: [1, 2]}]}}]);
    expect(state.projects[0].quotes).toHaveLength(1);
    expect(state.projects[0].quotes[0].text).toBe('A passage');
    expect(state.projects[0].quotes[0].ink).toBeUndefined();
    expect(state.inboxQuotes[0].ink).toBeUndefined();
  });
});

describe('Insert Page working space setting', () => {
  it('keeps a valid choice and drops anything else', () => {
    const base = {version: 2, general: [], projects: []};
    expect(parsePersistedShelfState(JSON.stringify({...base, pdfWorkSpace: 'sd'})).pdfWorkSpace).toBe('sd');
    expect(parsePersistedShelfState(JSON.stringify({...base, pdfWorkSpace: 'cloud'})).pdfWorkSpace).toBeUndefined();
    expect(parsePersistedShelfState(JSON.stringify(base)).pdfWorkSpace).toBeUndefined();
  });
});

describe('path forms', () => {
  // Before 2026-11-04 these comparisons were raw string equality, so the same
  // note reported in two forms could anchor two projects and split the shelf.
  it('finds an existing project whichever form the path arrives in', () => {
    const state = emptyShelfState();
    createProject(state, '/storage/emulated/0/Note/Working.note', 'Working');
    expect(findProject(state, '/Note/Working.note')?.anchorTitle).toBe('Working');
    createProject(state, '/Note/Working.note', 'Working');
    expect(state.projects).toHaveLength(1);
  });

  it('does not pin the same page twice through a different path form', () => {
    const state = emptyShelfState();
    createProject(state, '/Note/Working.note', 'Working');
    const project = findProject(state, '/Note/Working.note')!;
    project.references = [
      {
        id: 'a',
        path: '/storage/emulated/0/Document/Book.pdf',
        title: 'Book',
        page: 3,
        kind: 'pdf',
        addedAt: 1,
      },
    ];
    state.general = [
      {id: 'b', path: '/Document/Book.pdf', title: 'Book', page: 3, kind: 'pdf', addedAt: 2},
    ];
    moveGeneralItemToProject(state, 'b', '/Note/Working.note');
    expect(project.references).toHaveLength(1);
  });
});
