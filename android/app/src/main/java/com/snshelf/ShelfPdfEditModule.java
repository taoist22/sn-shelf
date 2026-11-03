package com.snshelf;

import android.graphics.Bitmap;
import android.util.DisplayMetrics;
import android.graphics.BitmapFactory;
import android.os.Environment;
import android.util.Log;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
import com.tom_roush.pdfbox.cos.COSName;
import com.tom_roush.pdfbox.io.MemoryUsageSetting;
import com.tom_roush.pdfbox.pdmodel.PDDocument;
import com.tom_roush.pdfbox.pdmodel.PDPage;
import com.tom_roush.pdfbox.pdmodel.PDPageContentStream;
import com.tom_roush.pdfbox.pdmodel.PDPageTree;
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle;
import com.tom_roush.pdfbox.pdmodel.encryption.InvalidPasswordException;
import com.tom_roush.pdfbox.pdmodel.graphics.image.CCITTFactory;
import com.tom_roush.pdfbox.pdmodel.graphics.image.JPEGFactory;
import com.tom_roush.pdfbox.pdmodel.graphics.image.PDImageXObject;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Inserts blank or ruled pages into a PDF, in place, with undo.
 *
 * Approach studied from the InsertPage plugin (github.com/dersalbader/supernote-PDF-Insert-page,
 * unlicensed, so no code is taken): PDFBox-Android edits the file, and the JS side reopens it
 * with PluginFileAPI.openFile so the reader reloads. Differences, all for safety:
 *
 *  - The new PDF is built and VERIFIED in Shelf's private storage first. Only then is it
 *    written over the original, and the original is backed up (per PDF) before that write.
 *    A failure during the write restores the backup. Nothing is ever created, renamed or
 *    deleted in the user's folders — like InsertPage, the only user-folder operation is
 *    rewriting the PDF itself, which FILE:WRITE is proven to allow.
 *  - PDFBox never saves over the file it is reading from.
 *  - New pages match the anchor page's VISIBLE area (CropBox) and rotation.
 *  - Every inserted page carries a /ShelfInserted marker so a later "delete page" can refuse
 *    to touch the document's original pages.
 *
 * All work runs on one background thread; calls are serialised.
 */
public class ShelfPdfEditModule extends ReactContextBaseJavaModule {
    private static final String TAG = "ShelfPdfEdit";
    private static final COSName INSERTED_MARKER = COSName.getPDFName("ShelfInserted");
    private static final int MAX_PAGES = 20;
    /**
     * Stamped by buildPlugin.sh at every build (date, time and git hash), shown on screen
     * and written to the log. The JS half carries the SAME string, so two different values
     * mean a half-installed package — which is exactly the confusion a hand-kept number
     * caused (2026-10-30).
     */
    static final String BUILD_ID = "2026-11-02 19:30 be7efec";
    private static final File LOG_FILE = new File("/storage/emulated/0/EXPORT/shelf-log.txt");
    private static final long LOG_MAX_BYTES = 512L * 1024;
    private static final float MM = 72f / 25.4f;
    private static final float RULE_MARGIN = 10f * MM;
    /** A dot's diameter on a dotted template, before the apparent-size correction. */
    private static final float DOT_SIZE = 0.5f * MM;
    /** Guard rails for the page-to-screen correction, in case the metrics are odd. */
    private static final float MIN_FIT = 0.2f;
    private static final float MAX_FIT = 3f;
    private static final long BACKUP_MAX_AGE_MS = 30L * 24 * 60 * 60 * 1000;
    private static final int BACKUP_MAX_COUNT = 5;
    /** Undo backups are full copies; cap what they may use on each storage. */
    private static final long BACKUP_MAX_BYTES = 500L * 1024 * 1024;
    /**
     * The largest PDF Shelf will rewrite. Measured on a Manta: 738 KB takes 2.4s, 38.5 MB
     * takes 34s, and the device's own reader is already slow with a document that big.
     * The JS side refuses these before they reach a shelf; this is the backstop.
     */
    private static final long MAX_PDF_BYTES = 25L * 1024 * 1024;
    /**
     * Up to this size the written PDF is re-parsed in full to prove it is readable. Past it
     * that second parse costs about as much as the whole edit, so the file is checked
     * structurally instead (see verifyWritten).
     */
    private static final long VERIFY_FULL_PARSE_MAX = 10L * 1024 * 1024;
    /**
     * Limits on a template image. A page-sized 1-bit PNG is tens of KB and a few megapixels;
     * these cut off a photo or a poster scan that would be decoded into memory inside the
     * plugin host and then embedded on every inserted page.
     */
    private static final long IMAGE_MAX_BYTES = 12L * 1024 * 1024;
    private static final long IMAGE_MAX_PIXELS = 40L * 1000 * 1000;
    /**
     * "Shrink for e-ink": the screen is about 1400-1900 px wide and renders 16 greys, so a
     * bigger or colour image carries data the device cannot show while costing a megabyte on
     * every page inserted. Line art goes to 1-bit (crisper on e-ink as well as smaller),
     * anything shaded to grey JPEG.
     */
    private static final int SHRINK_MAX_PX = 2048;
    private static final int JPEG_QUALITY = 80;
    /** The screen shows 16 greys, so finer gradients are stored and never seen. */
    private static final int SCREEN_GREYS = 16;
    /** Below this share of mid-grey pixels an image is treated as line art. */
    private static final float BICHROME_MID_SHARE = 0.12f;
    /** Working copies + new PDF + backup: about three times the PDF must be free. */
    private static final int SPACE_FACTOR = 3;
    private static final long SPACE_MARGIN = 20L * 1024 * 1024;

    private final ReactApplicationContext reactContext;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    /** For delay() and log(): separate from the worker, which may be busy with a long PDF edit. */
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();

