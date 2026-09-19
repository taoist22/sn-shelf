import React, {useCallback, useEffect, useRef, useState} from 'react';
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
  normalizeDevicePath,
  projectNoteTarget,
  targetOpensAtLastUsedPage,
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
  saveCurrentNoteQuietly,
} from '../supernote/supernoteShelf';
import {
  addQuoteToProject,
  createProjectFromFolder,
  createProjectFromNote,
  flushShelfState,
  getGeneralItems,
  getInboxQuotes,
  hydrateShelfState,
  listAllPinnedTargets,
  listProjects,
  moveToProject,
  removeProject,
  removeQuoteFromInbox,
  removeQuoteFromProject,
  resolveShelfContext,
  saveGeneralItems,
  saveProjectReferences,
  setProjectWorkingNote,
  shiftDocumentPages,
} from '../storage/sessionShelf';
import {importInboxQuotes} from '../services/quoteInbox';
import {invalidateObstacleScans} from '../supernote/supernoteShelf';
import {pluginLifecycleAction} from '../supernote/pluginLifecycle';
import {
  ensureFileReadPermission,
  ensureFileWritePermission,
} from '../supernote/pluginPermissions';
import {
  MAX_INSERT_PAGES,
  clampInsertCount,
  pageAfterInsert,
  pageAfterUndo,
  planInsertMoves,
  planUndoMoves,
  rollbackMoves,
  type InsertBackground,
  type InsertPosition,
  type MarkMove,
} from '../domain/pdfInsertion';
import {
  clearPageMarks,
  getPdfUndo,
  insertPdfPages,
  movePageMarks,
  pageMarkCount,
  pdfEditErrorMessage,
  openFileAndWait,
  readMarkedPages,
  undoPdfInsert,
  type PdfInsertResult,
  type PdfUndoRecord,
} from '../supernote/pdfEdit';
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
import {FolderProjectPicker} from './FolderProjectPicker';
import {
  ShelfInkSurface,
  activateInk,
  clearInk,
  isInkAvailable,
  readInk,
  refreshInkRegion,
  releaseInk,
} from '../supernote/inkCapture';
import type {QuoteInk} from '../domain/quoteInk';
import {
  PlacementOverlay,
  type PlacementRequest,
  type PlacementResult,
} from './PlacementOverlay';

type TabKey = 'shelf' | 'quotes' | 'projects';

// Insert Page steps out of the PDF into a note while it edits the handwriting.
const NO_NOTE_MESSAGE =
  'Shelf needs to step out of this PDF into a note while it works. Open any note, open Shelf there once, then come back to this PDF and try again.';

