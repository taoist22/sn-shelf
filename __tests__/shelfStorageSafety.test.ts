const mockSave = jest.fn(async (_state: unknown) => undefined);
let mockLoad: () => Promise<unknown> = async () => ({status: 'empty'});

jest.mock('../src/storage/nativeShelfStorage', () => {
  const actual = jest.requireActual('../src/storage/nativeShelfStorage') as object;
  return {
    ...actual,
    // Both are referenced lazily: the hoisted import of this module runs the
    // factory before the consts below are initialised.
    readShelfState: () => mockLoad(),
    savePersistedShelfState: (state: unknown) => mockSave(state),
  };
});

import {beforeEach, describe, expect, it, jest} from '@jest/globals';
import {parseShelfStateStrict} from '../src/storage/nativeShelfStorage';

type SessionShelf = typeof import('../src/storage/sessionShelf');

function freshSession(): SessionShelf {
  let mod: SessionShelf | null = null;
  jest.isolateModules(() => {
    mod = require('../src/storage/sessionShelf') as SessionShelf;
  });
  return mod as unknown as SessionShelf;
}

function pin(path: string) {
  return {id: path, path, title: 'x', page: 0, kind: 'pdf' as const, addedAt: 1};
}

beforeEach(() => {
  mockSave.mockClear();
  mockLoad = async () => ({status: 'empty'});
});

describe('parseShelfStateStrict', () => {
  it('tells an empty file apart from a damaged one', () => {
    expect(parseShelfStateStrict('').status).toBe('empty');
    expect(parseShelfStateStrict('   ').status).toBe('empty');
    // A truncated write: this used to parse as an EMPTY SHELF and then be
    // saved over, losing everything.
    expect(parseShelfStateStrict('{"version":2,"general":[{"id"').status).toBe('unreadable');
    expect(parseShelfStateStrict('null').status).toBe('unreadable');
    expect(parseShelfStateStrict('"a string"').status).toBe('unreadable');
    expect(parseShelfStateStrict('{"version":2,"general":[],"projects":[]}').status).toBe('loaded');
  });
});

describe('saving the shelf', () => {
  it('refuses to save over a shelf file it could not read', async () => {
    mockLoad = async () => ({status: 'unreadable', detail: 'not valid JSON (boom)'});
    const session = freshSession();
    await session.hydrateShelfState();
    expect(session.shelfStorageProblem()).toContain('not valid JSON');
    session.saveGeneralItems([pin('/Document/A.pdf')]);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('saves normally once the shelf has been read', async () => {
    const session = freshSession();
    await session.hydrateShelfState();
    expect(session.shelfStorageProblem()).toBeNull();
    session.saveGeneralItems([pin('/Document/A.pdf')]);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('does not save before the read has finished', async () => {
    let release: (value: unknown) => void = () => {};
    mockLoad = () =>
      new Promise(resolve => {
        release = resolve;
      });
    const session = freshSession();
    const hydrating = session.hydrateShelfState();
    // A refresh arriving during startup used to persist the empty state.
    session.saveGeneralItems([pin('/Document/A.pdf')]);
    expect(mockSave).not.toHaveBeenCalled();
    release({status: 'empty'});
    await hydrating;
  });

  it('runs the read once however many callers ask for it', async () => {
    let reads = 0;
    mockLoad = async () => {
      reads += 1;
      return {status: 'empty'};
    };
    const session = freshSession();
    await Promise.all([
      session.hydrateShelfState(),
      session.hydrateShelfState(),
      session.hydrateShelfState(),
    ]);
    expect(reads).toBe(1);
  });
});