    /**
     * Appends a timestamped line to EXPORT/shelf-log.txt, which the user downloads with
     * Browse & Access — so a failed Insert Page is diagnosed from facts, not guesses. The file
     * restarts when it passes 512 KB. Never throws.
     */
    static synchronized void appendLog(String line) {
        try {
            File dir = LOG_FILE.getParentFile();
            if (dir != null && !dir.isDirectory()) {
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            }
            boolean append = LOG_FILE.length() < LOG_MAX_BYTES;
            String stamp = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", java.util.Locale.US)
                    .format(new java.util.Date());
            try (OutputStream out = new FileOutputStream(LOG_FILE, append)) {
                out.write((stamp + "  " + line + "\n").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable t) {
            Log.w(TAG, "appendLog", t);
        }
    }

    /** Bytes of a file, or 0 when it can't be read — the size gate treats 0 as "unknown". */
    @ReactMethod
    public void fileSize(String path, Promise promise) {
        try {
            File file = new File(path == null ? "" : path);
            promise.resolve(file.isFile() ? (double) file.length() : 0.0);
        } catch (Throwable t) {
            promise.resolve(0.0);
        }
    }

    @ReactMethod
    public void log(String line, Promise promise) {
        timer.execute(() -> {
            appendLog(line);
            promise.resolve(null);
        });
    }
    private volatile boolean pdfBoxReady = false;

    public ShelfPdfEditModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
    }

    @Override
    public String getName() {
        return "ShelfPdfEdit";
    }

    @Override
    public void invalidate() {
        worker.shutdown();
        timer.shutdown();
        super.invalidate();
    }

    /**
     * @param anchorIndex zero-based page the insert is relative to
     * @param position    "before" or "after"
     * @param background  "blank" or "lined"
     * Resolves {originalCount, finalCount, firstInsertedIndex, count}.
     */
    @ReactMethod
    public void insertPages(String path, int anchorIndex, String position, int count,
                            String background, String space, String imagePath, double imageScale,
                            boolean shrinkImage, double spacingMm, Promise promise) {
        worker.execute(() -> {
            try {
                appendLog("native " + BUILD_ID + ": insert " + count + " " + background + " " + position
                        + " page " + (anchorIndex + 1) + " space=" + space + " file=" + path
                        + ("image".equals(background)
                                ? " image=" + imagePath + " scale=" + imageScale
                                        + (shrinkImage ? " shrink" : " as-is") : ""));
                WritableMap result = doInsert(path, anchorIndex, position, count, background, space,
                        imagePath, imageScale, shrinkImage, spacingMm);
                appendLog("native: insert done, pages " + result.getInt("originalCount") + " -> "
                        + result.getInt("finalCount"));
                promise.resolve(result);
            } catch (PdfEditError e) {
                appendLog("native: insert refused " + e.code + " " + e.getMessage());
                promise.reject(e.code, e.getMessage());
            } catch (Throwable t) {
                appendLog("native: insert FAILED " + t);
                Log.e(TAG, "insertPages failed", t);
                promise.reject("PDF_EDIT_FAILED", String.valueOf(t.getMessage()), t);
            }
        });
    }

    /**
     * Resolves after `ms`. JS timers (setTimeout) do not fire while the plugin panel is
     * hidden, and opening another file to step out of a PDF can hide it — Insert Page then
     * froze waiting (device report 2026-09-19). A native resolve still reaches JS.
     */
    @ReactMethod
    public void delay(int ms, Promise promise) {
        timer.schedule(() -> promise.resolve(null), Math.max(0, ms), TimeUnit.MILLISECONDS);
    }

    /**
     * What the Insert Page screen needs to offer a working-space choice:
     * {sdPresent, sdWritable, sdFreeBytes, internalFreeBytes, pdfOnSd, pdfSizeBytes}.
     */
    /**
     * Whether this page carries Shelf's /ShelfInserted stamp — the only pages removePage
     * will touch. Checked before the PDF is closed, so a page that cannot be removed is
     * refused without disturbing what the user is reading.
     */
    @ReactMethod
    public void isShelfPage(String path, int pageIndex, Promise promise) {
        worker.execute(() -> {
            try {
                ensurePdfBox();
                File source = new File(path);
                if (!source.isFile()) {
                    throw new PdfEditError("PDF_NOT_FOUND", "The PDF could not be found.");
                }
                try (PDDocument doc = load(source, internalDir())) {
                    PDPageTree pages = doc.getPages();
                    if (pageIndex < 0 || pageIndex >= pages.getCount()) {
                        throw new PdfEditError("PDF_BAD_PAGE", "Page " + (pageIndex + 1) + " is not in this PDF.");
                    }
                    boolean inserted = pages.get(pageIndex).getCOSObject()
                            .getBoolean(INSERTED_MARKER, false);
                    appendLog("native " + BUILD_ID + ": page " + (pageIndex + 1)
                            + (inserted ? " was added by Shelf" : " is an original page"));
                    promise.resolve(inserted);
                }
            } catch (PdfEditError e) {
                promise.reject(e.code, e.getMessage());
            } catch (Throwable t) {
                appendLog("native: isShelfPage FAILED " + t);
                promise.reject("PDF_EDIT_FAILED", String.valueOf(t.getMessage()), t);
            }
        });
    }

    /** Removes ONE page Shelf added. Original pages of the document are refused. */
    @ReactMethod
    public void removePage(String path, int pageIndex, String space, Promise promise) {
        worker.execute(() -> {
            try {
                appendLog("native " + BUILD_ID + ": remove page " + (pageIndex + 1)
                        + " space=" + space + " file=" + path);
                WritableMap result = doRemove(path, pageIndex, space);
                appendLog("native: remove done, pages " + result.getInt("originalCount") + " -> "
                        + result.getInt("finalCount"));
                promise.resolve(result);
            } catch (PdfEditError e) {
                appendLog("native: remove refused " + e.code + " " + e.getMessage());
                promise.reject(e.code, e.getMessage());
            } catch (Throwable t) {
                appendLog("native: remove FAILED " + t);
                Log.e(TAG, "removePage failed", t);
                promise.reject("PDF_EDIT_FAILED", String.valueOf(t.getMessage()), t);
            }
        });
    }

    @ReactMethod
    public void getWorkSpaces(String path, Promise promise) {
        worker.execute(() -> {
            WritableMap map = Arguments.createMap();
            try {
                File internal = internalDir();
                SdSpace sd = findSd();
                map.putBoolean("sdPresent", sd.root != null);
                map.putBoolean("sdWritable", sd.dir != null);
                map.putString("sdReason", sd.reason);
                map.putDouble("sdFreeBytes", sd.dir != null ? sd.dir.getUsableSpace() : 0);
                map.putDouble("internalFreeBytes", internal.getUsableSpace());
                map.putBoolean("pdfOnSd", sd.root != null && path.startsWith(sd.root + "/"));
                map.putDouble("pdfSizeBytes", new File(path).length());
                appendLog("native: workspaces sd=" + sd.reason + " internalFree="
                        + internal.getUsableSpace() / (1024 * 1024) + "MB");
            } catch (Throwable t) {
                Log.w(TAG, "getWorkSpaces", t);
                map.putBoolean("sdPresent", false);
                map.putBoolean("sdWritable", false);
                map.putString("sdReason", "check failed: " + t);
                appendLog("native: workspaces check FAILED " + t);
            }
            map.putString("nativeBuild", BUILD_ID);
            promise.resolve(map);
        });
    }

    /** Resolves the undo record for this PDF, or null when there is nothing to undo. */
    @ReactMethod
    public void getUndo(String path, Promise promise) {
        worker.execute(() -> {
            try {
                File dir = undoDirFor(path);
                if (dir == null) {
                    promise.resolve(null);
                    return;
                }
                WritableMap record = readMeta(metaFile(dir, path));
                // Checked BEFORE any handwriting is moved back: if the PDF changed since
                // the insert, the restore would be refused after the marks had moved.
                record.putBoolean("matches",
                        new File(path).length() == (long) record.getDouble("finalSize"));
                promise.resolve(record);
            } catch (Throwable t) {
                promise.resolve(null);
            }
        });
    }

    /** Restores the PDF from its backup; resolves the undo record that was applied. */
    @ReactMethod
    public void undoLastInsert(String path, Promise promise) {
        worker.execute(() -> {
            try {
                File dir = undoDirFor(path);
                if (dir == null) {
                    throw new PdfEditError("PDF_NO_UNDO",
                            "There is no insert to undo for this PDF (its backup may have been on an SD card that was removed).");
                }
                File meta = metaFile(dir, path);
                File backup = backupFile(dir, path);
                WritableMap record = readMeta(meta);
                File target = new File(path);
                if (target.length() != record.getDouble("finalSize")) {
                    throw new PdfEditError("PDF_CHANGED",
                            "This PDF has changed since the pages were inserted, so undo was cancelled.");
                }
                writeOver(backup, target, null);
                deleteQuietly(backup);
                deleteQuietly(meta);
                promise.resolve(record);
            } catch (PdfEditError e) {
                promise.reject(e.code, e.getMessage());
            } catch (Throwable t) {
                Log.e(TAG, "undoLastInsert failed", t);
                promise.reject("PDF_EDIT_FAILED", String.valueOf(t.getMessage()), t);
            }
        });
    }

    // ---------------------------------------------------------------------------------------

    /**
     * Takes out one page Shelf added, in place, keeping a backup for undo. The /ShelfInserted
     * stamp is the gate: a page of the user's own document can never be removed here, however
     * it is asked for. Handwriting is moved by the JS side before this runs.
     */
    private WritableMap doRemove(String path, int pageIndex, String space) throws Exception {
        File source = new File(path);
        if (!source.isFile()) {
            throw new PdfEditError("PDF_NOT_FOUND", "The PDF could not be found.");
        }
        ensurePdfBox();
        File workDir = resolveWorkDir(space, path);
        long sourceSize = source.length();
        long sourceModified = source.lastModified();
        appendLog("native: working in " + workDir + " (free " + workDir.getUsableSpace() / (1024 * 1024)
                + "MB), pdf " + sourceSize / 1024 + "KB");
        if (sourceSize > MAX_PDF_BYTES) {
            throw new PdfEditError("PDF_TOO_LARGE", "This PDF is " + sourceSize / (1024 * 1024)
                    + " MB. Shelf doesn't change PDFs over " + MAX_PDF_BYTES / (1024 * 1024) + " MB.");
        }
        ensureSpace(workDir, sourceSize);
        File built = new File(workDir, "remove-" + System.currentTimeMillis() + ".pdf");

        int originalCount;
        try (PDDocument doc = load(source, workDir)) {
            if (doc.isEncrypted()) {
                throw new PdfEditError("PDF_LOCKED", "This PDF is locked and can't be changed.");
            }
            PDPageTree pages = doc.getPages();
            originalCount = pages.getCount();
            if (pageIndex < 0 || pageIndex >= originalCount) {
                throw new PdfEditError("PDF_BAD_PAGE", "Page " + (pageIndex + 1) + " is not in this PDF.");
            }
            if (originalCount <= 1) {
                throw new PdfEditError("PDF_LAST_PAGE", "A PDF has to keep at least one page.");
            }
            if (!pages.get(pageIndex).getCOSObject().getBoolean(INSERTED_MARKER, false)) {
                throw new PdfEditError("PDF_NOT_INSERTED", "Page " + (pageIndex + 1)
                        + " is part of the original PDF, so Shelf won't remove it. Only pages Shelf added can be removed.");
            }
            pages.remove(pageIndex);
            doc.save(built);
        }
        appendLog("native: saved new PDF " + built.length() / 1024 + "KB");

        verifyWritten(built, workDir, originalCount - 1);
        if (source.length() != sourceSize || source.lastModified() != sourceModified) {
            deleteQuietly(built);
            throw new PdfEditError("PDF_CHANGED", "The PDF changed while the page was being removed. Try again.");
        }

        File backup = backupFile(workDir, path);
        copy(source, backup);
        try {
            writeOver(built, source, backup);
        } finally {
            deleteQuietly(built);
        }

        WritableMap result = Arguments.createMap();
        result.putString("path", path);
        result.putString("action", "remove");
        result.putInt("originalCount", originalCount);
        result.putInt("finalCount", originalCount - 1);
        result.putInt("firstInsertedIndex", pageIndex);
        result.putInt("count", 1);
        writeMeta(workDir, path, "remove", originalCount, pageIndex, 1, source.length());
        dropOtherBackups(workDir, path);
        pruneBackups(workDir);
        return result;
    }

    private WritableMap doInsert(String path, int anchorIndex, String position, int count,
                                 String background, String space, String imagePath,
                                 double imageScale, boolean shrinkImage,
                                 double spacingMm) throws Exception {
        if (count < 1 || count > MAX_PAGES) {
            throw new PdfEditError("PDF_BAD_COUNT", "Insert between 1 and " + MAX_PAGES + " pages.");
        }
        File template = "image".equals(background) ? checkTemplate(imagePath) : null;
        boolean before = "before".equals(position);
        File source = new File(path);
        if (!source.isFile()) {
            throw new PdfEditError("PDF_NOT_FOUND", "The PDF could not be found.");
        }
        ensurePdfBox();
        File workDir = resolveWorkDir(space, path);
        long sourceSize = source.length();
        long sourceModified = source.lastModified();
        appendLog("native: working in " + workDir + " (free " + workDir.getUsableSpace() / (1024 * 1024)
                + "MB), pdf " + sourceSize / 1024 + "KB");
        if (sourceSize > MAX_PDF_BYTES) {
            throw new PdfEditError("PDF_TOO_LARGE", "This PDF is " + sourceSize / (1024 * 1024)
                    + " MB. Shelf doesn't add pages to PDFs over " + MAX_PDF_BYTES / (1024 * 1024)
                    + " MB. Compress or split it first.");
        }
        ensureSpace(workDir, sourceSize);
        File built = new File(workDir, "insert-" + System.currentTimeMillis() + ".pdf");

        int originalCount;
        int firstInserted;
        try (PDDocument doc = load(source, workDir)) {
            if (doc.isEncrypted()) {
                throw new PdfEditError("PDF_LOCKED", "This PDF is locked and can't be changed.");
            }
            PDPageTree pages = doc.getPages();
            originalCount = pages.getCount();
            if (anchorIndex < 0 || anchorIndex >= originalCount) {
                throw new PdfEditError("PDF_BAD_PAGE", "Page " + (anchorIndex + 1) + " is not in this PDF.");
            }
            PDPage anchor = pages.get(anchorIndex);
            firstInserted = before ? anchorIndex : anchorIndex + 1;

            // Insert one after another so the new pages keep their order.
            // One image object for the document, drawn on each new page: embedding it per
            // page would multiply the file size by the number of pages inserted.
            PDImageXObject image = template == null ? null : loadTemplate(doc, template, shrinkImage);
            PDPage previous = null;
            for (int i = 0; i < count; i++) {
                PDPage page = newPageLike(anchor, image != null);
                drawBackground(doc, page, background, image, imageScale, spacingMm);
                if (previous != null) {
                    pages.insertAfter(page, previous);
                } else if (before) {
                    pages.insertBefore(page, anchor);
                } else {
                    pages.insertAfter(page, anchor);
                }
                previous = page;
            }
            doc.save(built);
        }
        appendLog("native: saved new PDF " + built.length() / 1024 + "KB");

        verifyWritten(built, workDir, originalCount + count);
        if (source.length() != sourceSize || source.lastModified() != sourceModified) {
            deleteQuietly(built);
            throw new PdfEditError("PDF_CHANGED", "The PDF changed while the pages were being added. Try again.");
        }

        // Back up the original (replacing any older backup of this PDF), then write over it.
        // Written straight to its final name: a temp file + rename + delete needs deletes
        // the plugin host may refuse on external storage.
        File backup = backupFile(workDir, path);
        copy(source, backup);
        try {
            writeOver(built, source, backup);
        } finally {
            deleteQuietly(built);
        }

        WritableMap result = Arguments.createMap();
        result.putString("path", path);
        result.putString("action", "insert");
        result.putInt("originalCount", originalCount);
        result.putInt("finalCount", originalCount + count);
        result.putInt("firstInsertedIndex", firstInserted);
        result.putInt("count", count);
        writeMeta(workDir, path, "insert", originalCount, firstInserted, count, source.length());
        dropOtherBackups(workDir, path);
        pruneBackups(workDir);
        return result;
    }

    /**
     * Checks the written PDF before anything touches the user's original.
     *
     * A small file is re-parsed in full and its pages counted. A large one is not: parsing a
     * 900-page book twice doubles the edit for a check the write itself already largely
     * proves, so the file is checked for a plausible size and a complete trailer instead.
     */
    private void verifyWritten(File built, File workDir, int expectedPages) throws IOException, PdfEditError {
        if (built.length() <= VERIFY_FULL_PARSE_MAX) {
            try (PDDocument check = load(built, workDir)) {
                if (check.getPages().getCount() != expectedPages) {
                    throw new PdfEditError("PDF_VERIFY_FAILED", "The edited PDF did not check out, so nothing was changed.");
                }
            }
            return;
        }
        if (built.length() < 1024 || !endsWithEof(built)) {
            throw new PdfEditError("PDF_VERIFY_FAILED", "The edited PDF was not written completely, so nothing was changed.");
        }
        appendLog("native: checked written PDF without a second parse (" + built.length() / 1024 + "KB)");
    }

    /** A complete PDF ends with %%EOF; a half-written one does not. */
    private static boolean endsWithEof(File file) throws IOException {
        int window = 2048;
        try (java.io.RandomAccessFile handle = new java.io.RandomAccessFile(file, "r")) {
            long start = Math.max(0, handle.length() - window);
            handle.seek(start);
            byte[] tail = new byte[(int) (handle.length() - start)];
            handle.readFully(tail);
            return new String(tail, StandardCharsets.US_ASCII).contains("%%EOF");
        }
    }

    /**
     * PDFBox keeps its working copy of the PDF in temp FILES in the chosen working space,
     * not in memory: the plugin host's memory is limited, and a PDFBox default (in-memory)
     * load is the likely cause of other page-insert plugins crashing on 30 MB+ PDFs.
     */
    private PDDocument load(File file, File tempDir) throws IOException, PdfEditError {
        try {
            return PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly().setTempDir(tempDir));
        } catch (InvalidPasswordException e) {
            throw new PdfEditError("PDF_LOCKED", "This PDF is locked and can't be changed.");
        }
    }

