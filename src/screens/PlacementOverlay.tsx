import React, {useEffect, useRef} from 'react';
import {
  BackHandler,
  DeviceEventEmitter,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SHELF_OPENED_EVENT} from '../app/events';

// Tap-to-place, ported from sn-datetime (PlacementOverlay.tsx, proven on
// device in v1.5.0-beta). A transparent full-panel responder owns the whole
// gesture so the note underneath never inks; one short tap resolves with the
// point in page pixels.

export type TapPoint = {x: number; y: number};

// Backing out is an outcome, not an error: resolving a tagged result keeps
// Cancel/Back/timeout out of the caller's failure path.
export type PlacementResult = {kind: 'placed'; point: TapPoint} | {kind: 'cancelled'};

export type PlacementRequest = {
  label: string;
  resolve: (result: PlacementResult) => void;
};

const TIMEOUT_MS = 30000;
const MAX_TAP_MS = 700;
const MAX_TAP_MOVE_PX = 20;

export function PlacementOverlay({request}: {request: PlacementRequest}): React.JSX.Element {
  const surface = useRef<View>(null);
  const origin = useRef({x: 0, y: 0});
  const down = useRef<{x: number; y: number; time: number} | null>(null);
  const settled = useRef(false);

  const cancel = () => {
    if (settled.current) {
      return;
    }
    settled.current = true;
    request.resolve({kind: 'cancelled'});
  };

  useEffect(() => {
    // Walking away, pressing Back, or tapping the Shelf toolbar button again
    // all count as Cancel.
    const timer = setTimeout(cancel, TIMEOUT_MS);
    const reopened = DeviceEventEmitter.addListener(SHELF_OPENED_EVENT, cancel);
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      cancel();
      return true;
    });
    return () => {
      clearTimeout(timer);
      reopened.remove();
      back.remove();
      cancel();
    };
    // Each overlay is mounted for exactly one request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  return (
    <View style={styles.root}>
      <View
        ref={surface}
        collapsable={false}
        style={StyleSheet.absoluteFill}
        onLayout={() =>
          surface.current?.measureInWindow((x, y) => {
            origin.current = {x, y};
          })
        }
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={({nativeEvent: event}) => {
          down.current =
            event.touches.length === 1
              ? {x: event.locationX, y: event.locationY, time: event.timestamp}
              : null;
        }}
        onResponderMove={({nativeEvent: event}) => {
          if (
            event.touches.length !== 1 ||
            (down.current &&
              Math.hypot(event.locationX - down.current.x, event.locationY - down.current.y) >
                MAX_TAP_MOVE_PX)
          ) {
            down.current = null;
          }
        }}
        onResponderTerminate={() => {
          down.current = null;
        }}
        onResponderRelease={({nativeEvent: event}) => {
          const start = down.current;
          down.current = null;
          if (
            settled.current ||
            !start ||
            event.timestamp - start.time > MAX_TAP_MS ||
            Math.hypot(event.locationX - start.x, event.locationY - start.y) > MAX_TAP_MOVE_PX
          ) {
            return;
          }
          // RN touch coordinates are dp; note pages use physical pixels.
          const scale = PixelRatio.get();
          const point = {
            x: (origin.current.x + event.locationX) * scale,
            y: (origin.current.y + event.locationY) * scale,
          };
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            return;
          }
          settled.current = true;
          request.resolve({kind: 'placed', point});
        }}
      />
      <View style={styles.hint}>
        <Text style={styles.text}>{`Tap the line where ${request.label} should start · 30 s`}</Text>
        <Pressable onPress={cancel} style={styles.cancel}>
          <Text style={styles.text}>{'Cancel'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: 'transparent'},
  hint: {
    position: 'absolute',
    top: 10,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    borderWidth: 1,
    paddingLeft: 12,
  },
  text: {color: 'black', fontSize: 16},
  cancel: {padding: 16, marginLeft: 12, borderLeftWidth: 1},
});
