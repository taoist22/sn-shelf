package com.snshelf;

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
    /** Bumped with each native change; shown on screen and in the log to spot stale installs. */
    static final int NATIVE_BUILD = 16;
    private static final File LOG_FILE = new File("/storage/emulated/0/EXPORT/shelf-log.txt");
    private static final long LOG_MAX_BYTES = 512L * 1024;
    private static final float MM = 72f / 25.4f;
    private static final float RULE_SPACING = 8f * MM;   // Supernote's standard 8 mm ruling
    private static final float RULE_MARGIN = 10f * MM;
    private static final long BACKUP_MAX_AGE_MS = 30L * 24 * 60 * 60 * 1000;
    private static final int BACKUP_MAX_COUNT = 5;
    /** Undo backups are full copies; cap what they may use on each storage. */
    private static final long BACKUP_MAX_BYTES = 500L * 1024 * 1024;
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
                            String background, String space, Promise promise) {
        worker.execute(() -> {
            try {
                appendLog("native " + NATIVE_BUILD + ": insert " + count + " " + background + " " + position
                        + " page " + (anchorIndex + 1) + " space=" + space + " file=" + path);
                WritableMap result = doInsert(path, anchorIndex, position, count, background, space);
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
            map.putInt("nativeBuild", NATIVE_BUILD);
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

    private WritableMap doInsert(String path, int anchorIndex, String position, int count,
                                 String background, String space) throws Exception {
        if (count < 1 || count > MAX_PAGES) {
            throw new PdfEditError("PDF_BAD_COUNT", "Insert between 1 and " + MAX_PAGES + " pages.");
        }
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
            PDPage previous = null;
            for (int i = 0; i < count; i++) {
                PDPage page = newPageLike(anchor);
                drawBackground(doc, page, background);
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

        // Verify with a fresh parser before anything touches the original.
        try (PDDocument check = load(built, workDir)) {
            int finalCount = check.getPages().getCount();
            if (finalCount != originalCount + count) {
                throw new PdfEditError("PDF_VERIFY_FAILED", "The edited PDF did not check out, so nothing was changed.");
            }
        }
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
        result.putInt("originalCount", originalCount);
        result.putInt("finalCount", originalCount + count);
        result.putInt("firstInsertedIndex", firstInserted);
        result.putInt("count", count);
        writeMeta(workDir, path, originalCount, firstInserted, count, source.length());
        dropOtherBackups(workDir, path);
        pruneBackups(workDir);
        return result;
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
    private PDPage newPageLike(PDPage anchor) {
        PDRectangle visible = anchor.getCropBox();
        PDPage page = new PDPage(new PDRectangle(visible.getWidth(), visible.getHeight()));
        page.setRotation(anchor.getRotation());
        page.getCOSObject().setBoolean(INSERTED_MARKER, true);
        return page;
    }

    /**
     * Light grey rules every 8 mm, drawn so they run HORIZONTALLY as displayed: on a page
     * rotated 90/270 the displayed horizontal is the page's vertical axis.
     */
    private void drawBackground(PDDocument doc, PDPage page, String background) throws IOException {
        if (!"lined".equals(background)) {
            return;
        }
        PDRectangle box = page.getMediaBox();
        int rotation = ((page.getRotation() % 360) + 360) % 360;
        boolean sideways = rotation == 90 || rotation == 270;
        try (PDPageContentStream cs = new PDPageContentStream(doc, page)) {
            cs.setStrokingColor(0.72f, 0.72f, 0.72f);
            cs.setLineWidth(0.5f);
            if (!sideways) {
                for (float y = box.getHeight() - RULE_MARGIN - RULE_SPACING; y > RULE_MARGIN; y -= RULE_SPACING) {
                    cs.moveTo(RULE_MARGIN, y);
                    cs.lineTo(box.getWidth() - RULE_MARGIN, y);
                }
            } else {
                for (float x = RULE_MARGIN + RULE_SPACING; x < box.getWidth() - RULE_MARGIN; x += RULE_SPACING) {
                    cs.moveTo(x, RULE_MARGIN);
                    cs.lineTo(x, box.getHeight() - RULE_MARGIN);
                }
            }
            cs.stroke();
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

    private void writeMeta(File dir, String path, int originalCount, int firstInserted, int count,
                           long finalSize) throws Exception {
        JSONObject json = new JSONObject();
        json.put("path", path);
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
