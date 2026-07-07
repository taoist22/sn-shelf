import {describe, expect, it} from '@jest/globals';
import {
  emptyShelfState,
  parsePersistedShelfState,
} from '../src/storage/nativeShelfStorage';
import type {ShelfTarget} from '../src/domain/shelfItem';

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
    };

    expect(parsePersistedShelfState(JSON.stringify(original))).toEqual(original);
  });

  it('drops malformed entries and clears an active path with no matching project', () => {
    const state = parsePersistedShelfState(
      JSON.stringify({
        version: 2,
        general: [target({id: 'ok'}), {bogus: true}],
        projects: [{anchorPath: '/Note/A.note', references: [{}], quotes: 'no'}],
        activeAnchorPath: '/Note/Missing.note',
      }),
    );

    expect(state.general).toHaveLength(1);
    expect(state.projects[0].references).toEqual([]);
    expect(state.projects[0].quotes).toEqual([]);
    expect(state.activeAnchorPath).toBeNull();
  });
});
