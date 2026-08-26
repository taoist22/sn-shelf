import {describe, expect, it} from '@jest/globals';
import {
  pluginLifecycleAction,
  pluginLifecycleState,
} from '../src/supernote/pluginLifecycle';

describe('plugin lifecycle mapping', () => {
  it('accepts both host message shapes', () => {
    expect(pluginLifecycleState(2)).toBe(2);
    expect(pluginLifecycleState({state: 3})).toBe(3);
    expect(pluginLifecycleState({state: '2'})).toBeNull();
  });

  it('maps start and shutdown states', () => {
    expect(pluginLifecycleAction({state: 2})).toBe('refresh');
    expect(pluginLifecycleAction({state: 3})).toBe('reset');
    expect(pluginLifecycleAction({state: 4})).toBe('reset');
    expect(pluginLifecycleAction({state: 5})).toBe('reset');
    expect(pluginLifecycleAction({state: 1})).toBe('none');
  });
});
