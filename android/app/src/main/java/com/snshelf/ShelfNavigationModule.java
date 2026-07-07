package com.snshelf;

import android.content.ComponentName;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

public class ShelfNavigationModule extends ReactContextBaseJavaModule {
    private final ReactApplicationContext reactContext;

    ShelfNavigationModule(ReactApplicationContext context) {
        super(context);
        reactContext = context;
    }

    @Override
    public String getName() {
        return "ShelfNavigation";
    }

    @ReactMethod
    public void openNote(String filePath, int page, Promise promise) {
        try {
            if (filePath == null || filePath.trim().isEmpty()) {
                promise.reject("SHELF_NAVIGATION_BAD_PATH", "filePath is required");
                return;
            }

            startNoteActivity(filePath, page);
            promise.resolve(true);
        } catch (Exception error) {
            promise.reject("SHELF_NAVIGATION_OPEN_NOTE_FAILED", error);
        }
    }

    @ReactMethod
    public void openNoteAfterDelay(String filePath, int page, int delayMs, Promise promise) {
        try {
            if (filePath == null || filePath.trim().isEmpty()) {
                promise.reject("SHELF_NAVIGATION_BAD_PATH", "filePath is required");
                return;
            }

            postDelayed(() -> startNoteActivity(filePath, page), delayMs);
            promise.resolve(true);
        } catch (Exception error) {
            promise.reject("SHELF_NAVIGATION_SCHEDULE_NOTE_FAILED", error);
        }
    }

    @ReactMethod
    public void openDocumentAfterDelay(String filePath, int delayMs, Promise promise) {
        try {
            if (filePath == null || filePath.trim().isEmpty()) {
                promise.reject("SHELF_NAVIGATION_BAD_PATH", "filePath is required");
                return;
            }

            postDelayed(() -> startDocumentActivity(filePath), delayMs);
            promise.resolve(true);
        } catch (Exception error) {
            promise.reject("SHELF_NAVIGATION_SCHEDULE_DOCUMENT_FAILED", error);
        }
    }

    @ReactMethod
    public void openFolderAfterDelay(String folderPath, int delayMs, Promise promise) {
        try {
            if (folderPath == null || folderPath.trim().isEmpty()) {
                promise.reject("SHELF_NAVIGATION_BAD_PATH", "folderPath is required");
                return;
            }

            postDelayed(() -> startFolderActivity(folderPath), delayMs);
            promise.resolve(true);
        } catch (Exception error) {
            promise.reject("SHELF_NAVIGATION_SCHEDULE_FOLDER_FAILED", error);
        }
    }

    private void postDelayed(Runnable action, int delayMs) {
        int safeDelayMs = Math.max(0, Math.min(delayMs, 2000));
        new Handler(Looper.getMainLooper()).postDelayed(action, safeDelayMs);
    }

    private void startNoteActivity(String filePath, int page) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setComponent(new ComponentName(
                "com.ratta.supernote.note",
                "com.ratta.supernote.note.view.NoteInsidePagesActivity"
        ));
        intent.putExtra("file_path", filePath);
        if (page >= 1) {
            intent.putExtra("page", page);
        }
        // page < 1 → no page extra; the note opens on its last-used page.
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        reactContext.startActivity(intent);
    }

    private void startDocumentActivity(String filePath) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setComponent(new ComponentName(
                "com.supernote.document",
                "com.supernote.document.MainActivity"
        ));
        // The document viewer ignores a "page" extra and always opens the
        // last-used page, so no page is passed here.
        intent.putExtra("file_path", filePath);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        reactContext.startActivity(intent);
    }

    private void startFolderActivity(String folderPath) {
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setComponent(new ComponentName(
                "com.ratta.supernote.inbox",
                "com.ratta.supernote.explorer.FileManagerMainActivity"
        ));
        intent.putExtra("folder_path", folderPath);
        intent.putExtra("source_type", 2);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        reactContext.startActivity(intent);
    }
}
