package com.snshelf;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;

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

    @ReactMethod
    public void writeState(String json, Promise promise) {
        try {
            File file = new File(reactContext.getFilesDir(), FILE_NAME);
            FileOutputStream output = new FileOutputStream(file, false);
            try {
                output.write(json.getBytes(StandardCharsets.UTF_8));
                output.flush();
            } finally {
                output.close();
            }
            promise.resolve(true);
        } catch (Exception error) {
            promise.reject("SHELF_STORAGE_WRITE_FAILED", error);
        }
    }

    /**
     * Workaround for a PluginHost bug: every plugin install/update keeps the
     * previous version's app_<timestamp>.npk, app_<timestamp>_libs/ and
     * oat/<arch>/app_<timestamp>.* artifacts, so the install dir grows
     * without bound. Keeps only the newest timestamp (the running version)
     * and deletes everything older. Runs once at plugin load from index.js.
     */
    @ReactMethod
    public void cleanupOldVersions(String dirPath, Promise promise) {
        try {
            File dir = new File(dirPath);
            File[] files = dir.listFiles();
            long maxTs = -1;
            if (files != null) {
                for (File file : files) {
                    String name = file.getName();
                    if (name.startsWith("app_") && name.endsWith(".npk")) {
                        maxTs = Math.max(maxTs, leadingDigits(name.substring(4)));
                    }
                }
            }
            if (files == null || maxTs < 0) {
                promise.resolve(cleanupResult(0, ""));
                return;
            }

            String keep = Long.toString(maxTs);
            long freed = 0;
            for (File file : files) {
                String name = file.getName();
                if (name.startsWith("app_") && !name.contains(keep)) {
                    freed += deleteRecursively(file);
                }
            }

            File oat = new File(dir, "oat");
            File[] archDirs = oat.isDirectory() ? oat.listFiles() : null;
            if (archDirs != null) {
                for (File arch : archDirs) {
                    File[] artifacts = arch.isDirectory() ? arch.listFiles() : null;
                    if (artifacts == null) {
                        continue;
                    }
                    for (File artifact : artifacts) {
                        String name = artifact.getName();
                        if (name.startsWith("app_") && !name.contains(keep)) {
                            freed += deleteRecursively(artifact);
                        }
                    }
                }
            }

            promise.resolve(cleanupResult(freed, keep));
        } catch (Exception error) {
            promise.reject("SHELF_STORAGE_CLEANUP_FAILED", error);
        }
    }

    private static WritableMap cleanupResult(long freedBytes, String kept) {
        WritableMap result = Arguments.createMap();
        result.putDouble("freedBytes", (double) freedBytes);
        result.putString("kept", kept);
        return result;
    }

    private static long leadingDigits(String value) {
        int end = 0;
        while (end < value.length() && Character.isDigit(value.charAt(end))) {
            end++;
        }
        if (end == 0) {
            return -1;
        }
        try {
            return Long.parseLong(value.substring(0, end));
        } catch (NumberFormatException ignored) {
            return -1;
        }
    }

    private static long deleteRecursively(File file) {
        long freed = 0;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    freed += deleteRecursively(child);
                }
            }
        }
        long size = file.isFile() ? file.length() : 0;
        if (file.delete()) {
            freed += size;
        }
        return freed;
    }
}
