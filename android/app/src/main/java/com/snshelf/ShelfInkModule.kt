package com.snshelf

import android.view.View
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Firmware pen engine for handwritten notes on captured quotes. Ported from sn-strokeprobe
 * (itself sn-flashcards' InkSurfaceModule plus [readStrokes]).
 *
 * [readStrokes] hands the ink to JS as point geometry; Shelf stores it with the quote and
 * later inserts it into a note as real strokes (verified on device 2026-09-18).
 * Undocumented vendor reflection, so everything fails soft: [isAvailable] false means the
 * capture screen simply has no writing area.
 *
 * Background: ~/supernote-plugins/references/firmware-pen-engine-einkpwinterface.md
 */
class ShelfInkModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "ShelfInk"

    override fun invalidate() {
        release("react instance torn down")
        super.invalidate()
    }

    companion object {
        private const val PENTYPE_PEN_1 = 2
        private const val DRAWOBJ_FREEHAND = 0
        private const val PENCOLOR_BLACK = -16777216
        private const val DISPATH_TOUCH_HOST_LATER = 2
        const val DEFAULT_PEN_WIDTH = 10.0f

        @Volatile private var engine: Any? = null

        /** Every exit path comes through here. Never mints an engine just to stop one. */
        fun release(reason: String): String {
            val e = engine ?: return "nothing active"
            val r = runCatching {
                e.javaClass.getMethod("setPWEnabled", java.lang.Boolean.TYPE).invoke(e, false)
            }
            engine = null
            android.util.Log.i("ShelfInk", "released: $reason")
            return if (r.isSuccess) "released" else "release threw: ${r.exceptionOrNull()?.cause}"
        }
    }

    @ReactMethod
    fun isAvailable(promise: Promise) {
        val ok = runCatching {
            View::class.java.getMethod("getPWInterFace")
            Class.forName("android.view.EinkPWInterface")
            true
        }.getOrDefault(false)
        promise.resolve(ok)
    }

    /** Bind to the mounted surface and accept stylus input (finger off = palm rejection). */
    @ReactMethod
    fun activate(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            val host = ShelfInkViewManager.current
            if (host == null) { promise.resolve("no-surface"); return@runOnUiThread }
            if (host.width == 0 || host.height == 0) {
                promise.resolve("not-laid-out"); return@runOnUiThread
            }
            val e = engine ?: runCatching {
                View::class.java.getMethod("getPWInterFace").invoke(host)
            }.getOrNull()
            if (e == null) { promise.resolve("no-engine"); return@runOnUiThread }
            engine = e

            runCatching { e.javaClass.getMethod("onWindowChanged").invoke(e) }
            runCatching { e.javaClass.getMethod("clearUnWriteRectList").invoke(e) }
            set(e, "setPenType", Integer.TYPE, PENTYPE_PEN_1)
            set(e, "setDrawObjectType", Integer.TYPE, DRAWOBJ_FREEHAND)
            set(e, "setPenStdWidth", java.lang.Float.TYPE, DEFAULT_PEN_WIDTH)
            set(e, "setPenColor", Integer.TYPE, PENCOLOR_BLACK)
            set(e, "setFingerWritable", java.lang.Boolean.TYPE, false)
            set(e, "disablePenEraseFloatFlower", java.lang.Boolean.TYPE, true)
            set(e, "enableTouchDispatch", Integer.TYPE, DISPATH_TOUCH_HOST_LATER)
            set(e, "disablePWInput", java.lang.Boolean.TYPE, false)

            // setPWEnabled returns void: success is "did not throw".
            val on = runCatching {
                e.javaClass.getMethod("setPWEnabled", java.lang.Boolean.TYPE).invoke(e, true)
            }
            // Clear AFTER binding, then force the repaint clearing does not do itself.
            runCatching {
                e.javaClass.getMethod("clearContentX", java.lang.Boolean.TYPE).invoke(e, true)
            }
            repaint(e, host)
            promise.resolve(if (on.isSuccess) "active" else "enable-failed")
        }
    }

    /**
     * Re-read where the host is WITHOUT clearing the ink — for after the handwriting
     * keyboard may have shifted the window. [activate] clears, so it must not be used
     * for this or it would wipe what the user already wrote.
     */
    @ReactMethod
    fun refreshRegion(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            val e = engine
            if (e == null) { promise.resolve("inactive"); return@runOnUiThread }
            runCatching { e.javaClass.getMethod("onWindowChanged").invoke(e) }
            runCatching { e.javaClass.getMethod("clearUnWriteRectList").invoke(e) }
            promise.resolve("refreshed")
        }
    }

    @ReactMethod
    fun clear(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            val e = engine
            if (e == null) { promise.resolve("inactive"); return@runOnUiThread }
            val r = runCatching {
                e.javaClass.getMethod("clearContentX", java.lang.Boolean.TYPE).invoke(e, true)
            }
            ShelfInkViewManager.current?.let { repaint(e, it) }
            promise.resolve(if (r.isSuccess) "cleared" else "clear-failed")
        }
    }

    @ReactMethod
    fun deactivate(promise: Promise) {
        UiThreadUtil.runOnUiThread { promise.resolve(release("closed from panel")) }
    }

    /**
     * The captured ink as geometry.
     *
     * Result: { host: {width, height, screenX, screenY}, strokeCount, actions: {code: n},
     *           strokes: [[x, y, press, x, y, press, ...], ...] }
     *
     * Stroke count comes from getAvailableRepaintStep — NOT getAvailableUndo, which is undo
     * depth and caps independently of the model. Config records (action 0x7Cxx) carry no
     * position and are skipped; every other action's point is kept, and the action codes
     * seen are reported so JS/the reader can tell what the stream actually contained.
     * Coordinates are passed through untouched; the host's size and on-screen origin are
     * reported alongside so their space can be identified from the log.
     */
    @ReactMethod
    fun readStrokes(promise: Promise) {
        UiThreadUtil.runOnUiThread {
            val e = engine
            val host = ShelfInkViewManager.current
            if (e == null || host == null) {
                promise.reject("SHELF_INK_INACTIVE", "Start ink first."); return@runOnUiThread
            }
            try {
                val steps = (e.javaClass.getMethod("getAvailableRepaintStep").invoke(e) as? Int) ?: 0
                val loc = IntArray(2)
                host.getLocationOnScreen(loc)
                val hostMap = Arguments.createMap().apply {
                    putInt("width", host.width)
                    putInt("height", host.height)
                    putInt("screenX", loc[0])
                    putInt("screenY", loc[1])
                }
                val actions = HashMap<Int, Int>()
                val strokes = Arguments.createArray()
                val getStep = e.javaClass.getMethod("getStepPointArray", Integer.TYPE)
                for (step in 0 until steps) {
                    val list = getStep.invoke(e, step) as? java.util.ArrayList<*> ?: continue
                    val flat = Arguments.createArray()
                    for (pt in list) {
                        if (pt == null) continue
                        val action = intField(pt, "action") ?: continue
                        actions[action] = (actions[action] ?: 0) + 1
                        if (action and 0xFF00 == 0x7C00) continue
                        flat.pushInt(intField(pt, "x") ?: continue)
                        flat.pushInt(intField(pt, "y") ?: 0)
                        flat.pushDouble((floatField(pt, "press") ?: 0f).toDouble())
                    }
                    if (flat.size() > 0) strokes.pushArray(flat)
                }
                val actionMap = Arguments.createMap()
                actions.forEach { (k, v) -> actionMap.putInt("0x" + Integer.toHexString(k), v) }
                promise.resolve(Arguments.createMap().apply {
                    putMap("host", hostMap)
                    putInt("strokeCount", steps)
                    putMap("actions", actionMap)
                    putArray("strokes", strokes)
                })
            } catch (t: Throwable) {
                promise.reject("SHELF_INK_READ_FAILED", t.cause ?: t)
            }
        }
    }

    private fun repaint(e: Any, host: View) {
        runCatching {
            e.javaClass.getMethod("invalidateHost", android.graphics.Rect::class.java)
                .invoke(e, android.graphics.Rect(0, 0, host.width, host.height))
        }
        host.invalidate()
    }

    private fun set(engine: Any, name: String, type: Class<*>, value: Any) {
        runCatching { engine.javaClass.getMethod(name, type).invoke(engine, value) }
            .onFailure { android.util.Log.w("ShelfInk", "$name failed: ${it.cause ?: it}") }
    }

    private fun intField(pt: Any, name: String): Int? =
        runCatching { pt.javaClass.getField(name).getInt(pt) }.getOrNull()

    private fun floatField(pt: Any, name: String): Float? =
        runCatching { pt.javaClass.getField(name).getFloat(pt) }.getOrNull()
}
