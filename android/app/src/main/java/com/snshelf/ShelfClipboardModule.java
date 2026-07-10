package com.snshelf;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.UiThreadUtil;

/**
 * Writes quote text to the system clipboard so the user can place it with
 * the native text tool's "Paste Text" — the manual-placement path that
 * keeps positioning and text layout entirely in the editor's hands.
 */
public class ShelfClipboardModule extends ReactContextBaseJavaModule {
    ShelfClipboardModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "ShelfClipboard";
    }

    @ReactMethod
    public void setText(String text, Promise promise) {
        if (text == null) {
            promise.resolve(false);
            return;
        }
        UiThreadUtil.runOnUiThread(() -> {
            try {
                ClipboardManager clipboard = (ClipboardManager)
                        getReactApplicationContext()
                                .getSystemService(Context.CLIPBOARD_SERVICE);
                if (clipboard == null) {
                    promise.resolve(false);
                    return;
                }
                clipboard.setPrimaryClip(
                        ClipData.newPlainText("Shelf quote", text));
                promise.resolve(true);
            } catch (Throwable error) {
                promise.reject("E_CLIPBOARD", error);
            }
        });
    }
}
