import React, {useCallback, useEffect, useState} from 'react';
import {
  DeviceEventEmitter,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import {PluginManager} from 'sn-plugin-lib';
import {
  consumePendingCapture,
  SHELF_CAPTURE_EVENT,
  SHELF_OPENED_EVENT,
} from '../app/events';
import {
  fileTitle,
  formatPage,
  isDocumentKind,
  normalizeDevicePath,
  projectNoteTarget,
  type ShelfProject,
  type ShelfQuote,
  type ShelfTarget,
} from '../domain/shelfItem';
import type {ShelfContext} from '../domain/shelfState';
import {
  openShelfFolder,
  openShelfTarget,
} from '../supernote/nativeShelfNavigation';
import {
  chooseShelfFiles,
  getCurrentTarget,
  insertQuoteIntoCurrentNote,
  readSelectedText,
} from '../supernote/supernoteShelf';
import {
  addQuoteToProject,
  createProjectFromFolder,
  createProjectFromNote,
  getGeneralItems,
  hydrateShelfState,
  listAllPinnedTargets,
  listProjects,
  moveToProject,
  removeProject,
  removeQuoteFromProject,
  resolveShelfContext,
  saveGeneralItems,
  saveProjectReferences,
  setProjectWorkingNote,
} from '../storage/sessionShelf';
import {
  ensureThumbnail,
  pruneThumbnails,
  refreshThumbnail,
} from '../services/thumbnails';
import {
  forgetHeadingText,
  recognizeNewHeadings,
  scanNoteMeta,
  type ReferenceMeta,
} from '../services/referenceMeta';

type TabKey = 'shelf' | 'quotes' | 'projects';

/** Marks the synthetic working-note card — not a real reference entry. */
const WORKING_CARD_ID = '__working__';

function ThumbCard(props: {
  item: ShelfTarget;
  widthPct: `${number}%`;
  badge?: string;
  onOpen: (item: ShelfTarget) => void;
  onDetail: (item: ShelfTarget) => void;
}): React.JSX.Element {
  const {item, widthPct, badge, onOpen, onDetail} = props;
  const [thumbUri, setThumbUri] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    if (item.kind === 'note') {
      ensureThumbnail(item).then(uri => {
        if (isMounted) {
          setThumbUri(uri);
        }
      });
    }
    return () => {
      isMounted = false;
    };
  }, [item]);

  const isNote = item.kind === 'note';
  return (
    <Pressable
      style={[styles.card, {width: widthPct}]}
      onPress={() => onOpen(item)}
      onLongPress={() => onDetail(item)}
      delayLongPress={400}>
      {badge ? <Text style={styles.cardBadge}>{badge}</Text> : null}
      {isNote && thumbUri ? (
        <Image
          source={{uri: `file://${thumbUri}`}}
          style={styles.cardThumb}
          resizeMode="cover"
        />
      ) : isNote ? (
        <View style={styles.cardGlyphBox}>
          <Text style={styles.cardGlyph}>···</Text>
        </View>
      ) : (
        // Documents have no page-render API — show a book-cover style card
        // with the title inside the box.
        <View style={styles.cardCoverBox}>
          <Text style={styles.cardCoverKind}>{item.kind.toUpperCase()}</Text>
          <Text numberOfLines={4} style={styles.cardCoverTitle}>
            {item.title}
          </Text>
        </View>
      )}
      {isNote ? (
        <Text numberOfLines={2} style={styles.cardTitle}>
          {item.title}
        </Text>
      ) : null}
      <Text style={styles.cardMeta}>
        {isDocumentKind(item.kind) || (isNote && item.page === 0)
          ? 'last-used page'
          : formatPage(item.page)}
      </Text>
    </Pressable>
  );
}

