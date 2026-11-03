package com.snshelf;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

/**
 * Shelf's floating button: a small round target that sits over whatever the user is
 * reading, so adding a page to a PDF does not mean opening the panel and walking a screen.
 *
 * The pattern is lifted from sn-lastnote's LastNoteModule, which has been running this way
 * on these devices for months. The parts that matter, and why:
 *
 *  - FINGER ONLY. A stylus or eraser event returns false and falls through to the page, so
 *    writing across the button does nothing. The pen is for writing; the finger is for this.
 *  - A long press and a tap are told apart here, not in JS, because JS timers stop while the
 *    panel is hidden (see reference_background_execution_limits in the plugin notes).
 *  - The view is held statically: the overlay belongs to the PluginHost process, not to the
 *    React view, so it survives the panel closing. It does NOT survive the host restarting,
 *    which is why Shelf re-shows it whenever it loads.
 *  - Drag has an 8 px threshold so a press is never mistaken for a move, and the position is
 *    remembered, because where this sits is a matter of taste and handedness.
 */
public class ShelfOverlayModule extends ReactContextBaseJavaModule {
    private static final String TAG = "ShelfOverlay";
    static final String EVENT_TAP = "onShelfOverlayTap";
    static final String EVENT_LONG_PRESS = "onShelfOverlayLongPress";
    static final String EVENT_MENU = "onShelfOverlayMenu";
    private static final long LONG_PRESS_MS = 600;
    /**
     * Hold this long and the button takes ITSELF down, without asking JS. The window belongs
     * to the host process, so uninstalling Shelf — or any state where the JS side is gone —
     * used to leave the button stranded until the device restarted (device report,
     * 2026-11-02). This is the escape hatch that always works.
     */
    private static final long SELF_REMOVE_MS = 3000;
    private static final int DRAG_SLOP_PX = 8;

    private static View sButton = null;
    private static View sMenu = null;
    private static WindowManager sWindowManager = null;
    private static int sSavedX = 60;
    private static int sSavedY = 420;

    private final ReactApplicationContext reactContext;
    private final SharedPreferences prefs;

    ShelfOverlayModule(ReactApplicationContext context) {
        super(context);
        reactContext = context;
        prefs = context.getSharedPreferences("snshelf_overlay", Context.MODE_PRIVATE);
        sSavedX = prefs.getInt("x", 60);
        sSavedY = prefs.getInt("y", 420);
    }

    @Override
    public String getName() {
        return "ShelfOverlay";
    }

    @ReactMethod
    public void isShowing(Promise promise) {
        promise.resolve(sButton != null);
    }

