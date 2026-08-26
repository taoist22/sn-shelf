export type PluginLifecycleAction = 'refresh' | 'reset' | 'none';

export function pluginLifecycleState(message: unknown): number | null {
  if (typeof message === 'number') {
    return message;
  }
  if (
    message &&
    typeof message === 'object' &&
    typeof (message as {state?: unknown}).state === 'number'
  ) {
    return (message as {state: number}).state;
  }
  return null;
}

export function pluginLifecycleAction(
  message: unknown,
): PluginLifecycleAction {
  const state = pluginLifecycleState(message);
  if (state === 2) {
    return 'refresh';
  }
  if (state === 3 || state === 4 || state === 5) {
    return 'reset';
  }
  return 'none';
}
