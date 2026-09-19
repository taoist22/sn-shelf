package com.snshelf;

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
    private static final float MM = 72f / 25.4f;
    private static final float RULE_SPACING = 8f * MM;   // Supernote's standard 8 mm ruling
    private static final float RULE_MARGIN = 10f * MM;
    private static final long BACKUP_MAX_AGE_MS = 30L * 24 * 60 * 60 * 1000;
    private static final int BACKUP_MAX_COUNT = 5;

    private final ReactApplicationContext reactContext;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
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
                            String background, Promise promise) {
        worker.execute(() -> {
            try {
                promise.resolve(doInsert(path, anchorIndex, position, count, background));
            } catch (PdfEditError e) {
                promise.reject(e.code, e.getMessage());
            } catch (Throwable t) {
                Log.e(TAG, "insertPages failed", t);
                promise.reject("PDF_EDIT_FAILED", String.valueOf(t.getMessage()), t);
            }
        });
    }

    /** Resolves the undo record for this PDF, or null when there is nothing to undo. */
    @ReactMethod
    public void getUndo(String path, Promise promise) {
        worker.execute(() -> {
            try {
                File meta = metaFile(path);
                File backup = backupFile(path);
                if (!meta.exists() || !backup.exists()) {
                    promise.resolve(null);
                    return;
                }
                WritableMap record = readMeta(meta);
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
                File meta = metaFile(path);
                File backup = backupFile(path);
                if (!meta.exists() || !backup.exists()) {
                    throw new PdfEditError("PDF_NO_UNDO", "There is no insert to undo for this PDF.");
                }
                WritableMap record = readMeta(meta);
                File target = new File(path);
                if (target.length() != record.getDouble("finalSize")) {
                    throw new PdfEditError("PDF_CHANGED",
                            "This PDF has changed since the pages were inserted, so undo was cancelled.");
                }
                writeOver(backup, target, null);
                //noinspection ResultOfMethodCallIgnored
                backup.delete();
                //noinspection ResultOfMethodCallIgnored
                meta.delete();
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
                                 String background) throws Exception {
        if (count < 1 || count > MAX_PAGES) {
            throw new PdfEditError("PDF_BAD_COUNT", "Insert between 1 and " + MAX_PAGES + " pages.");
        }
        boolean before = "before".equals(position);
        File source = new File(path);
        if (!source.isFile()) {
            throw new PdfEditError("PDF_NOT_FOUND", "The PDF could not be found.");
        }
        ensurePdfBox();
        File workDir = workDir();
        File built = new File(workDir, "insert-" + System.currentTimeMillis() + ".pdf");
        long sourceSize = source.length();
        long sourceModified = source.lastModified();

        int originalCount;
        int firstInserted;
        try (PDDocument doc = load(source)) {
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

        // Verify with a fresh parser before anything touches the original.
        try (PDDocument check = load(built)) {
            int finalCount = check.getPages().getCount();
            if (finalCount != originalCount + count) {
                throw new PdfEditError("PDF_VERIFY_FAILED", "The edited PDF did not check out, so nothing was changed.");
            }
        }
        if (source.length() != sourceSize || source.lastModified() != sourceModified) {
            //noinspection ResultOfMethodCallIgnored
            built.delete();
            throw new PdfEditError("PDF_CHANGED", "The PDF changed while the pages were being added. Try again.");
        }

        // Back up the original (replacing any older backup of this PDF), then write over it.
        File backup = backupFile(path);
        File backupTmp = new File(backup.getPath() + ".tmp");
        copy(source, backupTmp);
        if (backup.exists() && !backup.delete()) {
            throw new PdfEditError("PDF_EDIT_FAILED", "Could not replace the previous backup.");
        }
        if (!backupTmp.renameTo(backup)) {
            throw new PdfEditError("PDF_EDIT_FAILED", "Could not store the backup.");
        }
        try {
            writeOver(built, source, backup);
        } finally {
            //noinspection ResultOfMethodCallIgnored
            built.delete();
        }

        WritableMap result = Arguments.createMap();
        result.putString("path", path);
        result.putInt("originalCount", originalCount);
        result.putInt("finalCount", originalCount + count);
        result.putInt("firstInsertedIndex", firstInserted);
        result.putInt("count", count);
        writeMeta(path, originalCount, firstInserted, count, source.length());
        pruneBackups();
        return result;
    }

    private PDDocument load(File file) throws IOException, PdfEditError {
        try {
            return PDDocument.load(file, MemoryUsageSetting.setupTempFileOnly());
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

    private File workDir() throws PdfEditError {
        File dir = new File(reactContext.getFilesDir(), "snshelf-pdf");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new PdfEditError("PDF_EDIT_FAILED", "Shelf could not create its working folder.");
        }
        return dir;
    }

    private File backupFile(String path) throws Exception {
        return new File(workDir(), key(path) + ".pdf");
    }

    private File metaFile(String path) throws Exception {
        return new File(workDir(), key(path) + ".json");
    }

    private static String key(String path) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-1").digest(path.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : digest) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private void writeMeta(String path, int originalCount, int firstInserted, int count, long finalSize)
            throws Exception {
        JSONObject json = new JSONObject();
        json.put("path", path);
        json.put("originalCount", originalCount);
        json.put("firstInsertedIndex", firstInserted);
        json.put("count", count);
        json.put("finalSize", finalSize);
        json.put("time", System.currentTimeMillis());
        try (OutputStream out = new FileOutputStream(metaFile(path))) {
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

    /** Keeps at most 5 PDFs' backups, none older than 30 days. */
    private void pruneBackups() {
        try {
            File[] metas = workDir().listFiles((dir, name) -> name.endsWith(".json"));
            if (metas == null) return;
            List<File> sorted = new ArrayList<>(Arrays.asList(metas));
            sorted.sort(Comparator.comparingLong(File::lastModified).reversed());
            long now = System.currentTimeMillis();
            for (int i = 0; i < sorted.size(); i++) {
                File meta = sorted.get(i);
                if (i >= BACKUP_MAX_COUNT || now - meta.lastModified() > BACKUP_MAX_AGE_MS) {
                    String base = meta.getName().substring(0, meta.getName().length() - 5);
                    //noinspection ResultOfMethodCallIgnored
                    new File(meta.getParentFile(), base + ".pdf").delete();
                    //noinspection ResultOfMethodCallIgnored
                    meta.delete();
                }
            }
            // Leftover build files from an interrupted insert.
            File[] stale = workDir().listFiles((dir, name) -> name.startsWith("insert-") || name.endsWith(".tmp"));
            if (stale != null) {
                for (File f : stale) {
                    if (now - f.lastModified() > 60 * 60 * 1000) {
                        //noinspection ResultOfMethodCallIgnored
                        f.delete();
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
