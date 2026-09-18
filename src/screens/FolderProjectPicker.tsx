import React from 'react';
import {FlatList, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {
  listShelfFolders,
  listShelfNotesAndFolders,
  listShelfStorageRoots,
  type ShelfFolderEntry,
} from '../supernote/folderBrowser';

type FolderProjectPickerProps = {
  visible: boolean;
  initialPath: string;
  /** 'folder' picks the folder being viewed; 'note' picks a .note file. */
  mode?: 'folder' | 'note';
  onCancel: () => void;
  onSelect: (path: string) => void | Promise<void>;
};

function cleanPath(path: string): string {
  const trimmed = path.trim();
  return trimmed === '/' ? trimmed : trimmed.replace(/\/+$/, '');
}

function parentPath(path: string): string | null {
  const clean = cleanPath(path);
  if (clean === '/' || clean === '/storage') {
    return null;
  }
  const slash = clean.lastIndexOf('/');
  return slash <= 0 ? '/' : clean.slice(0, slash);
}

export function FolderProjectPicker({
  visible,
  initialPath,
  mode = 'folder',
  onCancel,
  onSelect,
}: FolderProjectPickerProps): React.JSX.Element {
  const noteMode = mode === 'note';
  const [path, setPath] = React.useState(cleanPath(initialPath));
  const [roots, setRoots] = React.useState<string[]>(['/storage/emulated/0']);
  const [folders, setFolders] = React.useState<ShelfFolderEntry[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [selecting, setSelecting] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!visible) {
      return;
    }
    setPath(cleanPath(initialPath || '/storage/emulated/0'));
    setSelecting(false);
    setError('');
    listShelfStorageRoots().then(setRoots);
  }, [visible, initialPath]);

  React.useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    setBusy(true);
    setFolders([]);
    setError('');
    (noteMode ? listShelfNotesAndFolders(path) : listShelfFolders(path))
      .then(entries => {
        if (!cancelled) {
          setFolders(entries);
        }
      })
      .catch(cause => {
        if (!cancelled) {
          setFolders([]);
          setError(cause?.message || `Could not read ${path}.`);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });
    return () => { cancelled = true; };
  }, [visible, path, noteMode]);

  const select = (selected: string) => {
    setSelecting(true);
    Promise.resolve(onSelect(selected)).catch(cause => {
      setError(cause?.message || (noteMode ? 'Could not open the note.' : 'Could not create the folder project.'));
      setSelecting(false);
    });
  };

  const up = parentPath(path);
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>{noteMode ? 'Choose a Note' : 'Choose Folder Project'}</Text>
            <Pressable disabled={selecting} style={[styles.secondaryButton, selecting && styles.disabled]} onPress={onCancel}>
              <Text style={styles.secondaryText}>Cancel</Text>
            </Pressable>
          </View>
          <Text style={styles.help}>
            {noteMode
              ? 'Tap a note to open it, then reopen Shelf there to place the quote.'
              : 'Choose the folder itself. Empty folders are supported.'}
          </Text>
          <View style={styles.roots}>
            {roots.map((root, index) => (
              <Pressable key={root} disabled={selecting} style={styles.rootButton} onPress={() => setPath(root)}>
                <Text style={styles.rootText}>{index === 0 ? 'Internal' : `SD ${index}`}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.pathRow}>
            <Pressable disabled={!up || selecting} style={[styles.upButton, (!up || selecting) && styles.disabled]} onPress={() => up && setPath(up)}>
              <Text style={styles.secondaryText}>↑ Up</Text>
            </Pressable>
            <Text numberOfLines={2} style={styles.path}>{path}</Text>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {busy ? <Text style={styles.message}>{noteMode ? 'Reading notes…' : 'Reading folders…'}</Text> : null}
          {!busy && !error && folders.length === 0 ? (
            <Text style={styles.message}>
              {noteMode ? 'No notes or subfolders here.' : 'No subfolders. You can use this folder.'}
            </Text>
          ) : null}
          <FlatList
            style={styles.list}
            data={folders}
            keyExtractor={item => item.path}
            renderItem={({item}) => (
              noteMode && !item.isFolder ? (
                <Pressable disabled={selecting} style={styles.folderRow} onPress={() => select(item.path)}>
                  <Text numberOfLines={1} style={styles.folderName}>
                    📝 {item.name.replace(/\.note$/i, '')}
                  </Text>
                </Pressable>
              ) : (
                <Pressable disabled={selecting} style={styles.folderRow} onPress={() => setPath(item.path)}>
                  <Text numberOfLines={1} style={styles.folderName}>📁 {item.name}</Text>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
              )
            )}
          />
          {noteMode ? null : (
            <Pressable
              disabled={busy || selecting || Boolean(error)}
              style={[styles.useButton, (busy || selecting || Boolean(error)) && styles.disabledButton]}
              onPress={() => select(path)}>
              <Text style={styles.useText}>{selecting ? 'Saving…' : 'Use This Folder'}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', padding: 18, justifyContent: 'center'},
  panel: {height: '88%', backgroundColor: '#fff', borderWidth: 2, borderColor: '#000', borderRadius: 8, padding: 12},
  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  title: {flex: 1, color: '#000', fontSize: 18, fontWeight: '700'},
  help: {color: '#303030', fontSize: 13, marginVertical: 7},
  roots: {flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6},
  rootButton: {borderWidth: 1, borderColor: '#000', borderRadius: 5, paddingVertical: 7, paddingHorizontal: 12, marginRight: 6},
  rootText: {color: '#000', fontSize: 13, fontWeight: '700'},
  pathRow: {flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#707070', borderRadius: 5, padding: 6},
  path: {flex: 1, color: '#000', fontSize: 12, fontFamily: 'monospace'},
  upButton: {borderWidth: 1, borderColor: '#000', borderRadius: 4, paddingVertical: 7, paddingHorizontal: 10, marginRight: 8},
  secondaryButton: {borderWidth: 1, borderColor: '#000', borderRadius: 5, paddingVertical: 7, paddingHorizontal: 12},
  secondaryText: {color: '#000', fontSize: 13, fontWeight: '700'},
  disabled: {opacity: 0.35},
  list: {flex: 1, marginTop: 7, borderTopWidth: 1, borderTopColor: '#b0b0b0'},
  folderRow: {minHeight: 44, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#d0d0d0', paddingHorizontal: 8},
  folderName: {flex: 1, color: '#000', fontSize: 14},
  chevron: {color: '#000', fontSize: 22},
  message: {color: '#505050', fontSize: 13, paddingVertical: 9},
  error: {color: '#000', fontSize: 13, fontWeight: '700', paddingVertical: 9},
  useButton: {backgroundColor: '#000', borderRadius: 6, paddingVertical: 12, alignItems: 'center', marginTop: 8},
  disabledButton: {backgroundColor: '#707070'},
  useText: {color: '#fff', fontSize: 14, fontWeight: '700'},
});
