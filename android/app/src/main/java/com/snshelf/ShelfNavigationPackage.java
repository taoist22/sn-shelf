package com.snshelf;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.List;

public class ShelfNavigationPackage implements ReactPackage {
    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
        List<NativeModule> modules = new ArrayList<>();
        modules.add(new ShelfNavigationModule(reactContext));
        modules.add(new ShelfStorageModule(reactContext));
        modules.add(new ShelfTextMetricsModule(reactContext));
        modules.add(new ShelfClipboardModule(reactContext));
        modules.add(new ShelfInkModule(reactContext));
        modules.add(new ShelfPdfEditModule(reactContext));
        modules.add(new ShelfOverlayModule(reactContext));
        return modules;
    }

    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
        List<ViewManager> managers = new ArrayList<>();
        managers.add(new ShelfInkViewManager());
        return managers;
    }
}
