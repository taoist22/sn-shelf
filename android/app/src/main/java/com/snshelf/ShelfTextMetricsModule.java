package com.snshelf;

import android.graphics.Typeface;
import android.os.Build;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;

/**
 * Measures text with Android's own layout engine (StaticLayout) so placed
 * text-box frames can be sized to the reader's actual rendering instead of
 * a character-count estimate. Approach credit: tilmanbergt/textboxHelper.
 */
public class ShelfTextMetricsModule extends ReactContextBaseJavaModule {
    ShelfTextMetricsModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "ShelfTextMetrics";
    }

    @ReactMethod
    public void measureTextLayout(ReadableMap options, Promise promise) {
        try {
            String text = options.hasKey("text") ? options.getString("text") : null;
            int width = options.hasKey("width") ? options.getInt("width") : 0;
            double fontSize = options.hasKey("fontSize") ? options.getDouble("fontSize") : 0;
            if (text == null || width <= 0 || fontSize <= 0) {
                promise.reject("E_ARGS", "text, width and fontSize are required");
                return;
            }

            TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
            paint.setTextSize((float) fontSize);
            paint.setTypeface(Typeface.DEFAULT);

            StaticLayout layout;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                layout = StaticLayout.Builder
                        .obtain(text, 0, text.length(), paint, width)
                        .setAlignment(Layout.Alignment.ALIGN_NORMAL)
                        .setIncludePad(true)
                        .build();
            } else {
                layout = new StaticLayout(
                        text, paint, width,
                        Layout.Alignment.ALIGN_NORMAL, 1.0f, 0.0f, true);
            }

            WritableMap result = Arguments.createMap();
            result.putInt("layoutHeight", layout.getHeight());
            result.putInt("lineCount", layout.getLineCount());
            promise.resolve(result);
        } catch (Throwable error) {
            promise.reject("E_MEASURE", error);
        }
    }
}
