// tests/symbologyDialog.test.js — Unit tests for GFB symbology dialog state helpers
import {
  resolveSymbologyMode,
  mergeCategoryEntries,
} from '../lib/packages/core/src/ui/SymbologyDialog.js';

describe('SymbologyDialog state helpers', () => {
  test('categorical compiled style opens in categorical mode even when categories are empty', () => {
    const mode = resolveSymbologyMode({
      style: {
        color: {
          type: 'categorical',
          attribute: 'realm',
          categories: {},
        },
      },
      _yamlStyle: {
        type: 'categorical',
        attribute: 'realm',
        categories: {},
      },
    });

    expect(mode).toBe('custom');
  });

  test('configured categories are included before observed dataset categories', () => {
    const merged = mergeCategoryEntries(
      [
        { index: 2, name: 'observed-only' },
        { index: 0, name: 'configured-a' },
      ],
      {
        'configured-a': '#111111',
        'configured-b': '#222222',
      }
    );

    expect(merged.map((c) => c.name)).toEqual(['configured-a', 'configured-b', 'observed-only']);
  });
});