    @ReactMethod
    public void show(Promise promise) {
        reactContext.runOnUiQueueThread(() -> {
            try {
                if (sButton != null) {
                    // Already up. Re-adding it would make the window flicker and drop the
                    // touch that is mid-gesture, which is exactly what a churning React
                    // effect caused (device report, 2026-11-02).
                    promise.resolve(true);
                    return;
                }
                Context appCtx = reactContext.getApplicationContext();
                sWindowManager = (WindowManager) appCtx.getSystemService(Context.WINDOW_SERVICE);
                DisplayMetrics dm = appCtx.getResources().getDisplayMetrics();
                float density = dm.density > 0 ? dm.density : 1.875f;
                int sizePx = Math.round(46 * density);

                // White with a black rim and a black glyph: the screen is grayscale, so
                // contrast is the only styling that reads (plugin notes: no colour here).
                GradientDrawable bg = new GradientDrawable();
                bg.setShape(GradientDrawable.OVAL);
                bg.setColor(Color.WHITE);
                bg.setStroke(Math.max(2, Math.round(2.5f * density)), Color.BLACK);

                TextView button = new TextView(appCtx);
                button.setBackground(bg);
                button.setText("+");
                button.setTextColor(Color.BLACK);
                button.setTextSize(24);
                button.setTypeface(Typeface.DEFAULT_BOLD);
                button.setGravity(Gravity.CENTER);
                button.setContentDescription("Shelf");

                final WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                        sizePx, sizePx,
                        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                        PixelFormat.TRANSLUCENT);
                params.gravity = Gravity.TOP | Gravity.START;
                final int maxX = Math.max(0, dm.widthPixels - sizePx);
                final int maxY = Math.max(0, dm.heightPixels - sizePx);
                params.x = Math.max(0, Math.min(sSavedX, maxX));
                params.y = Math.max(0, Math.min(sSavedY, maxY));

                button.setOnTouchListener(new View.OnTouchListener() {
                    private int startX, startY, touchX, touchY;
                    private boolean dragging = false;
                    private long downAt = 0;

                    @Override
                    public boolean onTouch(View view, MotionEvent event) {
                        int tool = event.getToolType(0);
                        if (tool == MotionEvent.TOOL_TYPE_STYLUS || tool == MotionEvent.TOOL_TYPE_ERASER) {
                            return false; // the pen belongs to the page
                        }
                        switch (event.getAction()) {
                            case MotionEvent.ACTION_DOWN:
                                startX = params.x;
                                startY = params.y;
                                touchX = (int) event.getRawX();
                                touchY = (int) event.getRawY();
                                downAt = event.getEventTime();
                                dragging = false;
                                return true;
                            case MotionEvent.ACTION_MOVE:
                                int dx = (int) event.getRawX() - touchX;
                                int dy = (int) event.getRawY() - touchY;
                                if (Math.abs(dx) > DRAG_SLOP_PX || Math.abs(dy) > DRAG_SLOP_PX) {
                                    dragging = true;
                                    params.x = Math.max(0, Math.min(startX + dx, maxX));
                                    params.y = Math.max(0, Math.min(startY + dy, maxY));
                                    if (sWindowManager != null && sButton != null) {
                                        sWindowManager.updateViewLayout(sButton, params);
                                    }
                                }
                                return true;
                            case MotionEvent.ACTION_UP:
                                sSavedX = params.x;
                                sSavedY = params.y;
                                prefs.edit().putInt("x", sSavedX).putInt("y", sSavedY).apply();
                                if (dragging) {
                                    return true;
                                }
                                long held = event.getEventTime() - downAt;
                                if (held >= SELF_REMOVE_MS) {
                                    ShelfPdfEditModule.appendLog(
                                            "overlay: removed by a " + held + "ms hold");
                                    removeMenu();
                                    removeButton();
                                    return true;
                                }
                                if (!sendEvent(held >= LONG_PRESS_MS ? EVENT_LONG_PRESS : EVENT_TAP, null)
                                        && held >= LONG_PRESS_MS) {
                                    // Nothing on the JS side to answer — Shelf is gone or
                                    // reloading — so a long press removes the button instead
                                    // of doing nothing for ever.
                                    ShelfPdfEditModule.appendLog("overlay: no JS to answer; removing the button");
                                    removeMenu();
                                    removeButton();
                                }
                                return true;
                            default:
                                return false;
                        }
                    }
                });

                sButton = button;
                sWindowManager.addView(sButton, params);
                promise.resolve(true);
            } catch (Throwable t) {
                Log.e(TAG, "show failed", t);
                ShelfPdfEditModule.appendLog("overlay: show failed " + t);
                promise.reject("SHELF_OVERLAY_SHOW_FAILED", String.valueOf(t.getMessage()), t);
            }
        });
    }

    @ReactMethod
    public void hide(Promise promise) {
        reactContext.runOnUiQueueThread(() -> {
            removeMenu();
            removeButton();
            promise.resolve(true);
        });
    }

    /**
     * The long-press menu. Each item is {id, label, enabled}: a disabled row is drawn greyed
     * and reports nothing, so a row can explain why it is unavailable (a page Shelf did not
     * add, say) instead of vanishing and leaving the user guessing.
     */
    @ReactMethod
    public void showMenu(ReadableArray items, Promise promise) {
        reactContext.runOnUiQueueThread(() -> {
            try {
                if (sMenu != null) {
                    // Already open: a second press means "put it away". Without this the
                    // only way out was the Close row, which could be off screen.
                    removeMenu();
                    promise.resolve(true);
                    return;
                }
                Context appCtx = reactContext.getApplicationContext();
                if (sWindowManager == null) {
                    sWindowManager = (WindowManager) appCtx.getSystemService(Context.WINDOW_SERVICE);
                }
                DisplayMetrics dm = appCtx.getResources().getDisplayMetrics();
                float density = dm.density > 0 ? dm.density : 1.875f;
                int pad = Math.round(8 * density);
                int width = Math.min(Math.round(360 * density), dm.widthPixels - 2 * pad);

                LinearLayout container = new LinearLayout(appCtx);
                container.setOrientation(LinearLayout.VERTICAL);
                GradientDrawable bg = new GradientDrawable();
                bg.setColor(Color.WHITE);
                bg.setCornerRadius(10 * density);
                bg.setStroke(Math.max(2, Math.round(2.5f * density)), Color.BLACK);
                container.setBackground(bg);
                container.setPadding(pad, pad, pad, pad);

                for (int i = 0; i < items.size(); i++) {
                    ReadableMap item = items.getMap(i);
                    final String id = item.hasKey("id") ? item.getString("id") : "";
                    String label = item.hasKey("label") ? item.getString("label") : id;
                    boolean enabled = !item.hasKey("enabled") || item.getBoolean("enabled");

                    if (i > 0) {
                        View divider = new View(appCtx);
                        divider.setBackgroundColor(Color.argb(60, 0, 0, 0));
                        container.addView(divider, new LinearLayout.LayoutParams(
                                LinearLayout.LayoutParams.MATCH_PARENT, Math.max(1, (int) density)));
                    }

                    TextView row = new TextView(appCtx);
                    row.setText(label);
                    row.setTextSize(17);
                    row.setTextColor(enabled ? Color.BLACK : Color.argb(120, 0, 0, 0));
                    int rowPad = Math.round(14 * density);
                    row.setPadding(rowPad, rowPad, rowPad, rowPad);
                    if (enabled) {
                        row.setOnClickListener(view -> {
                            removeMenu();
                            WritableMap payload = Arguments.createMap();
                            payload.putString("id", id);
                            sendEvent(EVENT_MENU, payload);
                        });
                    }
                    container.addView(row);
                }

                final WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                        width, WindowManager.LayoutParams.WRAP_CONTENT,
                        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                        PixelFormat.TRANSLUCENT);
                params.gravity = Gravity.TOP | Gravity.START;
                params.x = Math.max(pad, Math.min(sSavedX - width / 2, dm.widthPixels - width - pad));
                // Estimated from the rows it holds, then clamped so the WHOLE menu is on
                // screen. A guessed height left the last rows — Close among them — drawn
                // past the bottom edge, where a tap hits nothing (device report, 2026-11-02).
                int rowHeight = Math.round(52 * density);
                int menuHeight = items.size() * rowHeight + 2 * pad;
                int highest = Math.max(pad, dm.heightPixels - menuHeight - pad);
                params.y = Math.max(pad, Math.min(sSavedY + rowHeight, highest));

                sMenu = container;
                sWindowManager.addView(sMenu, params);
                promise.resolve(true);
            } catch (Throwable t) {
                Log.e(TAG, "showMenu failed", t);
                ShelfPdfEditModule.appendLog("overlay: menu failed " + t);
                promise.reject("SHELF_OVERLAY_MENU_FAILED", String.valueOf(t.getMessage()), t);
            }
        });
    }

    @ReactMethod
    public void hideMenu(Promise promise) {
        reactContext.runOnUiQueueThread(() -> {
            removeMenu();
            promise.resolve(true);
        });
    }

    private void removeButton() {
        if (sWindowManager != null && sButton != null) {
            try {
                sWindowManager.removeView(sButton);
            } catch (Throwable ignored) {
                // already gone
            }
        }
        sButton = null;
    }

    private void removeMenu() {
        if (sWindowManager != null && sMenu != null) {
            try {
                sWindowManager.removeView(sMenu);
            } catch (Throwable ignored) {
                // already gone
            }
        }
        sMenu = null;
    }

    /** False when there is no live JS side to receive the event. */
    private boolean sendEvent(String name, WritableMap payload) {
        try {
            if (!reactContext.hasActiveReactInstance()) {
                return false;
            }
            reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(name, payload);
            return true;
        } catch (Throwable t) {
            Log.e(TAG, "sendEvent " + name, t);
            return false;
        }
    }
}
