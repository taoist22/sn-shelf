import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';
import {getHeadingTexts, saveHeadingTexts} from '../storage/sessionShelf';

type ApiResponse<T> = {
  success?: boolean;
  result?: T;
  error?: {message?: string};
};

type RawTitle = {
  page: number;
  X: number;
  Y: number;
  width: number;
  height: number;
  controlTrailNums?: number[];
};

export type ReferenceKeyword = {
  keyword: string;
  /** 0-based, per confirmed getKeyWords behavior. */
  page: number;
};

export type HeadingEntry = {
  /** Stable identity: page + position + size. Survives unrelated edits. */
  key: string;
  page: number;
  /** Title position on the page — used to match its type-100 element. */
  x: number;
  y: number;
  /** OCR text when recognized (persisted); null = not yet recognized. */
  text: string | null;
  controlTrailNums: number[];
};

export type ReferenceMeta = {
  keywords: ReferenceKeyword[];
  headings: HeadingEntry[];
  /** 0-based pages carrying a five-star mark. Notes only. */
  stars: number[];
  pageCount: number;
};

const RECOGNIZER_SETTLE_MS = 400; // Pattern 16: proven floor is 300ms.

const metaCache = new Map<string, ReferenceMeta>();

function titleKey(title: RawTitle): string {
  return `${title.page}:${Math.round(title.X)}:${Math.round(title.Y)}:${Math.round(title.width)}x${Math.round(title.height)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cheap per-note scan: keywords + title identities via the lightweight
 * metadata APIs (both require an explicit pageList; never
 * getElements here). Titles are merged against the persisted OCR cache, so
 * previously recognized headings show text immediately and new/edited ones
 * surface as unrecognized. Session-cached; pass force to rescan.
 */
export async function scanNoteMeta(
  notePath: string,
  force = false,
): Promise<ReferenceMeta> {
  const cached = metaCache.get(notePath);
  if (cached && !force) {
    return cached;
  }

  const totalRes = (await PluginFileAPI.getNoteTotalPageNum(
    notePath,
  )) as ApiResponse<number>;
  const total = totalRes?.success ? totalRes.result ?? 0 : 0;
  if (!total || total < 1) {
    throw new Error(totalRes?.error?.message ?? 'Could not read page count');
  }
  const pageList = Array.from({length: total}, (_, index) => index);

  const keywordsRes = (await PluginFileAPI.getKeyWords(
    notePath,
    pageList,
  )) as ApiResponse<{keyword: string; page: number}[]>;
  const titlesRes = (await PluginFileAPI.getTitles(
    notePath,
    pageList,
  )) as ApiResponse<RawTitle[]>;
  const starsRes = (await PluginFileAPI.searchFiveStars(
    notePath,
  )) as ApiResponse<number[]>;

  const titles = titlesRes?.success ? titlesRes.result ?? [] : [];
  const known = new Map(
    getHeadingTexts(notePath).map(entry => [entry.key, entry.text]),
  );

  const headings: HeadingEntry[] = titles.map(title => {
    const key = titleKey(title);
    return {
      key,
      page: title.page,
      x: title.X,
      y: title.Y,
      text: known.get(key) ?? null,
      controlTrailNums: title.controlTrailNums ?? [],
    };
  });

  // Prune cache entries for headings that no longer exist in the note.
  const liveKeys = new Set(headings.map(entry => entry.key));
  const pruned = getHeadingTexts(notePath).filter(entry =>
    liveKeys.has(entry.key),
  );
  if (pruned.length !== known.size) {
    saveHeadingTexts(notePath, pruned);
  }

  const meta: ReferenceMeta = {
    keywords: (keywordsRes?.success ? keywordsRes.result ?? [] : []).map(
      entry => ({keyword: entry.keyword, page: entry.page}),
    ),
    headings,
    stars: (starsRes?.success ? starsRes.result ?? [] : [])
      .filter(page => typeof page === 'number')
      .sort((a, b) => a - b),
    pageCount: total,
  };
  metaCache.set(notePath, meta);
  return meta;
}

const ELEMENT_TYPE_TITLE = 100;

function normalizeTrailNums(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((num): num is number => typeof num === 'number')
    : [];
}

function sameTrailNums(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every(num => b.includes(num));
}

/**
 * Match a getTitles entry to its type-100 page element: by trailNums first
 * (sn-toc's approach), then by position (typed-text titles can have empty
 * trailNums in getTitles — matching the wrong element makes one heading
 * steal another's text), then by ordinal among the page's titles.
 */
function findTitleElement(
  entry: HeadingEntry,
  pageElements: any[],
  fallbackIndex: number,
): any | undefined {
  const titleElements = pageElements.filter(
    element => element?.type === ELEMENT_TYPE_TITLE,
  );
  if (titleElements.length === 0) {
    return undefined;
  }
  const byTrailNums =
    entry.controlTrailNums.length > 0
      ? titleElements.find(element =>
          sameTrailNums(
            normalizeTrailNums(element?.title?.controlTrailNums),
            entry.controlTrailNums,
          ),
        )
      : undefined;
  if (byTrailNums) {
    return byTrailNums;
  }
  const byPosition = titleElements.find(
    element =>
      Math.abs(Number(element?.title?.X ?? Number.NaN) - entry.x) <= 4 &&
      Math.abs(Number(element?.title?.Y ?? Number.NaN) - entry.y) <= 4,
  );
  return byPosition ?? titleElements[fallbackIndex] ?? titleElements[0];
}

/**
 * Ported from sn-toc: most titles already carry text without OCR — either a
 * linked text box, or the recognition result Supernote's background
 * recognition embedded on the title element itself.
 */
function embeddedTitleText(titleEl: any, trailNums: number[], pageElements: any[]): string {
  const textBoxEl =
    trailNums.length > 0
      ? pageElements.find(
          element =>
            element?.textBox?.textContentFull &&
            trailNums.includes(element.numInPage),
        )
      : undefined;
  const textBoxText = textBoxEl?.textBox?.textContentFull?.trim?.();
  if (textBoxText) {
    return textBoxText;
  }
  const titleText = titleEl?.textBox?.textContentFull?.trim?.();
  if (titleText) {
    return titleText;
  }
  const guess = titleEl?.recognizeResult?.predict_name?.trim?.();
  if (guess && !/^\.?\d+$/.test(guess)) {
    return guess;
  }
  return '';
}

/**
 * Resolves text for the unrecognized headings of a note, following sn-toc's
 * proven order: embedded text first (linked text box, then the title
 * element's background-recognition result), OCR via recognizeElements only
 * as a last resort. Targeted getElements per page that holds a new title
 * (the acceptable usage class — see
 * references/get-elements-link-aggregation-warning.md), elements recycled
 * after each page, recognizer reset + settle before OCR (Pattern 16).
 * Results persist via the heading-text cache. Returns updated headings.
 */
export async function recognizeNewHeadings(
  notePath: string,
  headings: HeadingEntry[],
  onProgress?: (done: number, total: number) => void,
): Promise<HeadingEntry[]> {
  const pending = headings.filter(entry => entry.text === null);
  if (pending.length === 0) {
    return headings;
  }

  const byPage = new Map<number, HeadingEntry[]>();
  for (const entry of pending) {
    const list = byPage.get(entry.page) ?? [];
    list.push(entry);
    byPage.set(entry.page, list);
  }

  const cache = [...getHeadingTexts(notePath)];
  const updated = new Map(headings.map(entry => [entry.key, entry]));
  const total = pending.length;
  let done = 0;

  for (const [page, entries] of byPage) {
    const elementsRes = (await PluginFileAPI.getElements(page, notePath)) as
      | ApiResponse<any[]>
      | undefined;
    const elements = elementsRes?.success ? elementsRes.result ?? [] : [];
    let pageSize: {width: number; height: number} | null = null;

    // Ordinal fallback must count ALL of the page's headings (recognized or
    // not), or a lone pending title mis-matches the page's first title.
    const pageHeadings = headings.filter(heading => heading.page === page);

    try {
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        done++;

        const ordinal = pageHeadings.findIndex(
          heading => heading.key === entry.key,
        );
        const titleEl = findTitleElement(
          entry,
          elements,
          ordinal >= 0 ? ordinal : index,
        );
        const elementTrailNums = normalizeTrailNums(
          titleEl?.title?.controlTrailNums,
        );
        const trailNums =
          elementTrailNums.length > 0
            ? elementTrailNums
            : entry.controlTrailNums;

        // 1) Embedded text — covers most titles with zero OCR cost.
        let text = embeddedTitleText(titleEl, trailNums, elements);

        // 2) OCR fallback on the title's strokes.
        if (!text && trailNums.length > 0) {
          const strokes = elements.filter(
            element =>
              element?.type === 0 && trailNums.includes(element.numInPage),
          );
          if (strokes.length > 0) {
            if (!pageSize) {
              const sizeRes = (await PluginFileAPI.getPageSize(
                notePath,
                page,
              )) as ApiResponse<{width: number; height: number}>;
              pageSize = sizeRes?.success ? sizeRes.result ?? null : null;
            }
            if (pageSize) {
              try {
                await PluginCommAPI.cancelRecognize();
              } catch {
                // Can reject when the recognizer is idle; safe to continue.
              }
              await delay(RECOGNIZER_SETTLE_MS);
              const res = (await PluginCommAPI.recognizeElements(
                strokes,
                pageSize,
              )) as ApiResponse<string>;
              text = res?.success ? res.result?.trim() ?? '' : '';
            }
          }
        }

        if (text) {
          cache.push({key: entry.key, page: entry.page, text});
          updated.set(entry.key, {...entry, text});
        }
        onProgress?.(done, total);
      }
    } finally {
      // Free Android-side element cache before moving to the next page.
      for (const element of elements) {
        try {
          await element?.recycle?.();
        } catch {
          // Best effort.
        }
      }
    }
  }

  saveHeadingTexts(notePath, cache);
  const result = headings.map(entry => updated.get(entry.key) ?? entry);
  const cachedMeta = metaCache.get(notePath);
  if (cachedMeta) {
    metaCache.set(notePath, {...cachedMeta, headings: result});
  }
  return result;
}

/**
 * Drops a heading's cached text (e.g. a misrecognition) so it shows as
 * unrecognized again and can be re-run via Recognize.
 */
export function forgetHeadingText(notePath: string, key: string): void {
  saveHeadingTexts(
    notePath,
    getHeadingTexts(notePath).filter(entry => entry.key !== key),
  );
  const cached = metaCache.get(notePath);
  if (cached) {
    metaCache.set(notePath, {
      ...cached,
      headings: cached.headings.map(entry =>
        entry.key === key ? {...entry, text: null} : entry,
      ),
    });
  }
}