export function PluginScreen(): React.JSX.Element {
  const {width: windowWidth} = useWindowDimensions();
  const cardWidthPct: `${number}%` = windowWidth >= 1000 ? '23.5%' : '31.5%';
  const [tab, setTab] = useState<TabKey>('shelf');
  const [context, setContext] = useState<ShelfContext>({kind: 'general'});
  const [currentTarget, setCurrentTarget] = useState<ShelfTarget | null>(null);
  const [projects, setProjects] = useState<ShelfProject[]>([]);
  const [generalItems, setGeneralItems] = useState<ShelfTarget[]>([]);
  const [detailItem, setDetailItem] = useState<ShelfTarget | null>(null);
  const [detailMeta, setDetailMeta] = useState<ReferenceMeta | null>(null);
  const [detailMetaState, setDetailMetaState] = useState<
    'idle' | 'loading' | 'error'
  >('idle');
  const [showMoveChooser, setShowMoveChooser] = useState(false);
  const [capture, setCapture] = useState<{
    text: string;
    source: ShelfTarget;
    // null = unaffiliated capture; the user picks a destination project.
    projectPath: string | null;
    projectTitle: string;
  } | null>(null);
  const [recognizing, setRecognizing] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [deleteArmedPath, setDeleteArmedPath] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [isReady, setIsReady] = useState(false);

  const refresh = useCallback(async () => {
    const current = await getCurrentTarget().catch(() => null);
    setCurrentTarget(current);
    setContext(resolveShelfContext(current?.path ?? null));
    setProjects([...listProjects()]);
    setGeneralItems([...getGeneralItems()]);
  }, []);

  const startCapture = useCallback(async () => {
    try {
      const current = await getCurrentTarget().catch(() => null);
      setCurrentTarget(current);
      const ctx = resolveShelfContext(current?.path ?? null);
      setContext(ctx);
      setProjects([...listProjects()]);
      setGeneralItems([...getGeneralItems()]);
      setDetailItem(null);
      if (!current) {
        setStatus('Open a file and select text before capturing.');
        return;
      }
      const allProjects = listProjects();
      if (ctx.kind !== 'project' && allProjects.length === 0) {
        setStatus('Create a project first — quotes are saved to projects.');
        return;
      }
      let text = '';
      try {
        text = await readSelectedText();
      } catch {
        // No selection available — the capture field starts empty.
      }
      setCapture({
        text,
        source: current,
        projectPath: ctx.kind === 'project' ? ctx.project.anchorPath : null,
        projectTitle: ctx.kind === 'project' ? ctx.project.anchorTitle : '',
      });
    } catch (error) {
      setStatus(`Capture failed: ${String(error)}`);
    }
  }, []);

  const saveCapture = useCallback(async () => {
    if (!capture) {
      return;
    }
    const text = capture.text.trim();
    if (!text) {
      setStatus('The quote is empty — select text or type it in.');
      return;
    }
    if (!capture.projectPath) {
      setStatus('Choose a project to save this quote to.');
      return;
    }
    const quote: ShelfQuote = {
      id: `q-${Date.now()}`,
      text,
      sourcePath: capture.source.path,
      sourceTitle: capture.source.title,
      sourcePage: capture.source.page,
      sourceKind: capture.source.kind,
      capturedAt: Date.now(),
    };
    const saved = addQuoteToProject(capture.projectPath, quote);
    setCapture(null);
    setStatus(
      saved ? `Quote saved to ${capture.projectTitle}.` : 'Could not save quote.',
    );
    await refresh();
    if (saved) {
      PluginManager.closePluginView();
    }
  }, [capture, refresh]);

  const deleteQuote = useCallback(
    async (project: ShelfProject, quoteId: string) => {
      removeQuoteFromProject(project.anchorPath, quoteId);
      setStatus('Quote deleted.');
      await refresh();
    },
    [refresh],
  );

  const placeQuote = useCallback(
    async (project: ShelfProject, quote: ShelfQuote, isAnchor: boolean) => {
      if (!isAnchor) {
        const target = projectNoteTarget(project);
        if (!target) {
          setStatus('Set a working note for this project first.');
          return;
        }
        try {
          await openShelfTarget(target, {atLastUsedPage: true});
          setStatus('Opening the working note — reopen Shelf there to place.');
        } catch (error) {
          setStatus(`Could not open working note: ${String(error)}`);
        }
        return;
      }
      try {
        await insertQuoteIntoCurrentNote(quote);
        removeQuoteFromProject(project.anchorPath, quote.id);
        setStatus('Quote placed on this page.');
        await refresh();
        PluginManager.closePluginView();
      } catch (error) {
        setStatus(`Could not place quote: ${String(error)}`);
      }
    },
    [refresh],
  );

  const closeDetail = useCallback(() => {
    setDetailItem(null);
    setDetailMeta(null);
    setDetailMetaState('idle');
    setShowMoveChooser(false);
  }, []);

  useEffect(() => {
    let isMounted = true;
    hydrateShelfState()
      .catch(error => {
        if (isMounted) {
          setStatus(`Could not load saved shelf: ${String(error)}`);
        }
      })
      .finally(() => {
        refresh().finally(() => {
          if (isMounted) {
            setIsReady(true);
            // The panel may have been opened BY the capture button.
            if (consumePendingCapture()) {
              startCapture();
            }
          }
          // Drop cached thumbnails of pins that no longer exist.
          pruneThumbnails(listAllPinnedTargets()).catch(() => {});
        });
      });

    const sub = PluginManager.addPluginLifeListener({
      onStart() {
        refresh();
      },
      onStop() {
        setTab('shelf');
        setDetailItem(null);
        setDetailMeta(null);
        setDetailMetaState('idle');
        setShowMoveChooser(false);
        setCapture(null);
        setDeleteArmedPath(null);
        setStatus('');
      },
    });

    // The panel can stay mounted across opens without onStart firing; the
    // toolbar button press (relayed from index.js) always does.
    const openedSub = DeviceEventEmitter.addListener(SHELF_OPENED_EVENT, () => {
      setDetailItem(null);
      setDetailMeta(null);
      setDetailMetaState('idle');
      setShowMoveChooser(false);
      setCapture(null);
      refresh();
    });

    const captureSub = DeviceEventEmitter.addListener(
      SHELF_CAPTURE_EVENT,
      () => {
        consumePendingCapture();
        startCapture();
      },
    );

    return () => {
      isMounted = false;
      sub.remove();
      openedSub.remove();
      captureSub.remove();
    };
  }, [refresh, startCapture]);

  const openDetail = useCallback((item: ShelfTarget) => {
    setDetailItem(item);
    setDetailMeta(null);
    setShowMoveChooser(false);
    if (item.kind === 'note') {
      setDetailMetaState('loading');
      scanNoteMeta(item.path)
        .then(meta => {
          setDetailMeta(meta);
          setDetailMetaState('idle');
        })
        .catch(() => setDetailMetaState('error'));
    } else {
      setDetailMetaState('idle');
    }
  }, []);

  const pinCurrent = useCallback(async () => {
    try {
      const target = await getCurrentTarget();
      if (context.kind === 'project') {
        const next = [
          target,
          ...context.project.references.filter(
            item => item.path !== target.path || item.page !== target.page,
          ),
        ];
        saveProjectReferences(context.project.anchorPath, next);
        setStatus(
          `Pinned ${target.title} ${formatPage(target.page)} to ${context.project.anchorTitle}.`,
        );
      } else {
        const next = [
          target,
          ...generalItems.filter(
            item => item.path !== target.path || item.page !== target.page,
          ),
        ];
        saveGeneralItems(next);
        setStatus(`Pinned ${target.title} ${formatPage(target.page)}.`);
      }
      await refresh();
    } catch (error) {
      setStatus(`Could not pin this page: ${String(error)}`);
    }
  }, [context, generalItems, refresh]);

  const browseFiles = useCallback(async () => {
    try {
      let startFolder: string | undefined;
      if (context.kind === 'project') {
        const anchor = normalizeDevicePath(context.project.anchorPath);
        startFolder =
          context.project.anchorKind === 'folder'
            ? anchor
            : anchor.slice(0, anchor.lastIndexOf('/')) || undefined;
      }
      const targets = await chooseShelfFiles(startFolder);
      if (targets.length === 0) {
        setStatus('');
        return;
      }
      if (context.kind === 'project') {
        const kept = context.project.references.filter(
          item => !targets.some(target => target.path === item.path),
        );
        saveProjectReferences(context.project.anchorPath, [
          ...targets,
          ...kept,
        ]);
        setStatus(
          `Added ${targets.length} ${targets.length === 1 ? 'file' : 'files'} to ${context.project.anchorTitle}.`,
        );
      } else {
        const kept = generalItems.filter(
          item => !targets.some(target => target.path === item.path),
        );
        saveGeneralItems([...targets, ...kept]);
        setStatus(
          `Added ${targets.length} ${targets.length === 1 ? 'file' : 'files'} to the general shelf.`,
        );
      }
      await refresh();
    } catch (error) {
      setStatus(`File picker failed: ${String(error)}`);
    }
  }, [context, generalItems, refresh]);

  const openItem = useCallback(async (target: ShelfTarget) => {
    try {
      // Page-0 note pins (Browse additions, first-page pins) behave like
      // documents: resume at the note's own last-used page. Mid-note pins
      // keep their exact page.
      const atLastUsed = target.kind === 'note' && target.page === 0;
      await openShelfTarget(target, {atLastUsedPage: atLastUsed});
      setStatus(
        atLastUsed || isDocumentKind(target.kind)
          ? `Opening ${target.title} (last-used page).`
          : `Opening ${target.title} ${formatPage(target.page)}.`,
      );
    } catch (error) {
      setStatus(`Could not open directly: ${String(error)}`);
    }
  }, []);

  const openNotePage = useCallback(async (item: ShelfTarget, page: number) => {
    try {
      // Keyword/heading jumps always target their exact page.
      await openShelfTarget({...item, page});
      setStatus(`Opening ${item.title} p. ${page + 1}.`);
    } catch (error) {
      setStatus(`Could not open directly: ${String(error)}`);
    }
  }, []);

  const forgetHeading = useCallback(
    (key: string) => {
      if (!detailItem || !detailMeta) {
        return;
      }
      forgetHeadingText(detailItem.path, key);
      setDetailMeta({
        ...detailMeta,
        headings: detailMeta.headings.map(entry =>
          entry.key === key ? {...entry, text: null} : entry,
        ),
      });
      setStatus('Heading text cleared. Use Recognize to rescan it.');
    },
    [detailItem, detailMeta],
  );

  const openAnchor = useCallback(async (project: ShelfProject) => {
    try {
      const noteTarget = projectNoteTarget(project);
      if (noteTarget) {
        await openShelfTarget(noteTarget, {atLastUsedPage: true});
        setStatus(`Returning to ${noteTarget.title} (last-used page).`);
      } else {
        await openShelfFolder(project.anchorPath);
        setStatus(`Opening folder ${project.anchorTitle}.`);
      }
    } catch (error) {
      setStatus(`Could not open directly: ${String(error)}`);
    }
  }, []);

  const openProjectFolder = useCallback(async (project: ShelfProject) => {
    try {
      await openShelfFolder(project.anchorPath);
      setStatus(`Opening folder ${project.anchorTitle}.`);
    } catch (error) {
      setStatus(`Could not open folder: ${String(error)}`);
    }
  }, []);

  const makeWorkingNote = useCallback(
    async (project: ShelfProject) => {
      try {
        const target = await getCurrentTarget();
        if (target.kind !== 'note') {
          setStatus('Open the note you want as the working note first.');
          return;
        }
        setProjectWorkingNote(project.anchorPath, target.path, target.title);
        setStatus(`${target.title} is now the working note for ${project.anchorTitle}.`);
        await refresh();
      } catch (error) {
        setStatus(`Could not set working note: ${String(error)}`);
      }
    },
    [refresh],
  );

  const removeReference = useCallback(
    async (id: string) => {
      if (context.kind === 'project') {
        saveProjectReferences(
          context.project.anchorPath,
          context.project.references.filter(item => item.id !== id),
        );
      } else {
        saveGeneralItems(generalItems.filter(item => item.id !== id));
      }
      setStatus('Removed from shelf.');
      closeDetail();
      await refresh();
    },
    [context, generalItems, refresh, closeDetail],
  );

  const makeProject = useCallback(async () => {
    try {
      const target = await getCurrentTarget();
      if (target.kind !== 'note') {
        setStatus('Only .note files can become project notes.');
        return;
      }
      createProjectFromNote(target.path, target.title);
      setStatus(`${target.title} is now a project note.`);
      await refresh();
    } catch (error) {
      setStatus(`Could not create project: ${String(error)}`);
    }
  }, [refresh]);

  const makeFolderProject = useCallback(async () => {
    try {
      const target = await getCurrentTarget();
      const normalized = normalizeDevicePath(target.path);
      const slash = normalized.lastIndexOf('/');
      const folder = slash > 0 ? normalized.slice(0, slash) : '';
      if (!folder || folder === '/storage/emulated/0') {
        setStatus('Could not determine a usable folder for this file.');
        return;
      }
      createProjectFromFolder(folder, fileTitle(folder));
      setStatus(`${fileTitle(folder)} folder is now a project.`);
      await refresh();
    } catch (error) {
      setStatus(`Could not create folder project: ${String(error)}`);
    }
  }, [refresh]);

  const recognizeHeadings = useCallback(async () => {
    if (!detailItem || detailItem.kind !== 'note' || !detailMeta) {
      return;
    }
    setRecognizing({done: 0, total: 0});
    try {
      const headings = await recognizeNewHeadings(
        detailItem.path,
        detailMeta.headings,
        (done, total) => setRecognizing({done, total}),
      );
      setDetailMeta({...detailMeta, headings});
      const still = headings.filter(entry => entry.text === null).length;
      setStatus(
        still === 0
          ? 'All headings recognized.'
          : `${still} heading${still === 1 ? '' : 's'} could not be recognized.`,
      );
    } catch (error) {
      setStatus(`Heading recognition failed: ${String(error)}`);
    } finally {
      setRecognizing(null);
    }
  }, [detailItem, detailMeta]);

  const deleteProjectPressed = useCallback(
    async (project: ShelfProject) => {
      if (deleteArmedPath !== project.anchorPath) {
        setDeleteArmedPath(project.anchorPath);
        return;
      }
      removeProject(project.anchorPath);
      setDeleteArmedPath(null);
      setStatus(
        `Deleted project ${project.anchorTitle}. Its references moved to the general shelf.`,
      );
      await refresh();
    },
    [deleteArmedPath, refresh],
  );

  const moveDetailItem = useCallback(
    async (project: ShelfProject) => {
      if (!detailItem) {
        return;
      }
      const moved = moveToProject(detailItem.id, project.anchorPath);
      setStatus(
        moved
          ? `Moved ${moved.title} to ${project.anchorTitle}.`
          : 'Could not move that item.',
      );
      closeDetail();
      await refresh();
    },
    [detailItem, refresh, closeDetail],
  );

  const moveDetail = useCallback(
    async (direction: -1 | 1) => {
      if (!detailItem) {
        return;
      }
      const list =
        context.kind === 'project'
          ? [...context.project.references]
          : [...generalItems];
      const index = list.findIndex(entry => entry.id === detailItem.id);
      const next = index + direction;
      if (index < 0 || next < 0 || next >= list.length) {
        return;
      }
      [list[index], list[next]] = [list[next], list[index]];
      if (context.kind === 'project') {
        saveProjectReferences(context.project.anchorPath, list);
      } else {
        saveGeneralItems(list);
      }
      setStatus(
        `Moved ${detailItem.title} ${direction < 0 ? 'earlier' : 'later'} on the shelf (${next + 1} of ${list.length}).`,
      );
      await refresh();
    },
    [detailItem, context, generalItems, refresh],
  );

  const setWorkingNoteFromDetail = useCallback(async () => {
    if (
      !detailItem ||
      context.kind !== 'project' ||
      context.project.anchorKind !== 'folder'
    ) {
      return;
    }
    setProjectWorkingNote(
      context.project.anchorPath,
      detailItem.path,
      detailItem.title,
    );
    setStatus(
      `${detailItem.title} is now the working note for ${context.project.anchorTitle}.`,
    );
    await refresh();
  }, [detailItem, context, refresh]);

  const refreshDetailThumbnail = useCallback(async () => {
    if (!detailItem) {
      return;
    }
    setStatus('Refreshing page preview...');
    const uri = await refreshThumbnail(detailItem);
    setStatus(uri ? 'Page preview refreshed.' : 'Could not refresh preview.');
    await refresh();
  }, [detailItem, refresh]);

  const rescanDetailMeta = useCallback(() => {
    if (!detailItem || detailItem.kind !== 'note') {
      return;
    }
    setDetailMetaState('loading');
    scanNoteMeta(detailItem.path, true)
      .then(meta => {
        setDetailMeta(meta);
        setDetailMetaState('idle');
      })
      .catch(() => setDetailMetaState('error'));
  }, [detailItem]);

  const totalQuotes = projects.reduce(
    (sum, project) => sum + project.quotes.length,
    0,
  );
  const currentIsNote = currentTarget?.kind === 'note';
  const currentIsAnchor =
    currentIsNote &&
    projects.some(project => project.anchorPath === currentTarget?.path);

  function renderGrid(items: ShelfTarget[]): React.JSX.Element {
    return (
      <View style={styles.grid}>
        {items.map(item => (
          <ThumbCard
            key={item.id}
            item={item}
            widthPct={cardWidthPct}
            onOpen={openItem}
            onDetail={openDetail}
          />
        ))}
      </View>
    );
  }

  function renderDetail(item: ShelfTarget): React.JSX.Element {
    const isWorkingCard = item.id === WORKING_CARD_ID;
    const canMove = context.kind === 'general' && !isWorkingCard;
    const inFolderProject =
      context.kind === 'project' && context.project.anchorKind === 'folder';
    const canBeWorkingNote =
      inFolderProject &&
      item.kind === 'note' &&
      context.kind === 'project' &&
      normalizeDevicePath(item.path).startsWith(
        `${normalizeDevicePath(context.project.anchorPath)}/`,
      ) &&
      (context.project.workingNotePath === null ||
        normalizeDevicePath(context.project.workingNotePath) !==
          normalizeDevicePath(item.path));
    return (
      <>
        <View style={styles.workingPanel}>
          <Text style={styles.eyebrow}>Reference Detail</Text>
          <Text style={styles.workingTitle}>{item.title}</Text>
          <Text style={styles.detailMetaLine}>
            {item.kind.toUpperCase()} ·{' '}
            {isDocumentKind(item.kind)
              ? 'opens last-used page'
              : formatPage(item.page)}
          </Text>
          <Text style={styles.detailPath}>{item.path}</Text>
        </View>

        <View style={styles.actionsRow}>
          <Pressable style={styles.rowButton} onPress={() => openItem(item)}>
            <Text style={styles.rowButtonText}>Open</Text>
          </Pressable>
          {item.kind === 'note' ? (
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={refreshDetailThumbnail}>
              <Text style={styles.rowButtonSecondaryText}>Re-render</Text>
            </Pressable>
          ) : null}
          {canMove ? (
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={() => setShowMoveChooser(value => !value)}>
              <Text style={styles.rowButtonSecondaryText}>Move</Text>
            </Pressable>
          ) : null}
          {!isWorkingCard ? (
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={() => removeReference(item.id)}>
              <Text style={styles.rowButtonSecondaryText}>Remove</Text>
            </Pressable>
          ) : null}
        </View>

        {!isWorkingCard ? (
          <View style={styles.actionsRow}>
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={() => moveDetail(-1)}>
              <Text style={styles.rowButtonSecondaryText}>◀ Earlier</Text>
            </Pressable>
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={() => moveDetail(1)}>
              <Text style={styles.rowButtonSecondaryText}>Later ▶</Text>
            </Pressable>
          </View>
        ) : null}

        {canBeWorkingNote ? (
          <View style={styles.actionsRow}>
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={setWorkingNoteFromDetail}>
              <Text style={styles.rowButtonSecondaryText}>
                Set as Working Note
              </Text>
            </Pressable>
          </View>
        ) : null}

        {showMoveChooser ? (
          <View style={styles.moveChooser}>
            <Text style={styles.moveChooserTitle}>Move to project:</Text>
            {projects.length === 0 ? (
              <Text style={styles.moveChooserEmpty}>
                No projects yet. Create one from its working note first.
              </Text>
            ) : (
              projects.map(project => (
                <Pressable
                  key={project.anchorPath}
                  style={styles.moveChoice}
                  onPress={() => moveDetailItem(project)}>
                  <Text style={styles.moveChoiceText}>
                    {project.anchorTitle}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        ) : null}

        {status ? <Text style={styles.status}>{status}</Text> : null}

        {item.kind === 'note' ? (
          <>
            {detailMeta && detailMeta.stars.length > 0 ? (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Starred Pages</Text>
                  <Text style={styles.count}>{detailMeta.stars.length}</Text>
                </View>
                <View style={styles.chipWrap}>
                  {detailMeta.stars.map(page => (
                    <Pressable
                      key={`star-${page}`}
                      style={styles.chip}
                      onPress={() => openNotePage(item, page)}>
                      <Text style={styles.chipText}>★ p.{page + 1}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Keywords</Text>
              <Pressable onPress={rescanDetailMeta}>
                <Text style={styles.rescanText}>Rescan</Text>
              </Pressable>
            </View>
            {detailMetaState === 'loading' ? (
              <Text style={styles.detailInfo}>Scanning note...</Text>
            ) : detailMetaState === 'error' ? (
              <Text style={styles.detailInfo}>
                Could not scan this note's keywords and headings.
              </Text>
            ) : detailMeta && detailMeta.keywords.length > 0 ? (
              <View style={styles.chipWrap}>
                {detailMeta.keywords.map((entry, index) => (
                  <Pressable
                    key={`${entry.keyword}-${entry.page}-${index}`}
                    style={styles.chip}
                    onPress={() => openNotePage(item, entry.page)}>
                    <Text style={styles.chipText}>
                      {entry.keyword} · p.{entry.page + 1}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text style={styles.detailInfo}>No keywords in this note.</Text>
            )}

            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Headings</Text>
            </View>
            {detailMetaState === 'loading' ? (
              <Text style={styles.detailInfo}>Scanning note...</Text>
            ) : detailMeta && detailMeta.headings.length > 0 ? (
              <>
                <View style={styles.chipWrap}>
                  {detailMeta.headings.map((entry, index) => (
                    <Pressable
                      key={`heading-${entry.key}-${index}`}
                      style={styles.chip}
                      onPress={() => openNotePage(item, entry.page)}
                      onLongPress={() => forgetHeading(entry.key)}
                      delayLongPress={400}>
                      <Text style={styles.chipText}>
                        {entry.text ?? '· · ·'} · p.{entry.page + 1}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.tapHint}>
                  Long-press a heading to clear a wrong recognition.
                </Text>
                {recognizing ? (
                  <Text style={styles.detailInfo}>
                    Recognizing {recognizing.done} of {recognizing.total}...
                  </Text>
                ) : detailMeta.headings.some(entry => entry.text === null) ? (
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={recognizeHeadings}>
                    <Text style={styles.secondaryButtonText}>
                      Recognize{' '}
                      {
                        detailMeta.headings.filter(entry => entry.text === null)
                          .length
                      }{' '}
                      new heading
                      {detailMeta.headings.filter(entry => entry.text === null)
                        .length === 1
                        ? ''
                        : 's'}
                    </Text>
                  </Pressable>
                ) : null}
              </>
            ) : detailMetaState === 'idle' ? (
              <Text style={styles.detailInfo}>No headings in this note.</Text>
            ) : null}

            {detailMeta && detailMeta.pageCount > 0 ? (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Pages</Text>
                  <Text style={styles.count}>{detailMeta.pageCount}</Text>
                </View>
                <View style={styles.chipWrap}>
                  {Array.from({length: detailMeta.pageCount}, (_, page) => (
                    <Pressable
                      key={`page-${page}`}
                      style={styles.pageChip}
                      onPress={() => openNotePage(item, page)}>
                      <Text style={styles.pageChipText}>{page + 1}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
          </>
        ) : null}

        <Pressable style={styles.secondaryButton} onPress={closeDetail}>
          <Text style={styles.secondaryButtonText}>Back to Shelf</Text>
        </Pressable>
      </>
    );
  }

  function renderCapture(activeCapture: NonNullable<typeof capture>): React.JSX.Element {
    return (
      <>
        <View style={styles.workingPanel}>
          <Text style={styles.eyebrow}>Capture Quote</Text>
          <Text style={styles.workingTitle}>
            {activeCapture.projectPath
              ? `Saving to ${activeCapture.projectTitle}`
              : 'Choose a project below'}
          </Text>
          <Text style={styles.detailMetaLine}>
            From {activeCapture.source.title} ·{' '}
            {formatPage(activeCapture.source.page)}
          </Text>
        </View>

        {!activeCapture.projectPath ? (
          <View style={styles.moveChooser}>
            <Text style={styles.moveChooserTitle}>Save to project:</Text>
            {projects.map(project => (
              <Pressable
                key={project.anchorPath}
                style={styles.moveChoice}
                onPress={() =>
                  setCapture({
                    ...activeCapture,
                    projectPath: project.anchorPath,
                    projectTitle: project.anchorTitle,
                  })
                }>
                <Text style={styles.moveChoiceText}>{project.anchorTitle}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <TextInput
          multiline
          style={styles.captureInput}
          value={activeCapture.text}
          onChangeText={text => setCapture({...activeCapture, text})}
          placeholder="No text was selected. Select text in the document before capturing, or type the quote here."
        />

        <View style={styles.actionsRow}>
          <Pressable style={styles.rowButton} onPress={saveCapture}>
            <Text style={styles.rowButtonText}>Save Quote</Text>
          </Pressable>
          <Pressable
            style={styles.rowButtonSecondary}
            onPress={() => setCapture(null)}>
            <Text style={styles.rowButtonSecondaryText}>Cancel</Text>
          </Pressable>
        </View>

        {status ? <Text style={styles.status}>{status}</Text> : null}
      </>
    );
  }

  function renderProjectQuotes(
    project: ShelfProject,
    isAnchor: boolean,
  ): React.JSX.Element | null {
    if (project.quotes.length === 0) {
      return null;
    }
    const noteTarget = projectNoteTarget(project);
    return (
      <View key={`quotes-${project.anchorPath}`}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{project.anchorTitle}</Text>
          <Text style={styles.count}>{project.quotes.length}</Text>
        </View>
        <Text style={styles.tapHint}>
          {noteTarget
            ? `Quotes place into ${noteTarget.title}, stacked from the bottom of its current page.`
            : 'Set a working note for this project to place its quotes.'}
        </Text>
        {project.quotes.map(quote => (
          <View key={quote.id} style={styles.quoteBox}>
            <Text numberOfLines={3} style={styles.quoteText}>
              “{quote.text}”
            </Text>
            <Text style={styles.quoteMeta}>
              — {quote.sourceTitle}, {formatPage(quote.sourcePage)}
            </Text>
            <View style={styles.actionsRow}>
              <Pressable
                style={styles.rowButton}
                onPress={() => placeQuote(project, quote, isAnchor)}>
                <Text style={styles.rowButtonText}>
                  {isAnchor
                    ? 'Place on This Page'
                    : `Open ${noteTarget?.title ?? 'Working Note'} to Place`}
                </Text>
              </Pressable>
              <Pressable
                style={styles.rowButtonSecondary}
                onPress={() => deleteQuote(project, quote.id)}>
                <Text style={styles.rowButtonSecondaryText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>
    );
  }

  function renderQuotesTab(): React.JSX.Element {
    const projectsWithQuotes = projects.filter(
      project => project.quotes.length > 0,
    );
    return (
      <>
        <View style={styles.workingPanel}>
          <Text style={styles.eyebrow}>Quotes</Text>
          <Text style={styles.workingEmpty}>
            Captured quotes wait here until you place them into their
            project's working note.
          </Text>
        </View>

        {status ? <Text style={styles.status}>{status}</Text> : null}

        {projectsWithQuotes.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>No quotes waiting.</Text>
            <Text style={styles.emptyBody}>
              Select text in a PDF or EPUB, then tap Capture Quote in the
              selection toolbar.
            </Text>
          </View>
        ) : (
          projectsWithQuotes.map(project =>
            renderProjectQuotes(
              project,
              context.kind === 'project' &&
                context.project.anchorPath === project.anchorPath &&
                context.isAnchor,
            ),
          )
        )}
      </>
    );
  }

  function renderCommonActions(): React.JSX.Element {
    return (
      <View style={styles.actionsRow}>
        <Pressable style={styles.rowButton} onPress={pinCurrent}>
          <Text style={styles.rowButtonText}>Pin This Page</Text>
        </Pressable>
        <Pressable style={styles.rowButtonSecondary} onPress={browseFiles}>
          <Text style={styles.rowButtonSecondaryText}>Browse</Text>
        </Pressable>
        <Pressable
          style={styles.rowButtonSecondary}
          onPress={() => PluginManager.closePluginView()}>
          <Text style={styles.rowButtonSecondaryText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  function renderShelfTab(): React.JSX.Element {
    if (context.kind === 'project') {
      const {project, isAnchor} = context;
      const isFolder = project.anchorKind === 'folder';
      const currentPath = currentTarget
        ? normalizeDevicePath(currentTarget.path)
        : null;
      // Header keeps the designation button only for first-time setup (the
      // working note may not be pinned yet); afterwards it moves to the
      // long-press detail of the shelf cards.
      const canBecomeWorkingNote =
        isFolder &&
        currentIsNote &&
        currentPath !== null &&
        project.workingNotePath === null;
      return (
        <>
          <Pressable
            style={styles.workingPanel}
            onPress={() => openAnchor(project)}>
            <Text style={styles.eyebrow}>
              {isFolder ? 'Folder Project' : 'Project'}
            </Text>
            <Text style={styles.workingTitle}>{project.anchorTitle}</Text>
            <Text style={styles.tapHint}>
              {isAnchor
                ? "You are in this project's working note. Tap to reopen it."
                : isFolder && project.workingNotePath
                  ? `Tap to reopen ${project.workingNoteTitle ?? 'the working note'}.`
                  : isFolder
                    ? 'Tap to open the project folder. No working note set yet.'
                    : 'Tap to reopen project note.'}
            </Text>
            {isFolder && (project.workingNotePath || canBecomeWorkingNote) ? (
              <View style={styles.workingActions}>
                {canBecomeWorkingNote ? (
                  <Pressable
                    style={[styles.button, styles.backButton]}
                    onPress={() => makeWorkingNote(project)}>
                    <Text style={styles.backButtonText}>
                      Make This the Working Note
                    </Text>
                  </Pressable>
                ) : null}
                {project.workingNotePath ? (
                  <Pressable
                    style={styles.folderLink}
                    onPress={() => openProjectFolder(project)}>
                    <Text style={styles.folderLinkText}>Open Folder</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </Pressable>

          {renderCommonActions()}
          {status ? <Text style={styles.status}>{status}</Text> : null}

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              {project.anchorTitle} Reference Shelf
            </Text>
            <Text style={styles.count}>{project.references.length}</Text>
          </View>

          {(() => {
            const workingTarget = projectNoteTarget(project);
            const workingCard = workingTarget
              ? {...workingTarget, id: WORKING_CARD_ID}
              : null;
            if (!workingCard && project.references.length === 0) {
              return (
                <View style={styles.emptyBox}>
                  <Text style={styles.emptyTitle}>
                    No references pinned yet.
                  </Text>
                  <Text style={styles.emptyBody}>
                    Open a source you want to keep handy for this project, then
                    tap Pin This Page.
                  </Text>
                </View>
              );
            }
            return (
              <View style={styles.grid}>
                {workingCard ? (
                  <ThumbCard
                    key={WORKING_CARD_ID}
                    item={workingCard}
                    widthPct={cardWidthPct}
                    badge="WORKING"
                    onOpen={() => openAnchor(project)}
                    onDetail={openDetail}
                  />
                ) : null}
                {project.references.map(item => (
                  <ThumbCard
                    key={item.id}
                    item={item}
                    widthPct={cardWidthPct}
                    onOpen={openItem}
                    onDetail={openDetail}
                  />
                ))}
              </View>
            );
          })()}
        </>
      );
    }

    return (
      <>
        <View style={styles.workingPanel}>
          <Text style={styles.eyebrow}>General Shelf</Text>
          <Text style={styles.workingEmpty}>
            {isReady
              ? 'This file is not part of a project. Pins made here go to the general shelf.'
              : 'Loading saved shelf...'}
          </Text>
          {currentIsNote && !currentIsAnchor ? (
            <View style={styles.workingActions}>
              <Pressable
                style={[styles.button, styles.backButton]}
                onPress={makeProject}>
                <Text style={styles.backButtonText}>
                  Make This a Project Note
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        {renderCommonActions()}
        {status ? <Text style={styles.status}>{status}</Text> : null}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>General Shelf</Text>
          <Text style={styles.count}>{generalItems.length}</Text>
        </View>

        {generalItems.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>Nothing on the shelf yet.</Text>
            <Text style={styles.emptyBody}>
              Open a file you want to keep handy, then tap Pin This Page.
            </Text>
          </View>
        ) : (
          renderGrid(generalItems)
        )}
      </>
    );
  }

  function renderProjectsTab(): React.JSX.Element {
    return (
      <>
        <View style={styles.workingPanel}>
          <Text style={styles.eyebrow}>Projects</Text>
          <Text style={styles.workingEmpty}>
            A project note shows only its own reference shelf. Deleting a
            project moves its references to the general shelf.
          </Text>
          <View style={styles.workingActions}>
            {currentIsNote && !currentIsAnchor ? (
              <Pressable
                style={[styles.button, styles.backButton]}
                onPress={makeProject}>
                <Text style={styles.backButtonText}>
                  Make Current Note a Project
                </Text>
              </Pressable>
            ) : null}
            {currentTarget ? (
              <Pressable
                style={[styles.button, styles.backButton]}
                onPress={makeFolderProject}>
                <Text style={styles.backButtonText}>
                  Make Current Folder a Project
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {status ? <Text style={styles.status}>{status}</Text> : null}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>All Projects</Text>
          <Text style={styles.count}>{projects.length}</Text>
        </View>

        {projects.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>No projects yet.</Text>
            <Text style={styles.emptyBody}>
              Open the note you write in for a class or topic, then tap Make
              Current Note a Project.
            </Text>
          </View>
        ) : (
          projects.map(project => (
            <View key={project.anchorPath} style={styles.item}>
              <Pressable
                style={styles.itemMain}
                onPress={() => openAnchor(project)}>
                <Text style={styles.itemTitle}>{project.anchorTitle}</Text>
                <Text style={styles.itemMeta}>
                  {project.anchorKind === 'folder' ? 'FOLDER · ' : 'NOTE · '}
                  {project.references.length}{' '}
                  {project.references.length === 1 ? 'reference' : 'references'}
                  {project.anchorKind === 'folder' && project.workingNoteTitle
                    ? ` · working: ${project.workingNoteTitle}`
                    : ''}
                </Text>
                <Text numberOfLines={1} style={styles.path}>
                  {project.anchorPath}
                </Text>
              </Pressable>
              <View style={styles.itemActions}>
                <Pressable
                  style={styles.openButton}
                  onPress={() => openAnchor(project)}>
                  <Text style={styles.openText}>Open</Text>
                </Pressable>
                <Pressable
                  style={styles.removeButton}
                  onPress={() => deleteProjectPressed(project)}>
                  <Text style={styles.removeText}>
                    {deleteArmedPath === project.anchorPath
                      ? 'Confirm'
                      : 'Delete'}
                  </Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
      </>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Shelf</Text>

        {capture ? (
          renderCapture(capture)
        ) : detailItem ? (
          renderDetail(detailItem)
        ) : (
          <>
            <View style={styles.tabBar}>
              <Pressable
                style={[styles.tab, tab === 'shelf' ? styles.tabActive : null]}
                onPress={() => setTab('shelf')}>
                <Text
                  style={[
                    styles.tabText,
                    tab === 'shelf' ? styles.tabTextActive : null,
                  ]}>
                  Shelf
                </Text>
              </Pressable>
              <Pressable
                style={[styles.tab, tab === 'quotes' ? styles.tabActive : null]}
                onPress={() => setTab('quotes')}>
                <Text
                  style={[
                    styles.tabText,
                    tab === 'quotes' ? styles.tabTextActive : null,
                  ]}>
                  {totalQuotes > 0 ? `Quotes (${totalQuotes})` : 'Quotes'}
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.tab,
                  tab === 'projects' ? styles.tabActive : null,
                ]}
                onPress={() => {
                  setDeleteArmedPath(null);
                  setTab('projects');
                }}>
                <Text
                  style={[
                    styles.tabText,
                    tab === 'projects' ? styles.tabTextActive : null,
                  ]}>
                  Projects
                </Text>
              </Pressable>
            </View>

            {tab === 'shelf'
              ? renderShelfTab()
              : tab === 'quotes'
                ? renderQuotesTab()
                : renderProjectsTab()}
          </>
        )}

        <Pressable style={styles.debugFooter} onPress={() => refresh()}>
          <Text style={styles.debugFooterText}>
            Detected file: {currentTarget?.path ?? 'none'} — tap to re-detect
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#f7f7f4',
  },
  content: {
    padding: 16,
  },
  title: {
    color: '#202020',
    fontSize: 26,
    fontWeight: '700',
    marginBottom: 10,
  },
  tabBar: {
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 2,
    flexDirection: 'row',
    marginBottom: 12,
    overflow: 'hidden',
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
  },
  tabActive: {
    backgroundColor: '#202020',
  },
  tabText: {
    color: '#202020',
    fontSize: 16,
    fontWeight: '800',
  },
  tabTextActive: {
    color: '#ffffff',
  },
  workingPanel: {
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 2,
    marginBottom: 12,
    padding: 12,
  },
  eyebrow: {
    color: '#202020',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.4,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  workingTitle: {
    color: '#202020',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 2,
  },
  tapHint: {
    color: '#555555',
    fontSize: 13,
    marginTop: 4,
  },
  workingEmpty: {
    color: '#202020',
    fontSize: 15,
    lineHeight: 21,
  },
  workingActions: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  backButton: {
    backgroundColor: '#ffffff',
    borderColor: '#202020',
    borderWidth: 2,
    minHeight: 50,
  },
  backButtonText: {
    color: '#202020',
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  button: {
    alignItems: 'center',
    backgroundColor: '#202020',
    borderRadius: 6,
    flex: 1,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  rowButton: {
    alignItems: 'center',
    backgroundColor: '#202020',
    borderRadius: 6,
    flex: 1,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 8,
  },
  rowButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  rowButtonSecondary: {
    alignItems: 'center',
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 8,
  },
  rowButtonSecondaryText: {
    color: '#202020',
    fontSize: 15,
    fontWeight: '700',
  },
  secondaryButton: {
    alignItems: 'center',
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 6,
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: '#202020',
    fontSize: 16,
    fontWeight: '700',
  },
  status: {
    color: '#202020',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    marginBottom: 8,
  },
  sectionTitle: {
    color: '#202020',
    flexShrink: 1,
    fontSize: 18,
    fontWeight: '800',
  },
  count: {
    color: '#202020',
    fontSize: 16,
    fontWeight: '700',
  },
  rescanText: {
    color: '#202020',
    fontSize: 14,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  emptyBox: {
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    padding: 14,
  },
  emptyTitle: {
    color: '#202020',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 4,
  },
  emptyBody: {
    color: '#202020',
    fontSize: 15,
    lineHeight: 21,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  card: {
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 2,
    overflow: 'hidden',
    padding: 6,
    width: '31.5%',
  },
  cardThumb: {
    aspectRatio: 0.75,
    backgroundColor: '#ffffff',
    borderColor: '#cccccc',
    borderWidth: 1,
    width: '100%',
  },
  cardGlyphBox: {
    alignItems: 'center',
    aspectRatio: 0.75,
    backgroundColor: '#ffffff',
    borderColor: '#cccccc',
    borderWidth: 1,
    justifyContent: 'center',
    width: '100%',
  },
  cardGlyph: {
    color: '#202020',
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 1,
  },
  cardCoverBox: {
    alignItems: 'center',
    aspectRatio: 0.75,
    backgroundColor: '#ffffff',
    borderColor: '#cccccc',
    borderWidth: 1,
    justifyContent: 'center',
    padding: 6,
    width: '100%',
  },
  cardCoverKind: {
    color: '#888888',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 6,
  },
  cardCoverTitle: {
    color: '#202020',
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 19,
    textAlign: 'center',
  },
  folderLink: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 10,
  },
  folderLinkText: {
    color: '#202020',
    fontSize: 14,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  cardBadge: {
    backgroundColor: '#202020',
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    textAlign: 'center',
  },
  cardTitle: {
    color: '#202020',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 4,
  },
  cardMeta: {
    color: '#555555',
    fontSize: 11,
    marginTop: 2,
  },
  detailMetaLine: {
    color: '#202020',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  detailPath: {
    color: '#555555',
    fontSize: 12,
  },
  detailInfo: {
    color: '#202020',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  chip: {
    borderColor: '#202020',
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: {
    color: '#202020',
    fontSize: 14,
    fontWeight: '700',
  },
  pageChip: {
    alignItems: 'center',
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 6,
  },
  pageChipText: {
    color: '#202020',
    fontSize: 14,
    fontWeight: '700',
  },
  item: {
    alignItems: 'stretch',
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 10,
    overflow: 'hidden',
  },
  itemMain: {
    flex: 1,
    padding: 12,
  },
  itemTitle: {
    color: '#202020',
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 4,
  },
  itemMeta: {
    color: '#202020',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  path: {
    color: '#555555',
    fontSize: 12,
  },
  itemActions: {
    borderLeftColor: '#202020',
    borderLeftWidth: 1,
    width: 96,
  },
  openButton: {
    alignItems: 'center',
    backgroundColor: '#202020',
    borderBottomColor: '#202020',
    borderBottomWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 8,
  },
  openText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '800',
  },
  removeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 10,
  },
  removeText: {
    color: '#202020',
    fontSize: 14,
    fontWeight: '700',
  },
  moveChooser: {
    borderColor: '#202020',
    borderRadius: 6,
    borderStyle: 'dashed',
    borderWidth: 1,
    marginBottom: 10,
    padding: 12,
  },
  moveChooserTitle: {
    color: '#202020',
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 8,
  },
  moveChooserEmpty: {
    color: '#202020',
    fontSize: 14,
    lineHeight: 19,
  },
  moveChoice: {
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 8,
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  moveChoiceText: {
    color: '#202020',
    fontSize: 15,
    fontWeight: '700',
  },
  captureInput: {
    backgroundColor: '#ffffff',
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    color: '#202020',
    fontSize: 17,
    lineHeight: 24,
    marginBottom: 10,
    minHeight: 180,
    padding: 12,
    textAlignVertical: 'top',
  },
  quoteBox: {
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 10,
    padding: 12,
  },
  quoteText: {
    color: '#202020',
    fontSize: 15,
    fontStyle: 'italic',
    lineHeight: 21,
    marginBottom: 6,
  },
  quoteMeta: {
    color: '#555555',
    fontSize: 13,
    marginBottom: 10,
  },
  debugFooter: {
    marginTop: 12,
    paddingVertical: 6,
  },
  debugFooterText: {
    color: '#888888',
    fontSize: 11,
  },
});
