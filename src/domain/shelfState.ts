import type {ShelfProject, ShelfTarget} from './shelfItem';
import {fileTitle, normalizeDevicePath} from './shelfItem';
import type {PersistedShelfState} from '../storage/nativeShelfStorage';

/**
 * What the Shelf tab should show, derived from the currently open file.
 * Priority: note anchor > pinned reference > containing project folder >
 * general. isAnchor means "you are in the project's working note".
 */
export type ShelfContext =
  | {kind: 'project'; project: ShelfProject; isAnchor: boolean}
  | {kind: 'general'};

export function resolveContext(
  state: PersistedShelfState,
  currentPath: string | null,
): ShelfContext {
  if (currentPath) {
    // Paths can arrive with or without the /storage/emulated/0 prefix
    // depending on which API produced them; compare normalized.
    const current = normalizeDevicePath(currentPath);
    const anchored = state.projects.find(
      project =>
        project.anchorKind === 'note' &&
        normalizeDevicePath(project.anchorPath) === current,
    );
    if (anchored) {
      state.activeAnchorPath = anchored.anchorPath;
      return {kind: 'project', project: anchored, isAnchor: true};
    }

    const holders = state.projects.filter(project =>
      project.references.some(
        reference => normalizeDevicePath(reference.path) === current,
      ),
    );
    if (holders.length > 0) {
      // A file pinned in several projects resolves to the most recently
      // seen one; activeAnchorPath records that recency.
      const preferred =
        holders.find(project => project.anchorPath === state.activeAnchorPath) ??
        holders[0];
      state.activeAnchorPath = preferred.anchorPath;
      return {
        kind: 'project',
        project: preferred,
        isAnchor: isWorkingNote(preferred, current),
      };
    }

    // Folder projects claim every file inside them; deepest folder wins.
    const containers = state.projects
      .filter(
        project =>
          project.anchorKind === 'folder' &&
          current.startsWith(`${normalizeDevicePath(project.anchorPath)}/`),
      )
      .sort((a, b) => b.anchorPath.length - a.anchorPath.length);
    if (containers.length > 0) {
      const deepest = containers[0].anchorPath.length;
      const candidates = containers.filter(
        project => project.anchorPath.length === deepest,
      );
      const preferred =
        candidates.find(
          project => project.anchorPath === state.activeAnchorPath,
        ) ?? candidates[0];
      state.activeAnchorPath = preferred.anchorPath;
      return {
        kind: 'project',
        project: preferred,
        isAnchor: isWorkingNote(preferred, current),
      };
    }
  }

  return {kind: 'general'};
}

function isWorkingNote(project: ShelfProject, normalizedPath: string): boolean {
  return (
    project.workingNotePath !== null &&
    normalizeDevicePath(project.workingNotePath) === normalizedPath
  );
}

export function findProject(
  state: PersistedShelfState,
  anchorPath: string,
): ShelfProject | undefined {
  return state.projects.find(project => project.anchorPath === anchorPath);
}

/** Creates a project anchored on a note or folder; idempotent. */
export function createProject(
  state: PersistedShelfState,
  anchorPath: string,
  anchorTitle?: string,
  anchorKind: 'note' | 'folder' = 'note',
): ShelfProject {
  const existing = findProject(state, anchorPath);
  if (existing) {
    return existing;
  }
  const project: ShelfProject = {
    anchorPath,
    anchorTitle: anchorTitle || fileTitle(anchorPath),
    anchorKind,
    workingNotePath: null,
    workingNoteTitle: null,
    references: [],
    quotes: [],
  };
  state.projects.push(project);
  state.activeAnchorPath = anchorPath;
  return project;
}

/** Designates a folder project's working note. */
export function setWorkingNote(
  state: PersistedShelfState,
  anchorPath: string,
  notePath: string,
  noteTitle?: string,
): void {
  const project = findProject(state, anchorPath);
  if (!project || project.anchorKind !== 'folder') {
    return;
  }
  project.workingNotePath = notePath;
  project.workingNoteTitle = noteTitle || fileTitle(notePath);
}

/**
 * Deletes a project. Its references move to the general shelf (skipping
 * duplicates) so nothing is lost; quotes are discarded with the project.
 */
export function deleteProject(
  state: PersistedShelfState,
  anchorPath: string,
): void {
  const project = findProject(state, anchorPath);
  if (!project) {
    return;
  }
  const kept = project.references.filter(
    reference =>
      !state.general.some(
        item => item.path === reference.path && item.page === reference.page,
      ),
  );
  state.general = [...kept, ...state.general];
  state.projects = state.projects.filter(
    entry => entry.anchorPath !== anchorPath,
  );
  if (state.activeAnchorPath === anchorPath) {
    state.activeAnchorPath = null;
  }
}

/** Moves a general-shelf item into a project's references. */
export function moveGeneralItemToProject(
  state: PersistedShelfState,
  itemId: string,
  anchorPath: string,
): ShelfTarget | null {
  const project = findProject(state, anchorPath);
  const item = state.general.find(entry => entry.id === itemId);
  if (!project || !item) {
    return null;
  }
  state.general = state.general.filter(entry => entry.id !== itemId);
  const duplicate = project.references.some(
    reference => reference.path === item.path && reference.page === item.page,
  );
  if (!duplicate) {
    project.references = [item, ...project.references];
  }
  return item;
}