    private void ensurePdfBox() {
        if (!pdfBoxReady) {
            PDFBoxResourceLoader.init(reactContext.getApplicationContext());
            pdfBoxReady = true;
        }
    }

    /** Same visible size and rotation as the anchor, tagged as inserted by Shelf. */
    /**
     * Centres the template on the page, keeping its shape. `fill` is the user's Size choice:
     * 1 fills the page edge to edge, less leaves an even margin all round.
     */
    private void drawTemplate(PDDocument doc, PDPage page, PDImageXObject image, double fill)
            throws IOException {
        PDRectangle box = page.getMediaBox();
        float room = (float) Math.min(1.0, Math.max(0.5, fill == 0 ? 1.0 : fill));
        float scale = room * Math.min(box.getWidth() / image.getWidth(),
                box.getHeight() / image.getHeight());
        float width = image.getWidth() * scale;
        float height = image.getHeight() * scale;
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            cs.drawImage(image, (box.getWidth() - width) / 2f, (box.getHeight() - height) / 2f,
                    width, height);
        }
    }

    /**
     * A new page the size of the anchor's visible area.
     *
     * `upright` builds the page already the right way round (the anchor's displayed
     * dimensions, no rotation) instead of inheriting its /Rotate. A template image would
     * otherwise land sideways on a rotated page, and compensating for that in the content
     * stream is more error-prone than giving the page no rotation to compensate for. The
     * page still displays at the same size as its neighbours.
     */
    private PDPage newPageLike(PDPage anchor, boolean upright) {
        PDRectangle visible = anchor.getCropBox();
        int rotation = ((anchor.getRotation() % 360) + 360) % 360;
        boolean sideways = rotation == 90 || rotation == 270;
        PDPage page;
        if (upright && sideways) {
            page = new PDPage(new PDRectangle(visible.getHeight(), visible.getWidth()));
        } else {
            page = new PDPage(new PDRectangle(visible.getWidth(), visible.getHeight()));
            page.setRotation(anchor.getRotation());
        }
        page.getCOSObject().setBoolean(INSERTED_MARKER, true);
        return page;
    }

    /**
     * Light grey rules every 8 mm, drawn so they run HORIZONTALLY as displayed: on a page
     * rotated 90/270 the displayed horizontal is the page's vertical axis.
     */
    /**
     * A template image must exist, be a kind PDFBox can read, and be small enough to decode
     * inside the plugin host. Refusing here gives the user a sentence; failing inside PDFBox
     * gives them a stack trace.
     */
    private File checkTemplate(String imagePath) throws PdfEditError {
        if (imagePath == null || imagePath.trim().isEmpty()) {
            throw new PdfEditError("PDF_NO_IMAGE", "Choose a template image first.");
        }
        File file = new File(imagePath);
        if (!file.isFile()) {
            throw new PdfEditError("PDF_IMAGE_NOT_FOUND", "That template image could not be found.");
        }
        String lower = file.getName().toLowerCase();
        if (!lower.endsWith(".png") && !lower.endsWith(".jpg") && !lower.endsWith(".jpeg")) {
            throw new PdfEditError("PDF_BAD_IMAGE", "The template must be a PNG or JPEG.");
        }
        if (file.length() > IMAGE_MAX_BYTES) {
            throw new PdfEditError("PDF_IMAGE_TOO_BIG", "That image is " + file.length() / (1024 * 1024)
                    + " MB. Use one under " + IMAGE_MAX_BYTES / (1024 * 1024) + " MB.");
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new PdfEditError("PDF_BAD_IMAGE", "That image could not be read. Try a PNG.");
        }
        if ((long) bounds.outWidth * bounds.outHeight > IMAGE_MAX_PIXELS) {
            throw new PdfEditError("PDF_IMAGE_TOO_BIG", "That image is " + bounds.outWidth + " by "
                    + bounds.outHeight + " pixels. Scale it closer to the screen's size.");
        }
        return file;
    }

    /**
     * Turns the chosen file into something to draw on the page. With `shrink` the image is
     * scaled to what the screen can show and re-encoded for size; every conversion falls
     * back to embedding the file as it is, because a bigger page beats a failed insert.
     */
    private PDImageXObject loadTemplate(PDDocument doc, File file, boolean shrink) throws PdfEditError {
        if (!shrink) {
            return loadOriginal(doc, file);
        }
        Bitmap source = decodeScaled(file);
        if (source == null) {
            appendLog("native: template could not be decoded for shrinking; embedding as-is");
            return loadOriginal(doc, file);
        }
        try {
            boolean lineArt = isLineArt(source);
            appendLog("native: template " + source.getWidth() + "x" + source.getHeight()
                    + (lineArt ? " as 1-bit" : " as grey JPEG"));
            if (lineArt) {
                Bitmap bw = toBlackAndWhite(source);
                try {
                    PDImageXObject image = CCITTFactory.createFromImage(doc, bw);
                    appendLog("native: template stored as "
                            + image.getCOSObject().getLength() / 1024 + "KB of 1-bit");
                    return image;
                } catch (Throwable t) {
                    appendLog("native: 1-bit embed failed, trying grey " + t);
                } finally {
                    bw.recycle();
                }
            }
            Bitmap grey = toScreenGrey(source);
            try {
                java.io.ByteArrayOutputStream jpeg = new java.io.ByteArrayOutputStream();
                grey.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpeg);
                PDImageXObject image = JPEGFactory.createFromByteArray(doc, jpeg.toByteArray());
                appendLog("native: template stored as " + jpeg.size() / 1024 + "KB of grey JPEG");
                return image;
            } catch (Throwable t) {
                appendLog("native: grey embed failed, embedding as-is " + t);
            } finally {
                grey.recycle();
            }
        } finally {
            source.recycle();
        }
        return loadOriginal(doc, file);
    }

    private PDImageXObject loadOriginal(PDDocument doc, File file) throws PdfEditError {
        try {
            return PDImageXObject.createFromFileByExtension(file, doc);
        } catch (Throwable t) {
            appendLog("native: template image failed " + t);
            throw new PdfEditError("PDF_BAD_IMAGE", "That image could not be used as a page. Try a PNG.");
        }
    }

    /** Decodes at the smallest power-of-two scale that still covers what the screen shows. */
    private Bitmap decodeScaled(File file) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(file.getAbsolutePath(), bounds);
            int longest = Math.max(bounds.outWidth, bounds.outHeight);
            int sample = 1;
            while (longest / (sample * 2) >= SHRINK_MAX_PX) {
                sample *= 2;
            }
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inSampleSize = sample;
            options.inPreferredConfig = Bitmap.Config.ARGB_8888;
            return BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        } catch (Throwable t) {
            appendLog("native: decode for shrinking failed " + t);
            return null;
        }
    }

    /**
     * True when almost every pixel is near black or near white — a diagram, a scan of a
     * drawing, a ruled or boxed template. Sampled every fourth pixel, a band at a time, so a
     * page-sized image never costs more than a few MB of heap here.
     */
    private static boolean isLineArt(Bitmap image) {
        int width = image.getWidth();
        int band = Math.max(1, 262144 / Math.max(1, width));
        int[] row = new int[width * band];
        long sampled = 0;
        long mid = 0;
        for (int top = 0; top < image.getHeight(); top += band) {
            int rows = Math.min(band, image.getHeight() - top);
            image.getPixels(row, 0, width, 0, top, width, rows);
            for (int i = 0; i < width * rows; i += 4) {
                int pixel = row[i];
                int grey = ((pixel >> 16 & 0xFF) * 77 + (pixel >> 8 & 0xFF) * 151
                        + (pixel & 0xFF) * 28) >> 8;
                sampled++;
                if (grey > 48 && grey < 208) {
                    mid++;
                }
            }
        }
        return sampled > 0 && (float) mid / sampled < BICHROME_MID_SHARE;
    }

    private static Bitmap toBlackAndWhite(Bitmap image) {
        int width = image.getWidth();
        int height = image.getHeight();
        Bitmap out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        int band = Math.max(1, 262144 / Math.max(1, width));
        int[] row = new int[width * band];
        for (int top = 0; top < height; top += band) {
            int rows = Math.min(band, height - top);
            image.getPixels(row, 0, width, 0, top, width, rows);
            for (int i = 0; i < width * rows; i++) {
                int pixel = row[i];
                int grey = ((pixel >> 16 & 0xFF) * 77 + (pixel >> 8 & 0xFF) * 151
                        + (pixel & 0xFF) * 28) >> 8;
                row[i] = grey < 160 ? 0xFF000000 : 0xFFFFFFFF;
            }
            out.setPixels(row, 0, width, 0, top, width, rows);
        }
        return out;
    }

    /**
     * Grey, flattened to the 16 levels the screen can show. Quantising costs nothing visible
     * on this device and gives the encoder far fewer distinct values to carry.
     */
    private static Bitmap toScreenGrey(Bitmap image) {
        int width = image.getWidth();
        int height = image.getHeight();
        Bitmap out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        int band = Math.max(1, 262144 / Math.max(1, width));
        int[] row = new int[width * band];
        int step = 255 / (SCREEN_GREYS - 1);
        for (int top = 0; top < height; top += band) {
            int rows = Math.min(band, height - top);
            image.getPixels(row, 0, width, 0, top, width, rows);
            for (int i = 0; i < width * rows; i++) {
                int pixel = row[i];
                int grey = ((pixel >> 16 & 0xFF) * 77 + (pixel >> 8 & 0xFF) * 151
                        + (pixel & 0xFF) * 28) >> 8;
                int level = Math.round(grey / (float) step) * step;
                row[i] = 0xFF000000 | level << 16 | level << 8 | level;
            }
            out.setPixels(row, 0, width, 0, top, width, rows);
        }
        return out;
    }

    private void drawBackground(PDDocument doc, PDPage page, String background, PDImageXObject image,
                                double imageScale, double spacingMm) throws IOException {
        if (image != null) {
            drawTemplate(doc, page, image, imageScale);
            return;
        }
        boolean lined = "lined".equals(background);
        boolean grid = "grid".equals(background);
        boolean dots = "dots".equals(background);
        if (!lined && !grid && !dots) {
            return;
        }
        PDRectangle box = page.getMediaBox();
        int rotation = ((page.getRotation() % 360) + 360) % 360;
        boolean sideways = rotation == 90 || rotation == 270;

        // Drawn to look the asked-for size ON SCREEN, not on the page: the reader shrinks
        // the whole page to fit, so 8 mm of rules on a Letter page arrived as about 6 and
        // did not match the device's own 8 mm template (device report, 2026-11-02).
        float fit = fitScale(page);
        float millimetre = (float) (spacingMm > 0 ? spacingMm : 8) * MM / fit;
        float margin = RULE_MARGIN / fit;
        float width = box.getWidth();
        float height = box.getHeight();
        appendLog("native: template " + background + " " + spacingMm + "mm at fit " + fit
                + " -> " + millimetre + "pt spacing");

        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            if (dots) {
                cs.setStrokingColor(0.55f, 0.55f, 0.55f);
                cs.setLineWidth(DOT_SIZE / fit);
                cs.setLineCapStyle(1); // round: a near-zero line paints a dot
                for (float y = height - margin; y > margin; y -= millimetre) {
                    for (float x = margin; x < width - margin; x += millimetre) {
                        cs.moveTo(x, y);
                        cs.lineTo(x + 0.01f, y);
                    }
                }
                cs.stroke();
                return;
            }
            cs.setStrokingColor(0.72f, 0.72f, 0.72f);
            cs.setLineWidth(0.5f / fit);
            if (grid || !sideways) {
                for (float y = height - margin - millimetre; y > margin; y -= millimetre) {
                    cs.moveTo(margin, y);
                    cs.lineTo(width - margin, y);
                }
            }
            if (grid || sideways) {
                for (float x = margin + millimetre; x < width - margin; x += millimetre) {
                    cs.moveTo(x, margin);
                    cs.lineTo(x, height - margin);
                }
            }
            cs.stroke();
        }
    }

    /**
     * How much the reader shrinks this page to fit the screen: 1 when the page is the size
     * of the screen, about 0.75 for a Letter page on a Manta. Anything drawn on the page is
     * scaled by this, so apparent sizes have to be divided by it.
     *
     * The screen's real size comes from the display metrics (these devices report 300 dpi),
     * so no device list is hardcoded. Odd metrics fall back to 1, i.e. page units.
     */
    private float fitScale(PDPage page) {
        try {
            DisplayMetrics metrics = reactContext.getResources().getDisplayMetrics();
            float dpi = metrics.densityDpi > 0 ? metrics.densityDpi : 0;
            if (dpi <= 0 || metrics.widthPixels <= 0 || metrics.heightPixels <= 0) {
                return 1f;
            }
            float screenWmm = metrics.widthPixels / dpi * 25.4f;
            float screenHmm = metrics.heightPixels / dpi * 25.4f;
            PDRectangle box = page.getMediaBox();
            int rotation = ((page.getRotation() % 360) + 360) % 360;
            boolean sideways = rotation == 90 || rotation == 270;
            float pageWmm = (sideways ? box.getHeight() : box.getWidth()) / MM;
            float pageHmm = (sideways ? box.getWidth() : box.getHeight()) / MM;
            if (pageWmm <= 0 || pageHmm <= 0) {
                return 1f;
            }
            float fit = Math.min(screenWmm / pageWmm, screenHmm / pageHmm);
            return Math.max(MIN_FIT, Math.min(MAX_FIT, fit));
        } catch (Throwable t) {
            appendLog("native: screen size unavailable, drawing in page units " + t);
            return 1f;
        }
    }

    /**
     * Rewrites target's contents with source's. If the write fails part-way and a backup is
     * given, the backup is written back so the user's PDF is never left half-written.
     */
    private void writeOver(File source, File target, File restoreFrom) throws IOException, PdfEditError {
        try {
            copy(source, target);
        } catch (IOException e) {
            if (restoreFrom != null) {
                try {
                    copy(restoreFrom, target);
                } catch (IOException restoreError) {
                    Log.e(TAG, "restore after failed write also failed", restoreError);
                    throw new PdfEditError("PDF_WRITE_FAILED",
                            "Writing the PDF failed and it could not be restored. A backup is kept in Shelf; use Undo.");
                }
            }
            throw new PdfEditError("PDF_WRITE_FAILED", "Writing the PDF failed; it was left unchanged.");
        }
    }

    private static void copy(File from, File to) throws IOException {
        try (InputStream in = new FileInputStream(from);
             OutputStream out = new FileOutputStream(to)) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) {
                out.write(buffer, 0, n);
            }
            out.flush();
            if (out instanceof FileOutputStream) {
                ((FileOutputStream) out).getFD().sync();
            }
        }
    }

    // ---- backups -------------------------------------------------------------------------

    private File internalDir() throws PdfEditError {
        return ensureDir(new File(reactContext.getFilesDir(), "snshelf-pdf"));
    }

    /** The SD card's working folder (null if none usable), its volume root, and why. */
    private static final class SdSpace {
        File dir;
        String root;
        String reason = "";
    }

    /**
     * Looks for a writable working folder on a removable SD card, in order:
     *  1. the app's own folder Android reports on the card (getExternalFilesDirs);
     *  2. that same app folder built from the card's root, in case Android didn't report it;
     *  3. a hidden .shelf-work folder at the top of the card.
     * The first one that can be created and written wins; `reason` says what happened, so
     * the Insert Page screen can explain a missing SD option (device report 2026-09-19).
     */
    private SdSpace findSd() {
        SdSpace sd = new SdSpace();
        List<String> roots = new ArrayList<>();
        List<File> candidates = new ArrayList<>();
        StringBuilder why = new StringBuilder();
        try {
            File[] dirs = reactContext.getExternalFilesDirs(null);
            if (dirs != null) {
                for (File dir : dirs) {
                    if (dir == null) continue;
                    String path = dir.getAbsolutePath();
                    int android = path.indexOf("/Android/");
                    if (android <= 0) continue;
                    String root = path.substring(0, android);
                    if (root.startsWith("/storage/emulated")) continue;
                    if (!roots.contains(root)) roots.add(root);
                    candidates.add(new File(dir, "snshelf-pdf"));
                }
            }
        } catch (Throwable t) {
            why.append("app folders unavailable (").append(t.getMessage()).append("); ");
        }
        File[] volumes = new File("/storage").listFiles();
        if (volumes != null) {
            for (File volume : volumes) {
                String name = volume.getName();
                if (name.equals("emulated") || name.equals("self") || !volume.isDirectory()) continue;
                String root = volume.getAbsolutePath();
                if (!roots.contains(root)) roots.add(root);
            }
        }
        if (roots.isEmpty()) {
            sd.reason = "no SD card found";
            return sd;
        }
        String pkg = reactContext.getPackageName();
        for (String root : roots) {
            candidates.add(new File(root + "/Android/data/" + pkg + "/files/snshelf-pdf"));
            candidates.add(new File(root + "/.shelf-work"));
        }
        for (File candidate : candidates) {
            boolean made = candidate.isDirectory() || candidate.mkdirs();
            if (made && isWritable(candidate)) {
                sd.dir = candidate;
                sd.root = rootOf(candidate, roots);
                sd.reason = "using " + candidate.getAbsolutePath();
                return sd;
            }
            why.append(candidate.getAbsolutePath()).append(made ? ": not writable; " : ": can't create; ");
        }
        sd.root = roots.get(0);
        sd.reason = "SD card " + roots.get(0) + " found, but " + why.toString().trim();
        return sd;
    }

    private static String rootOf(File dir, List<String> roots) {
        String path = dir.getAbsolutePath();
        for (String root : roots) {
            if (path.startsWith(root + "/")) return root;
        }
        return null;
    }

    private static File ensureDir(File dir) throws PdfEditError {
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new PdfEditError("PDF_EDIT_FAILED", "Shelf could not create its working folder.");
        }
        return dir;
    }

    /**
     * Deletes if allowed. The plugin host refuses deletes on external storage without DELETE
     * permission, and a cleanup delete that throws took down a whole insert (device log,
     * 2026-09-19: "has no DELETE permission on external storage"). Cleanup must never fail.
     */
    private static void deleteQuietly(File file) {
        try {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        } catch (Throwable t) {
            Log.w(TAG, "could not delete " + file, t);
        }
    }

    /** Writes a small file and LEAVES it: deleting it needs a permission we may not have. */
    private static boolean isWritable(File dir) {
        try (OutputStream out = new FileOutputStream(new File(dir, ".shelf-write-check"))) {
            out.write(1);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 'same' = the PDF's own storage; 'sd' / 'internal' = the user's explicit choice. */
    private File resolveWorkDir(String space, String pdfPath) throws PdfEditError {
        if ("internal".equals(space)) {
            return internalDir();
        }
        SdSpace sd = findSd();
        boolean pdfOnSd = sd.root != null && pdfPath.startsWith(sd.root + "/");
        if ("sd".equals(space) || pdfOnSd) {
            if (sd.dir == null) {
                if ("same".equals(space)) {
                    // The PDF is on the card but no card folder is usable: work internally
                    // (the space check still protects internal storage).
                    return internalDir();
                }
                throw new PdfEditError("PDF_SD_NOT_WRITABLE",
                        "Shelf can't use the SD card (" + sd.reason + "). Choose Internal as the working space.");
            }
            return sd.dir;
        }
        return internalDir();
    }

    private void ensureSpace(File workDir, long pdfSize) throws PdfEditError {
        long needed = pdfSize * SPACE_FACTOR + SPACE_MARGIN;
        long free = workDir.getUsableSpace();
        if (free < needed) {
            boolean onSd = workDir.getAbsolutePath().startsWith(internalDir().getAbsolutePath()) ? false : true;
            throw new PdfEditError("PDF_NO_SPACE", String.format(
                    "Not enough free space on %s: this PDF needs about %d MB free and %d MB is available. "
                            + "Nothing was changed. Choose the other working space, or free up space.",
                    onSd ? "the SD card" : "internal storage",
                    needed / (1024 * 1024), free / (1024 * 1024)));
        }
    }

    /** The working space holding this PDF's undo backup, or null. */
    private File undoDirFor(String path) throws Exception {
        List<File> dirs = new ArrayList<>();
        dirs.add(internalDir());
        File sd = findSd().dir;
        if (sd != null) dirs.add(sd);
        for (File dir : dirs) {
            if (metaFile(dir, path).exists() && backupFile(dir, path).exists()) {
                return dir;
            }
        }
        return null;
    }

    /** One undo per PDF: drop an older backup of it kept in the other working space. */
    private void dropOtherBackups(File keep, String path) {
        try {
            List<File> dirs = new ArrayList<>();
            dirs.add(internalDir());
            File sd = findSd().dir;
            if (sd != null) dirs.add(sd);
            for (File dir : dirs) {
                if (!dir.getAbsolutePath().equals(keep.getAbsolutePath())) {
                    deleteQuietly(backupFile(dir, path));
                    deleteQuietly(metaFile(dir, path));
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "dropOtherBackups", t);
        }
    }

    private static File backupFile(File dir, String path) throws Exception {
        return new File(dir, key(path) + ".pdf");
    }

    private static File metaFile(File dir, String path) throws Exception {
        return new File(dir, key(path) + ".json");
    }

    private static String key(String path) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-1").digest(path.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : digest) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private void writeMeta(File dir, String path, String action, int originalCount, int firstInserted,
                           int count, long finalSize) throws Exception {
        JSONObject json = new JSONObject();
        json.put("path", path);
        json.put("action", action);
        json.put("originalCount", originalCount);
        json.put("firstInsertedIndex", firstInserted);
        json.put("count", count);
        json.put("finalSize", finalSize);
        json.put("time", System.currentTimeMillis());
        try (OutputStream out = new FileOutputStream(metaFile(dir, path))) {
            out.write(json.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    private WritableMap readMeta(File meta) throws Exception {
        byte[] bytes = new byte[(int) meta.length()];
        try (InputStream in = new FileInputStream(meta)) {
            int read = 0;
            while (read < bytes.length) {
                int n = in.read(bytes, read, bytes.length - read);
                if (n < 0) break;
                read += n;
            }
        }
        JSONObject json = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        WritableMap map = Arguments.createMap();
        map.putString("path", json.getString("path"));
        // Older records predate removal and are always inserts.
        map.putString("action", json.optString("action", "insert"));
        map.putInt("originalCount", json.getInt("originalCount"));
        map.putInt("firstInsertedIndex", json.getInt("firstInsertedIndex"));
        map.putInt("count", json.getInt("count"));
        map.putDouble("finalSize", json.getDouble("finalSize"));
        map.putDouble("time", json.getDouble("time"));
        return map;
    }

    /**
     * Per working space: at most 5 PDFs' backups, none older than 30 days, and no more than
     * 500 MB in total (newest kept first). Also removes leftovers of interrupted inserts.
     */
    private void pruneBackups(File dir) {
        try {
            File[] metas = dir.listFiles((d, name) -> name.endsWith(".json"));
            long now = System.currentTimeMillis();
            if (metas != null) {
                List<File> sorted = new ArrayList<>(Arrays.asList(metas));
                sorted.sort(Comparator.comparingLong(File::lastModified).reversed());
                long total = 0;
                for (int i = 0; i < sorted.size(); i++) {
                    File meta = sorted.get(i);
                    String base = meta.getName().substring(0, meta.getName().length() - 5);
                    File backup = new File(dir, base + ".pdf");
                    total += backup.length();
                    boolean keep = i < BACKUP_MAX_COUNT
                            && now - meta.lastModified() <= BACKUP_MAX_AGE_MS
                            && (i == 0 || total <= BACKUP_MAX_BYTES);
                    if (!keep) {
                        deleteQuietly(backup);
                        deleteQuietly(meta);
                    }
                }
            }
            File[] stale = dir.listFiles((d, name) -> name.startsWith("insert-") || name.endsWith(".tmp")
                    || name.startsWith("PDFBox") || name.endsWith(".tmp.pdf"));
            if (stale != null) {
                for (File f : stale) {
                    if (now - f.lastModified() > 60 * 60 * 1000 && !f.getName().equals(".shelf-write-check")) {
                        deleteQuietly(f);
                    }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "pruneBackups", t);
        }
    }

    private static final class PdfEditError extends Exception {
        final String code;

        PdfEditError(String code, String message) {
            super(message);
            this.code = code;
        }
    }
}
