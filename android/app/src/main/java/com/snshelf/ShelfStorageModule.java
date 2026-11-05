package com.snshelf;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

public class ShelfStorageModule extends ReactContextBaseJavaModule {
    private static final String FILE_NAME = "sn-shelf-state.json";
    private final ReactApplicationContext reactContext;

    ShelfStorageModule(ReactApplicationContext context) {
        super(context);
        reactContext = context;
    }

    @Override
    public String getName() {
        return "ShelfStorage";
    }

    @ReactMethod
    public void readState(Promise promise) {
        try {
            File file = new File(reactContext.getFilesDir(), FILE_NAME);
            if (!file.exists()) {
                promise.resolve(null);
                return;
            }

            byte[] bytes = new byte[(int) file.length()];
            FileInputStream input = new FileInputStream(file);
            try {
                int read = input.read(bytes);
                if (read < 0) {
                    promise.resolve("");
                    return;
                }
                promise.resolve(new String(bytes, 0, read, StandardCharsets.UTF_8));
            } finally {
                input.close();
            }
        } catch (Exception error) {
            promise.reject("SHELF_STORAGE_READ_FAILED", error);
        }
    }

    /**
     * Writes to a temp file, forces it to disk, then renames over the real one.
     * The old truncate-in-place write could leave half a JSON document if it was
     * interrupted, and a half document parses as an EMPTY shelf, which the next
     * save then made permanent (found while diagnosing a shelf that looked
     * truncated, 2026-11-04).
     */
    @ReactMethod
    public void writeState(String json, Promise promise) {
        File file = new File(reactContext.getFilesDir(), FILE_NAME);
        File temp = new File(reactContext.getFilesDir(), FILE_NAME + ".new");
        try {
            FileOutputStream output = new FileOutputStream(temp, false);
            try {
                output.write(json.getBytes(StandardCharsets.UTF_8));
                output.flush();
                output.getFD().sync();
            } finally {
                output.close();
            }
            if (!temp.renameTo(file)) {
                // Rename within one directory should not fail; if it does, the
                // old file is still intact and the temp file is the casualty.
                temp.delete();
                promise.reject("SHELF_STORAGE_WRITE_FAILED", "Could not replace the shelf state file.");
                return;
            }
            promise.resolve(true);
        } catch (Exception error) {
            temp.delete();
            promise.reject("SHELF_STORAGE_WRITE_FAILED", error);
        }
    }
}
