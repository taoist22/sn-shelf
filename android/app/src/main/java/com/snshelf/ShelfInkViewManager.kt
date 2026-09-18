package com.snshelf

import android.graphics.Color
import android.view.View
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext

/**
 * Host view for the firmware pen engine on the quote-capture screen, rendered from JSX as
 * `<ShelfInkSurface />`. Same as sn-flashcards' InkSurfaceViewManager.
 *
 * - Must come from a ViewManager: a natively attached view is never measured, and the
 *   engine sizes its writing bitmap from the measured host (0x0 otherwise).
 * - Must stay a plain View: PWCoreCtrl adds its ink drawable to the host's overlay, which
 *   SurfaceView does not support.
 * - JS gives it a FIXED size and position: the engine derives its writable region from
 *   where the host is when it binds.
 *
 * Plain white background, as in flashcards. Ruled guide lines are a later step; if drawn
 * here, they must fill only this view's bounds — canvas.drawColor() fills the whole clip,
 * and React Native views do not clip their children.
 */
class ShelfInkViewManager : SimpleViewManager<View>() {

    override fun getName() = "ShelfInkSurface"

    override fun createViewInstance(context: ThemedReactContext): View {
        val v = View(context)
        v.setBackgroundColor(Color.WHITE)
        current = v
        return v
    }

    /** Unmounting with the engine still enabled wedges PluginHost (reboot needed). */
    override fun onDropViewInstance(view: View) {
        if (current === view) {
            ShelfInkModule.release("ink host unmounted")
            current = null
        }
        super.onDropViewInstance(view)
    }

    companion object {
        @Volatile
        var current: View? = null
            private set
    }
}