type PdfInsertState = {
  path: string;
  title: string;
  /** Zero-based page the reader was on. */
  anchor: number;
  position: InsertPosition;
  count: number;
  background: InsertBackground;
  undo: PdfUndoRecord | null;
  /** Shown before inserting when the handwriting could not be read. */
  warning: string | null;
  /** Shown before undoing when the added pages have handwriting. */
  undoWarning: string | null;
  error: string;
};

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
        {targetOpensAtLastUsedPage(item)
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
  const [inboxQuotes, setInboxQuotes] = useState<ShelfQuote[]>([]);
  // Session-scoped placement preferences: source-link toggle + multi-select.
  const [includeLinks, setIncludeLinks] = useState(true);
  const [selectedQuoteIds, setSelectedQuoteIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [detailItem, setDetailItem] = useState<ShelfTarget | null>(null);
  const [detailMeta, setDetailMeta] = useState<ReferenceMeta | null>(null);
  const [detailMetaState, setDetailMetaState] = useState<
    'idle' | 'loading' | 'error'
  >('idle');
  const [showMoveChooser, setShowMoveChooser] = useState(false);
  const [showPinChooser, setShowPinChooser] = useState(false);
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
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [notePickerOpen, setNotePickerOpen] = useState(false);
  const [placement, setPlacement] = useState<PlacementRequest | null>(null);
  // Non-null while a placement is running: inserting handwriting takes a few
  // seconds, and returning to the quote list meanwhile looked like a failure.
  const [placing, setPlacing] = useState<string | null>(null);
  const [pdfInsert, setPdfInsert] = useState<PdfInsertState | null>(null);
  // Whether this firmware can run the pen engine; decided per capture.
  const [inkAvailable, setInkAvailable] = useState(false);
  // 'off' until the user taps Write a Note; then 'active' or the native
  // failure reason, shown on screen as-is.
  const [inkState, setInkState] = useState('off');
  const [status, setStatus] = useState('');
  const [isReady, setIsReady] = useState(false);
  const refreshGeneration = useRef(0);
  // The last note Shelf saw open this session: where Insert Page steps out to
  // when the PDF has no project note.
  const lastNoteRef = useRef<ShelfTarget | null>(null);
  // True while Insert Page / Undo is stepping between files. Opening another
  // file can fire lifecycle resets; they must not wipe the progress screen.
  const pdfOperationRef = useRef(false);
  const detailGeneration = useRef(0);

  // Placement failures render large and bold so the user can tell at a
  // glance why placement did not happen. Derived from the message text to
  // keep setStatus a plain state setter for the hooks-deps rule.
  const statusStrong =
    status.startsWith('No room') ||
    status.startsWith('Not enough room') ||
    status.includes('Turn the page') ||
    status.includes('handwriting could not');

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (!(await ensureFileReadPermission())) {
      if (generation === refreshGeneration.current) {
        setStatus('File access was not allowed. Grant file access, then reopen Shelf.');
      }
      return;
    }
    const current = await getCurrentTarget().catch(() => null);
    if (generation !== refreshGeneration.current) {
      return;
    }
    if (current?.kind === 'note') {
      lastNoteRef.current = current;
    }
    setCurrentTarget(current);
    setContext(resolveShelfContext(current?.path ?? null));
    setProjects([...listProjects()]);
    setGeneralItems([...getGeneralItems()]);
    setInboxQuotes([...getInboxQuotes()]);
  }, []);

  const startCapture = useCallback(async () => {
    // Pressing Capture Quote again also resets a stuck capture screen, and
    // clears a finished placement's screen (kept while the panel closed).
    await releaseInk();
    setInkState('off');
    setPlacing(null);
    setPlacement(null);
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
      setInkAvailable(await isInkAvailable());
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
    let ink: QuoteInk | undefined;
    if (inkState === 'active') {
      try {
        const read = await readInk();
        if (read.kind === 'too-large') {
          setStatus(
            'The handwritten note is too long to store with the quote. Clear it and write a shorter one.',
          );
          return;
        }
        ink = read.kind === 'ink' ? read.ink : undefined;
      } catch (error) {
        setStatus(`Could not read the handwriting: ${String(error)}`);
        return;
      }
    }
    await releaseInk();
    const quote: ShelfQuote = {
      id: `q-${Date.now()}`,
      text,
      sourcePath: capture.source.path,
      sourceTitle: capture.source.title,
      sourcePage: capture.source.page,
      sourceKind: capture.source.kind,
      capturedAt: Date.now(),
      ...(ink ? {ink} : {}),
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
  }, [capture, refresh, inkState]);

  // The pen engine is turned on ONLY from this tap, never on mount. Enabling
  // it while the capture screen was still drawing (build of 2026-09-18) left
  // everything outside the writing area undrawn, with taps seemingly reaching
  // the PDF underneath. The probe and sn-flashcards both enable it on a
  // settled screen.
  const startInk = useCallback(async () => {
    setInkState('starting…');
    setInkState(await activateInk());
  }, []);

  const cancelCapture = useCallback(async () => {
    await releaseInk();
    setInkState('off');
    setCapture(null);
  }, []);

  // Leaving the capture screen by any route releases the engine.
  const captureOpen = capture !== null;
  useEffect(() => {
    if (!captureOpen) {
      return;
    }
    return () => {
      releaseInk();
      setInkState('off');
    };
  }, [captureOpen]);

  const deleteQuote = useCallback(
    async (project: ShelfProject, quoteId: string) => {
      removeQuoteFromProject(project.anchorPath, quoteId);
      setStatus('Quote deleted.');
      await refresh();
    },
    [refresh],
  );

  // Tap-to-place: the panel turns into a transparent overlay over the note
  // and resolves with the tapped point (page px), or cancelled.
  const requestTap = useCallback(
    (label: string) =>
      new Promise<PlacementResult>(resolve => {
        setPlacement({label, resolve});
      }),
    [],
  );

  // One quote (project or imported) onto the open note, where the user taps:
  // text, source link, then the handwritten note. The quote leaves the queue
  // only once placed — and stays if its handwriting failed to go in, since
  // Shelf holds the only copy of that ink.
  const placeQuoteByTap = useCallback(
    async (quote: ShelfQuote, remove: () => void) => {
      const outcome = await requestTap(quote.ink ? 'the quote and your note' : 'the quote');
      setPlacement(null);
      if (outcome.kind === 'cancelled') {
        setStatus('Placement cancelled.');
        return;
      }
      setPlacing('Placing the quote…');
      let closed = false;
      try {
        const result = await insertQuoteIntoCurrentNote(quote, {
          includeLink: includeLinks,
          at: outcome.point,
          onProgress: setPlacing,
        });
        if (result.status === 'no-room-here') {
          setStatus(
            quote.ink
              ? 'Not enough room below that spot for the quote and your note — tap higher, or turn the page.'
              : 'Not enough room below that spot — tap higher, or turn the page.',
          );
        } else if (result.status === 'page-full') {
          // Only the auto-stacking path reports this; kept for completeness.
          setStatus('No room on this page — turn the page.');
        } else {
          if (!result.inkFailed) {
            remove();
          }
          await refresh();
          if (result.warning) {
            setStatus(result.warning);
          } else {
            // Stay on the placing screen while the panel closes; the next
            // open resets it.
            closed = true;
            PluginManager.closePluginView();
          }
        }
      } catch (error) {
        setStatus(`Could not place quote: ${String(error)}`);
      } finally {
        if (!closed) {
          // Back to the list, where the status explains what happened.
          setPlacing(null);
        }
      }
    },
    [refresh, includeLinks, requestTap],
  );

  // ---- Insert pages into the open PDF (docs/pdf-page-insertion-design.md) ----

  const openPdfInsert = useCallback(async () => {
    try {
      const current = await getCurrentTarget();
      if (current.kind !== 'pdf') {
        setStatus('Insert Page works on PDFs only.');
        return;
      }
      const undo = await getPdfUndo(current.path);
      setPdfInsert({
        path: current.path,
        title: current.title,
        anchor: Math.max(0, current.page),
        position: 'after',
        count: 1,
        background: 'lined',
        undo: undo && undo.path === current.path ? undo : null,
        warning: null,
        undoWarning: null,
        error: '',
      });
    } catch (error) {
      setStatus(`Could not read the open PDF: ${String(error)}`);
    }
  }, []);

  // Changing any choice drops an earlier warning: it described a different insert.
  const updatePdfInsert = useCallback((change: Partial<PdfInsertState>) => {
    setPdfInsert(previous =>
      previous
        ? {...previous, ...change, warning: null, undoWarning: null, error: ''}
        : previous,
    );
  }, []);

  // A note to step out to, so the PDF is CLOSED while its handwriting is
  // edited (the mark calls only write the .mark file for a closed PDF): the
  // PDF's project note, else the last note seen, else any project's note.
  const noteToStepOutTo = useCallback((): ShelfTarget | null => {
    if (context.kind === 'project') {
      const own = projectNoteTarget(context.project);
      if (own) {
        return own;
      }
    }
    if (lastNoteRef.current) {
      return lastNoteRef.current;
    }
    for (const project of projects) {
      const note = projectNoteTarget(project);
      if (note) {
        return note;
      }
    }
    return null;
  }, [context, projects]);

  // The PDF's handwriting is stored by page number, so after pages go in,
  // every later page's handwriting moves up to follow its page. That only
  // sticks with the PDF closed, so Shelf steps out to a note, edits, and
  // comes back. Any failure puts everything back as it was.
  const runPdfInsert = useCallback(
    async (confirmed: boolean) => {
      const request = pdfInsert;
      if (!request) {
        return;
      }
      if (!(await ensureFileReadPermission()) || !(await ensureFileWritePermission())) {
        setPdfInsert({...request, error: 'File access was not allowed, so the PDF was not changed.'});
        return;
      }
      // Read while the PDF is still open: getMarkPages is refused once it is closed.
      const marked = await readMarkedPages(request.path);
      if (marked === null && !confirmed) {
        setPdfInsert({
          ...request,
          warning:
            "Shelf couldn't read this PDF's handwriting, so it can't move it with the pages. Handwriting after the insert point may end up on the wrong pages.",
          error: '',
        });
        return;
      }
      const stepOut = noteToStepOutTo();
      if (!stepOut) {
        setPdfInsert({...request, warning: null, error: NO_NOTE_MESSAGE});
        return;
      }

      pdfOperationRef.current = true;
      const fail = async (message: string, reopenPdf: boolean) => {
        if (reopenPdf) {
          await openFileAndWait(request.path, request.anchor);
        }
        pdfOperationRef.current = false;
        setPlacing(null);
        setPdfInsert({...request, warning: null, error: message});
      };

      setPlacing('Closing the PDF…');
      if (!(await openFileAndWait(stepOut.path, -1))) {
        await fail(`Couldn't step out of the PDF into ${stepOut.title}, so nothing was changed.`, true);
        return;
      }

      const plural = request.count === 1 ? '' : 's';
      setPlacing(`Adding ${request.count} page${plural} to the PDF…`);
      let result: PdfInsertResult;
      try {
        result = await insertPdfPages(
          request.path,
          request.anchor,
          request.position,
          request.count,
          request.background,
        );
      } catch (error) {
        await fail(pdfEditErrorMessage(error), true);
        return;
      }

      const moves = marked ? planInsertMoves(marked, result.firstInsertedIndex, result.count) : [];
      const done: MarkMove[] = [];
      try {
        for (const [index, move] of moves.entries()) {
          setPlacing(`Moving your handwriting… page ${index + 1} of ${moves.length}`);
          if (await movePageMarks(request.path, move.from, move.to)) {
            done.push(move);
          }
        }
      } catch (error) {
        setPlacing('Something went wrong — putting everything back…');
        let restored = true;
        for (const back of rollbackMoves(done)) {
          try {
            await movePageMarks(request.path, back.from, back.to);
          } catch {
            restored = false;
          }
        }
        try {
          await undoPdfInsert(request.path);
        } catch {
          restored = false;
        }
        await fail(
          restored
            ? `Couldn't move your handwriting (${pdfEditErrorMessage(error)}), so nothing was changed.`
            : `Couldn't move your handwriting (${pdfEditErrorMessage(error)}), and putting it back also failed. Some handwriting may be on the wrong pages.`,
          true,
        );
        return;
      }

      shiftDocumentPages(request.path, page =>
        pageAfterInsert(page, result.firstInsertedIndex, result.count),
      );
      await flushShelfState();
      setPlacing('Opening the new page…');
      await openFileAndWait(request.path, result.firstInsertedIndex);
      pdfOperationRef.current = false;
      PluginManager.closePluginView();
    },
    [pdfInsert, noteToStepOutTo],
  );

  // Reverse of the insert, also with the PDF closed: handwriting on the added
  // pages goes with them (asked first), later pages' handwriting moves back
  // down, then the PDF is restored from its backup.
  const runPdfUndo = useCallback(
    async (confirmed: boolean) => {
      const request = pdfInsert;
      const record = request?.undo;
      if (!request || !record) {
        return;
      }
      if (record.matches === false) {
        setPdfInsert({
          ...request,
          error: 'This PDF has changed since the pages were added, so it can no longer be undone.',
        });
        return;
      }
      if (!(await ensureFileReadPermission()) || !(await ensureFileWritePermission())) {
        setPdfInsert({...request, error: 'File access was not allowed, so nothing was undone.'});
        return;
      }
      const marked = await readMarkedPages(request.path);
      if (marked === null) {
        setPdfInsert({
          ...request,
          error: "Shelf couldn't read this PDF's handwriting, so undo was not done.",
        });
        return;
      }
      const plan = planUndoMoves(marked, record.firstInsertedIndex, record.count);
      const inkedAdded: number[] = [];
      for (const page of plan.clear) {
        if ((await pageMarkCount(request.path, page)) > 0) {
          inkedAdded.push(page);
        }
      }
      if (inkedAdded.length > 0 && !confirmed) {
        setPdfInsert({
          ...request,
          undoWarning: `You wrote on ${inkedAdded.length} of the added page${
            inkedAdded.length === 1 ? '' : 's'
          }. Undo removes those pages and that writing.`,
          error: '',
        });
        return;
      }
      const stepOut = noteToStepOutTo();
      if (!stepOut) {
        setPdfInsert({...request, undoWarning: null, error: NO_NOTE_MESSAGE});
        return;
      }

      pdfOperationRef.current = true;
      setPlacing('Closing the PDF…');
      if (!(await openFileAndWait(stepOut.path, -1))) {
        await openFileAndWait(request.path, request.anchor);
        pdfOperationRef.current = false;
        setPlacing(null);
        setPdfInsert({
          ...request,
          undoWarning: null,
          error: `Couldn't step out of the PDF into ${stepOut.title}, so nothing was undone.`,
        });
        return;
      }

      setPlacing('Putting your handwriting back…');
      const done: MarkMove[] = [];
      try {
        for (const page of inkedAdded) {
          await clearPageMarks(request.path, page);
        }
        for (const move of plan.moves) {
          if (await movePageMarks(request.path, move.from, move.to)) {
            done.push(move);
          }
        }
        setPlacing('Removing the added pages…');
        await undoPdfInsert(request.path);
      } catch (error) {
        for (const back of rollbackMoves(done)) {
          try {
            await movePageMarks(request.path, back.from, back.to);
          } catch {
            // reported below
          }
        }
        await openFileAndWait(request.path, request.anchor);
        pdfOperationRef.current = false;
        setPlacing(null);
        setPdfInsert({
          ...request,
          undoWarning: null,
          error: `Undo did not finish (${pdfEditErrorMessage(error)}). The added pages are still in the PDF.`,
        });
        return;
      }

      shiftDocumentPages(request.path, page =>
        pageAfterUndo(page, record.firstInsertedIndex, record.count, record.originalCount),
      );
      await flushShelfState();
      setPlacing('Reopening the PDF…');
      await openFileAndWait(
        request.path,
        Math.min(record.firstInsertedIndex, record.originalCount - 1),
      );
      pdfOperationRef.current = false;
      PluginManager.closePluginView();
    },
    [pdfInsert, noteToStepOutTo],
  );

  // Outside a note, a project quote's main button opens its working note.
  const openWorkingNote = useCallback(async (project: ShelfProject) => {
    const target = projectNoteTarget(project);
    if (!target) {
      setStatus('Open a note (or use Choose a Note…) to place this quote.');
      return;
    }
    try {
      await openShelfTarget(target, {atLastUsedPage: true});
    } catch (error) {
      setStatus(`Could not open working note: ${String(error)}`);
    }
  }, []);

  const deleteInboxQuote = useCallback(
    async (quoteId: string) => {
      removeQuoteFromInbox(quoteId);
      setStatus('Quote deleted.');
      await refresh();
    },
    [refresh],
  );

  const openChosenNote = useCallback(async (notePath: string) => {
    await openShelfTarget(
      {
        id: `note-picker-${notePath}`,
        path: notePath,
        title: fileTitle(notePath),
        page: 0,
        kind: 'note',
        addedAt: Date.now(),
      },
      {atLastUsedPage: true},
    );
    setNotePickerOpen(false);
  }, []);

  const toggleQuoteSelected = useCallback((quoteId: string) => {
    setSelectedQuoteIds(previous => {
      const next = new Set(previous);
      if (next.has(quoteId)) {
        next.delete(quoteId);
      } else {
        next.add(quoteId);
      }
      return next;
    });
  }, []);

  // Places every selected quote on the CURRENT note page (any note).
  // Inserts stay sequential (parallel inserts freeze the device) and the
  // note is saved once at the end.
  const placeSelected = useCallback(async () => {
    if (currentTarget?.kind !== 'note') {
      return;
    }
    const batch: Array<{quote: ShelfQuote; remove: () => void}> = [
      ...inboxQuotes
        .filter(quote => selectedQuoteIds.has(quote.id))
        .map(quote => ({
          quote,
          remove: () => removeQuoteFromInbox(quote.id),
        })),
      ...projects.flatMap(project =>
        project.quotes
          .filter(quote => selectedQuoteIds.has(quote.id))
          .map(quote => ({
            quote,
            remove: () => removeQuoteFromProject(project.anchorPath, quote.id),
          })),
      ),
    ];
    if (batch.length === 0) {
      return;
    }
    setPlacing(`Placing ${batch.length} quote${batch.length === 1 ? '' : 's'}…`);
    let placed = 0;
    let linkWarnings = 0;
    let inkFailures = 0;
    let pageFull: {neededLines: number; availableLines: number} | null = null;
    let failure: string | null = null;
    for (const [index, entry] of batch.entries()) {
      const prefix = batch.length > 1 ? `Quote ${index + 1} of ${batch.length}: ` : '';
      setPlacing(`${prefix}Placing the quote…`);
      try {
        const result = await insertQuoteIntoCurrentNote(entry.quote, {
          includeLink: includeLinks,
          skipSave: true,
          strictFit: true,
          onProgress: message => setPlacing(`${prefix}${message}`),
        });
        if (result.status === 'page-full') {
          pageFull = result;
          break;
        }
        if (result.status === 'no-room-here') {
          // Tap placement only; batches never pass a tap point.
          break;
        }
        if (result.inkFailed) {
          // Text is on the page but the handwriting is not: keep the quote
          // so its ink (held only by Shelf) is not lost.
          inkFailures += 1;
          placed += 1;
          continue;
        }
        if (result.warning) {
          linkWarnings += 1;
        }
      } catch (error) {
        failure = String(error);
        break;
      }
      entry.remove();
      setSelectedQuoteIds(previous => {
        const next = new Set(previous);
        next.delete(entry.quote.id);
        return next;
      });
      placed += 1;
    }
    await saveCurrentNoteQuietly();
    await refresh();
    if (inkFailures > 0) {
      setStatus(
        `Placed ${placed} of ${batch.length}, but the handwriting could not be inserted for ${inkFailures}. Those quotes stay in Shelf so the handwriting is not lost.`,
      );
    } else if (failure) {
      setStatus(`Placed ${placed} of ${batch.length}: ${failure}`);
    } else if (pageFull) {
      setStatus(
        `Placed ${placed} of ${batch.length} — the next quote needs ~${pageFull.neededLines} lines but only ~${pageFull.availableLines} are clear. Turn the page and place the rest.`,
      );
    } else {
      setStatus(
        linkWarnings > 0
          ? `Placed ${placed} quote${placed === 1 ? '' : 's'}; ${linkWarnings} source link${linkWarnings === 1 ? '' : 's'} could not be inserted.`
          : `Placed ${placed} quote${placed === 1 ? '' : 's'}.`,
      );
      // Stay on the placing screen while the panel closes.
      PluginManager.closePluginView();
      return;
    }
    setPlacing(null);
  }, [currentTarget, projects, inboxQuotes, selectedQuoteIds, includeLinks, refresh]);

  // Opening the Quotes tab drains INBOX/shelf-quote-*.txt into the
  // imported-quotes inbox (files are deleted once the state is saved).
  useEffect(() => {
    if (tab !== 'quotes') {
      return;
    }
    importInboxQuotes()
      .then(added => {
        if (added > 0) {
          setStatus(`Imported ${added} quote${added === 1 ? '' : 's'}.`);
        }
        return refresh();
      })
      .catch(() => {});
  }, [tab, refresh]);

  const closeDetail = useCallback(() => {
    detailGeneration.current += 1;
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

    const resetPanel = () => {
      if (pdfOperationRef.current) {
        // Insert Page / Undo is mid-way between files; it owns the screen.
        return;
      }
      refreshGeneration.current += 1;
      detailGeneration.current += 1;
      setTab('shelf');
      setDetailItem(null);
      setDetailMeta(null);
      setDetailMetaState('idle');
      setShowMoveChooser(false);
      releaseInk();
      setInkState('off');
      setCapture(null);
      setPlacement(null);
      setPlacing(null);
      setPdfInsert(null);
      setDeleteArmedPath(null);
      setSelectedQuoteIds(new Set());
      setShowPinChooser(false);
      setStatus('');
    };

    const sub = PluginManager.registerPluginLifeListener({
      onMsg(message) {
        const action = pluginLifecycleAction(message);
        if (action === 'refresh') {
          refresh();
        } else if (action === 'reset') {
          resetPanel();
        }
      },
    });

    // The panel can stay mounted across opens without onStart firing; the
    // toolbar button press (relayed from index.js) always does.
    const openedSub = DeviceEventEmitter.addListener(SHELF_OPENED_EVENT, () => {
      resetPanel();
      // Reopening must not show the previous visit's tab or status (the
      // panel stays mounted, so onStop cannot be relied on for this).
      // The user may have written on pages since the last visit; placement
      // must see that ink.
      invalidateObstacleScans();
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
    const generation = ++detailGeneration.current;
    setDetailItem(item);
    setDetailMeta(null);
    setShowMoveChooser(false);
    if (item.kind === 'note') {
      setDetailMetaState('loading');
      scanNoteMeta(item.path)
        .then(meta => {
          if (generation !== detailGeneration.current) {
            return;
          }
          setDetailMeta(meta);
          setDetailMetaState('idle');
        })
        .catch(() => {
          if (generation === detailGeneration.current) {
            setDetailMetaState('error');
          }
        });
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

  // Adds the CURRENT file straight to a chosen project's shelf — the
  // shortcut for "I'm reading something outside the project and want it in".
  const pinCurrentToProject = useCallback(
    async (anchorPath: string, anchorTitle: string) => {
      try {
        const target = await getCurrentTarget();
        const project = listProjects().find(
          entry => entry.anchorPath === anchorPath,
        );
        if (!project) {
          setStatus('That project no longer exists.');
          setShowPinChooser(false);
          return;
        }
        const next = [
          target,
          ...project.references.filter(
            item => item.path !== target.path || item.page !== target.page,
          ),
        ];
        saveProjectReferences(anchorPath, next);
        setShowPinChooser(false);
        setStatus(`Added ${target.title} to ${anchorTitle}.`);
        await refresh();
      } catch (error) {
        setStatus(`Could not add to project: ${String(error)}`);
      }
    },
    [refresh],
  );

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
      const atLastUsed = targetOpensAtLastUsedPage(target);
      await openShelfTarget(target, {atLastUsedPage: atLastUsed});
      setStatus(
        atLastUsed
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
      await openShelfTarget({...item, page, openAtLastUsed: false});
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

  const chooseFolderProject = useCallback(async (folder: string) => {
    createProjectFromFolder(folder, fileTitle(folder));
    if (!(await flushShelfState())) {
      throw new Error('Could not save the folder project.');
    }
    setStatus(`${fileTitle(folder)} folder is now a project.`);
    await refresh();
    setFolderPickerOpen(false);
  }, [refresh]);

  const folderPickerStart = (() => {
    if (!currentTarget?.path) {
      return '/storage/emulated/0/Note';
    }
    const normalized = normalizeDevicePath(currentTarget.path);
    const slash = normalized.lastIndexOf('/');
    return slash > 0 ? normalized.slice(0, slash) : '/storage/emulated/0/Note';
  })();

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

  const totalQuotes =
    projects.reduce((sum, project) => sum + project.quotes.length, 0) +
    inboxQuotes.length;
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
            {targetOpensAtLastUsedPage(item)
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

        {status ? (
          <Text style={statusStrong ? styles.statusStrong : styles.status}>
            {status}
          </Text>
        ) : null}

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

  function inkStateLabel(): string {
    if (inkState === 'off') {
      return 'Optional: tap Write a Note to handwrite about this quote.';
    }
    if (inkState === 'active') {
      return 'Writing on — use the pen in the box below.';
    }
    if (inkState === 'starting…') {
      return 'Starting…';
    }
    return `Could not start writing: ${inkState}`;
  }

  // Capture screen, laid out like sn-flashcards' study screen (proven on
  // device): the quote where the question would be, and a note section with
  // ONE row of controls above a fixed-height writing area. The note section
  // is anchored to the BOTTOM of the panel and the quote box takes whatever
  // height is left, so nothing above can move the writing area — the pen
  // engine derives its writable region from where the host is when it binds.
  // Nothing tappable sits below the writing area (a resting palm).
  function renderCapture(activeCapture: NonNullable<typeof capture>): React.JSX.Element {
    const writing = inkState === 'active';
    return (
      <View style={styles.captureRoot}>
        <Text style={styles.title}>Shelf</Text>
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
          <ScrollView style={styles.captureChooser}>
            <Text style={styles.moveChooserTitle}>Save to project:</Text>
            {projects.map(project => (
              <Pressable
                key={project.anchorPath}
                style={styles.moveChoice}
                onPress={() => {
                  setCapture({
                    ...activeCapture,
                    projectPath: project.anchorPath,
                    projectTitle: project.anchorTitle,
                  });
                  // The chooser disappears, moving everything below it.
                  if (writing) {
                    refreshInkRegion();
                  }
                }}>
                <Text style={styles.moveChoiceText}>{project.anchorTitle}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}

        {status ? (
          <Text style={statusStrong ? styles.statusStrong : styles.status}>
            {status}
          </Text>
        ) : null}

        <View style={[styles.captureSection, styles.captureQuoteSection]}>
          <Text style={styles.captureHeading}>QUOTE</Text>
          <TextInput
            multiline
            style={styles.captureQuote}
            value={activeCapture.text}
            onChangeText={text => setCapture({...activeCapture, text})}
            // The handwriting keyboard can shift the window; re-read the
            // writing area's position afterwards (keeps the ink).
            onBlur={() => {
              if (writing) {
                refreshInkRegion();
              }
            }}
            placeholder="No text was selected. Select text in the document before capturing, or type the quote here."
          />
        </View>

        <View style={styles.captureSection}>
          <Text style={styles.captureHeading}>YOUR NOTE</Text>
          <View style={styles.captureControls}>
            <Pressable style={styles.rowButton} onPress={saveCapture}>
              <Text style={styles.rowButtonText}>Save Quote</Text>
            </Pressable>
            {inkAvailable ? (
              writing ? (
                <Pressable style={styles.rowButtonSecondary} onPress={() => clearInk()}>
                  <Text style={styles.rowButtonSecondaryText}>Clear Writing</Text>
                </Pressable>
              ) : (
                <Pressable style={styles.rowButtonSecondary} onPress={startInk}>
                  <Text style={styles.rowButtonSecondaryText}>Write a Note</Text>
                </Pressable>
              )
            ) : null}
            <Pressable style={styles.rowButtonSecondary} onPress={cancelCapture}>
              <Text style={styles.rowButtonSecondaryText}>Cancel</Text>
            </Pressable>
          </View>
          {inkAvailable ? (
            <>
              <Text numberOfLines={1} style={styles.captureInkHint}>
                {inkStateLabel()}
              </Text>
              <View style={styles.inkBoundary} />
              <ShelfInkSurface style={styles.captureInk} />
            </>
          ) : null}
        </View>
      </View>
    );
  }

  function renderChoice(
    label: string,
    selected: boolean,
    onPress: () => void,
  ): React.JSX.Element {
    return (
      <Pressable
        key={label}
        style={selected ? styles.rowButton : styles.rowButtonSecondary}
        onPress={onPress}>
        <Text style={selected ? styles.rowButtonText : styles.rowButtonSecondaryText}>
          {label}
        </Text>
      </Pressable>
    );
  }

  function renderPdfInsert(request: PdfInsertState): React.JSX.Element {
    const pageLabel = `page ${request.anchor + 1}`;
    const plural = request.count === 1 ? '' : 's';
    const undo = request.undo;
    return (
      <>
        <View style={styles.workingPanel}>
          <Text style={styles.eyebrow}>{'Insert Page'}</Text>
          <Text style={styles.workingTitle}>{request.title}</Text>
          <Text style={styles.detailMetaLine}>{`You are on ${pageLabel}.`}</Text>
        </View>

        <Text style={styles.captureHeading}>{'WHERE'}</Text>
        <View style={styles.actionsRow}>
          {renderChoice(`Before ${pageLabel}`, request.position === 'before', () =>
            updatePdfInsert({position: 'before'}),
          )}
          {renderChoice(`After ${pageLabel}`, request.position === 'after', () =>
            updatePdfInsert({position: 'after'}),
          )}
        </View>

        <Text style={styles.captureHeading}>{'PAGES'}</Text>
        <View style={styles.actionsRow}>
          <Pressable
            style={styles.rowButtonSecondary}
            onPress={() => updatePdfInsert({count: clampInsertCount(request.count - 1)})}>
            <Text style={styles.rowButtonSecondaryText}>{'−'}</Text>
          </Pressable>
          <Text style={styles.pdfInsertCount}>{`${request.count}`}</Text>
          <Pressable
            style={styles.rowButtonSecondary}
            onPress={() => updatePdfInsert({count: clampInsertCount(request.count + 1)})}>
            <Text style={styles.rowButtonSecondaryText}>{'+'}</Text>
          </Pressable>
          <Text style={styles.captureInkHint}>{`Up to ${MAX_INSERT_PAGES} at a time.`}</Text>
        </View>

        <Text style={styles.captureHeading}>{'BACKGROUND'}</Text>
        <View style={styles.actionsRow}>
          {renderChoice('Blank', request.background === 'blank', () =>
            updatePdfInsert({background: 'blank'}),
          )}
          {renderChoice('Lined (8 mm)', request.background === 'lined', () =>
            updatePdfInsert({background: 'lined'}),
          )}
        </View>

        {request.warning ? (
          <View style={styles.pdfInsertWarning}>
            <Text style={styles.statusStrong}>{request.warning}</Text>
          </View>
        ) : null}

        {request.error ? <Text style={styles.statusStrong}>{request.error}</Text> : null}

        <View style={styles.actionsRow}>
          <Pressable
            style={styles.rowButton}
            onPress={() => runPdfInsert(request.warning !== null)}>
            <Text style={styles.rowButtonText}>
              {request.warning ? 'Insert Anyway' : `Insert ${request.count} Page${plural}`}
            </Text>
          </Pressable>
          <Pressable style={styles.rowButtonSecondary} onPress={() => setPdfInsert(null)}>
            <Text style={styles.rowButtonSecondaryText}>{'Cancel'}</Text>
          </Pressable>
        </View>

        {undo ? (
          <View style={styles.pdfInsertUndo}>
            <Text style={styles.detailMetaLine}>
              {`Last insert: ${undo.count} page${undo.count === 1 ? '' : 's'} at page ${
                undo.firstInsertedIndex + 1
              }.`}
            </Text>
            {request.undoWarning ? (
              <Text style={styles.statusStrong}>{request.undoWarning}</Text>
            ) : null}
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={() => runPdfUndo(request.undoWarning !== null)}>
              <Text style={styles.rowButtonSecondaryText}>
                {request.undoWarning ? 'Undo Anyway' : 'Undo Last Insert'}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </>
    );
  }

  function renderChooseNoteAction(): React.JSX.Element | null {
    if (currentIsNote) {
      return null;
    }
    return (
      <Pressable
        style={styles.rowButtonSecondary}
        onPress={() => setNotePickerOpen(true)}>
        <Text style={styles.rowButtonSecondaryText}>Choose a Note…</Text>
      </Pressable>
    );
  }

  function renderSelectToggle(quote: ShelfQuote): React.JSX.Element {
    const selected = selectedQuoteIds.has(quote.id);
    return (
      <Pressable
        style={selected ? styles.rowButton : styles.rowButtonSecondary}
        onPress={() => toggleQuoteSelected(quote.id)}>
        <Text style={selected ? styles.rowButtonText : styles.rowButtonSecondaryText}>
          {selected ? '✓ Selected' : 'Select'}
        </Text>
      </Pressable>
    );
  }

  function renderInkNote(quote: ShelfQuote): React.JSX.Element | null {
    return quote.ink ? (
      <Text style={styles.quoteMeta}>{'✎ With your handwritten note'}</Text>
    ) : null;
  }

  function renderProjectQuotes(
    project: ShelfProject,
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
          {currentIsNote
            ? 'Tap Place, then tap the spot on the page where the quote should start.'
            : noteTarget
              ? `Open a note to place quotes — ${noteTarget.title} is this project's working note.`
              : 'Open a note to place quotes, or use Choose a Note….'}
        </Text>
        {project.quotes.map(quote => (
          <View key={quote.id} style={styles.quoteBox}>
            <Text numberOfLines={3} style={styles.quoteText}>
              “{quote.text}”
            </Text>
            <Text style={styles.quoteMeta}>
              — {quote.sourceTitle}, {formatPage(quote.sourcePage)}
            </Text>
            {renderInkNote(quote)}
            <View style={styles.actionsRow}>
              {currentIsNote ? renderSelectToggle(quote) : null}
              {currentIsNote || noteTarget ? (
                <Pressable
                  style={styles.rowButton}
                  onPress={() =>
                    currentIsNote
                      ? placeQuoteByTap(quote, () =>
                          removeQuoteFromProject(project.anchorPath, quote.id),
                        )
                      : openWorkingNote(project)
                  }>
                  <Text style={styles.rowButtonText}>
                    {currentIsNote
                      ? 'Place'
                      : `Open ${noteTarget?.title ?? 'Working Note'}`}
                  </Text>
                </Pressable>
              ) : null}
              {renderChooseNoteAction()}
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

  function renderImportedQuotes(): React.JSX.Element | null {
    if (inboxQuotes.length === 0) {
      return null;
    }
    return (
      <View key="quotes-imported">
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Imported</Text>
          <Text style={styles.count}>{inboxQuotes.length}</Text>
        </View>
        <Text style={styles.tapHint}>
          {currentIsNote
            ? 'Tap Place, then tap the spot on the page where the quote should start.'
            : 'Open a note to place imported quotes, or use Choose a Note….'}
        </Text>
        {inboxQuotes.map(quote => (
          <View key={quote.id} style={styles.quoteBox}>
            <Text numberOfLines={3} style={styles.quoteText}>
              “{quote.text}”
            </Text>
            <Text style={styles.quoteMeta}>
              — Imported {new Date(quote.capturedAt).toLocaleDateString()}
            </Text>
            {renderInkNote(quote)}
            <View style={styles.actionsRow}>
              {currentIsNote ? (
                <>
                  {renderSelectToggle(quote)}
                  <Pressable
                    style={styles.rowButton}
                    onPress={() =>
                      placeQuoteByTap(quote, () => removeQuoteFromInbox(quote.id))
                    }>
                    <Text style={styles.rowButtonText}>Place</Text>
                  </Pressable>
                </>
              ) : null}
              {renderChooseNoteAction()}
              <Pressable
                style={styles.rowButtonSecondary}
                onPress={() => deleteInboxQuote(quote.id)}>
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
    const selectedPlaceable = currentIsNote
      ? inboxQuotes.filter(quote => selectedQuoteIds.has(quote.id)).length +
        projects.reduce(
          (sum, project) =>
            sum + project.quotes.filter(quote => selectedQuoteIds.has(quote.id)).length,
          0,
        )
      : 0;
    return (
      <>
        <View style={styles.workingPanel}>
          <Text style={styles.eyebrow}>Quotes</Text>
          <Text style={styles.workingEmpty}>
            Captured quotes wait here until you place them on a note page —
            any note, not just the project's working note.
          </Text>
          <View style={styles.actionsRow}>
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={() => setIncludeLinks(value => !value)}>
              <Text style={styles.rowButtonSecondaryText}>
                Source links: {includeLinks ? 'On' : 'Off'}
              </Text>
            </Pressable>
            {selectedPlaceable > 0 ? (
              <Pressable style={styles.rowButton} onPress={placeSelected}>
                <Text style={styles.rowButtonText}>
                  Place {selectedPlaceable} Here
                </Text>
              </Pressable>
            ) : null}
            {selectedQuoteIds.size > 0 ? (
              <Pressable
                style={styles.rowButtonSecondary}
                onPress={() => setSelectedQuoteIds(new Set())}>
                <Text style={styles.rowButtonSecondaryText}>Clear</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={() => PluginManager.closePluginView()}>
              <Text style={styles.rowButtonSecondaryText}>Close</Text>
            </Pressable>
          </View>
        </View>

        {status ? (
          <Text style={statusStrong ? styles.statusStrong : styles.status}>
            {status}
          </Text>
        ) : null}

        {projectsWithQuotes.length === 0 && inboxQuotes.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>No quotes waiting.</Text>
            <Text style={styles.emptyBody}>
              Select text in a PDF or EPUB, then tap Capture Quote in the
              selection toolbar.
            </Text>
          </View>
        ) : (
          <>
            {renderImportedQuotes()}
            {projectsWithQuotes.map(project => renderProjectQuotes(project))}
          </>
        )}
      </>
    );
  }

  function renderCommonActions(): React.JSX.Element {
    const canPinToProject = context.kind !== 'project' && projects.length > 0;
    return (
      <>
        <View style={styles.actionsRow}>
          <Pressable style={styles.rowButton} onPress={pinCurrent}>
            <Text style={styles.rowButtonText}>Pin This Page</Text>
          </Pressable>
          {canPinToProject ? (
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={() => setShowPinChooser(current => !current)}>
              <Text style={styles.rowButtonSecondaryText}>Add to Project…</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.rowButtonSecondary} onPress={browseFiles}>
            <Text style={styles.rowButtonSecondaryText}>Browse</Text>
          </Pressable>
          {currentTarget?.kind === 'pdf' ? (
            <Pressable style={styles.rowButtonSecondary} onPress={openPdfInsert}>
              <Text style={styles.rowButtonSecondaryText}>Insert Page…</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={styles.rowButtonSecondary}
            onPress={() => PluginManager.closePluginView()}>
            <Text style={styles.rowButtonSecondaryText}>Close</Text>
          </Pressable>
        </View>
        {canPinToProject && showPinChooser ? (
          <View style={styles.moveChooser}>
            <Text style={styles.moveChooserTitle}>Add this file to:</Text>
            {projects.map(project => (
              <Pressable
                key={`pin-${project.anchorPath}`}
                style={styles.moveChoice}
                onPress={() =>
                  pinCurrentToProject(project.anchorPath, project.anchorTitle)
                }>
                <Text style={styles.moveChoiceText}>{project.anchorTitle}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </>
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
          {status ? (
          <Text style={statusStrong ? styles.statusStrong : styles.status}>
            {status}
          </Text>
        ) : null}

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
        {status ? (
          <Text style={statusStrong ? styles.statusStrong : styles.status}>
            {status}
          </Text>
        ) : null}

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
          <View style={styles.actionsRow}>
            <Pressable
              style={styles.rowButtonSecondary}
              onPress={() => PluginManager.closePluginView()}>
              <Text style={styles.rowButtonSecondaryText}>Close</Text>
            </Pressable>
          </View>
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
            <Pressable
              style={[styles.button, styles.backButton]}
              onPress={() => setFolderPickerOpen(true)}>
              <Text style={styles.backButtonText}>Choose Folder Project…</Text>
            </Pressable>
          </View>
        </View>

        {status ? (
          <Text style={statusStrong ? styles.statusStrong : styles.status}>
            {status}
          </Text>
        ) : null}

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

  if (placement) {
    // Transparent over the note, so the user can see where they are tapping.
    return <PlacementOverlay request={placement} />;
  }

  if (placing) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.placingScreen}>
          <Text style={styles.placingTitle}>{placing}</Text>
          <Text style={styles.placingHint}>
            {'Shelf closes by itself when it is done.'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (capture) {
    return <SafeAreaView style={styles.root}>{renderCapture(capture)}</SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Shelf</Text>

        {pdfInsert ? (
          renderPdfInsert(pdfInsert)
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
      <FolderProjectPicker
        visible={folderPickerOpen}
        initialPath={folderPickerStart}
        onCancel={() => setFolderPickerOpen(false)}
        onSelect={chooseFolderProject}
      />
      <FolderProjectPicker
        visible={notePickerOpen}
        mode="note"
        initialPath={
          currentTarget?.kind === 'note' ? folderPickerStart : '/storage/emulated/0/Note'
        }
        onCancel={() => setNotePickerOpen(false)}
        onSelect={openChosenNote}
      />
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
  statusStrong: {
    color: '#000000',
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 28,
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
  pdfInsertCount: {
    color: '#202020',
    fontSize: 22,
    fontWeight: '700',
    minWidth: 36,
    textAlign: 'center',
  },
  pdfInsertWarning: {
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 2,
    marginBottom: 10,
    padding: 10,
  },
  pdfInsertUndo: {
    borderTopColor: '#b0b0b0',
    borderTopWidth: 1,
    marginTop: 12,
    paddingTop: 10,
  },
  placingScreen: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    padding: 32,
  },
  placingTitle: {
    color: '#202020',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  placingHint: {
    color: '#505050',
    fontSize: 16,
    textAlign: 'center',
  },
  captureRoot: {
    flex: 1,
    padding: 16,
  },
  // A long project list scrolls on its own instead of squeezing the quote.
  captureChooser: {
    flexGrow: 0,
    marginBottom: 10,
    maxHeight: 240,
  },
  // Takes all height the note section leaves; fixed for the whole visit.
  captureQuoteSection: {
    flex: 1,
    minHeight: 140,
  },
  captureSection: {
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 2,
    marginBottom: 10,
    padding: 10,
  },
  captureHeading: {
    color: '#202020',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 6,
  },
  // Fills the quote section; long quotes scroll inside the box.
  captureQuote: {
    backgroundColor: '#ffffff',
    borderColor: '#202020',
    borderRadius: 6,
    borderWidth: 1,
    color: '#202020',
    flex: 1,
    fontSize: 17,
    padding: 10,
    textAlignVertical: 'top',
  },
  captureControls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 6,
  },
  captureInkHint: {
    color: '#505050',
    fontSize: 13,
    marginBottom: 6,
  },
  // The rule above the writing area is its top edge (sn-flashcards).
  inkBoundary: {
    backgroundColor: '#9a9a9a',
    height: 2,
  },
  captureInk: {
    backgroundColor: '#ffffff',
    borderColor: '#9a9a9a',
    borderTopWidth: 0,
    borderWidth: 1,
    height: 320,
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
