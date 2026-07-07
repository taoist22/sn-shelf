import {AppRegistry, DeviceEventEmitter, Image, NativeModules} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {PluginManager} from 'sn-plugin-lib';
import {
  SHELF_CAPTURE_EVENT,
  SHELF_OPENED_EVENT,
  setPendingCapture,
} from './src/app/events';

const BUTTON_TYPE_TOOLBAR = 1;
const BUTTON_TYPE_TEXT_SELECTION = 3;
const TOOLBAR_BUTTON_ID = 100;
const CAPTURE_BUTTON_ID = 102;
const SHOW_TYPE_WITH_UI = 1;

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

PluginManager.registerButton(BUTTON_TYPE_TOOLBAR, ['NOTE', 'DOC'], {
  id: TOOLBAR_BUTTON_ID,
  name: 'Shelf',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: SHOW_TYPE_WITH_UI,
});

// Quote capture lives on the text-selection toolbar (type 3, DOC only):
// it appears when text is highlighted in a PDF/EPUB, so the selection is
// still live when the panel opens and getLastSelectedText is called.
PluginManager.registerButton(BUTTON_TYPE_TEXT_SELECTION, ['DOC'], {
  id: CAPTURE_BUTTON_ID,
  name: 'Capture Quote',
  icon: Image.resolveAssetSource(require('./assets/icon.png')).uri,
  showType: SHOW_TYPE_WITH_UI,
});

// The panel component may stay mounted between opens, so lifecycle events
// alone can leave a stale view. The toolbar button press is a reliable
// "panel is opening" signal; the screen re-derives its context on it.
PluginManager.registerButtonListener({
  onButtonPress(event) {
    if (event.id === TOOLBAR_BUTTON_ID) {
      DeviceEventEmitter.emit(SHELF_OPENED_EVENT);
    } else if (event.id === CAPTURE_BUTTON_ID) {
      setPendingCapture();
      DeviceEventEmitter.emit(SHELF_CAPTURE_EVENT);
    }
  },
});

// PluginHost never deletes old plugin versions on install/update, so the
// install dir grows without bound (hundreds of MB after repeated builds).
// Clean up superseded app_<timestamp> artifacts once at load.
(async () => {
  try {
    const dir = await PluginManager.getPluginDirPath();
    const result = await NativeModules.ShelfStorage?.cleanupOldVersions(dir);
    if (result && result.freedBytes > 0) {
      console.log(
        `SNShelf cleanup: freed ${(result.freedBytes / 1048576).toFixed(1)} MB, kept app_${result.kept}`,
      );
    }
  } catch (error) {
    console.warn('SNShelf version cleanup failed', error);
  }
})();
