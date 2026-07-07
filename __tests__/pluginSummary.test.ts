import {describe, expect, it} from '@jest/globals';
import {getPluginSummary} from '../src/domain/pluginSummary';

describe('getPluginSummary', () => {
  it('returns the plugin description', () => {
    expect(getPluginSummary()).toBe(
      'Keep a temporary shelf of active notes and document pages, with a quick return target for jumping back to your working file.',
    );
  });
});
