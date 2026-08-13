// tests/categoricalCompiler.test.js — Unit tests for categorical color LUT compiler
import { compileCategoricalData } from '../src/styles/CategoricalCompiler.js';

describe('compileCategoricalData', () => {
  test('produces correct LUT dimensions', () => {
    const categories = { A: '#ff0000', B: '#00ff00' };
    const dictionary = ['A', 'B', 'C'];
    const { data, width } = compileCategoricalData(categories, dictionary);

    expect(data).toBeInstanceOf(Uint8Array);
    expect(width).toBe(3);
    expect(data.length).toBe(3 * 4); // 3 entries × RGBA
  });

  test('maps category colors by dictionary index', () => {
    const categories = { A: '#ff0000', B: '#00ff00' };
    const dictionary = ['A', 'B'];
    const { data } = compileCategoricalData(categories, dictionary);

    // Index 0 = A = red
    expect(data[0]).toBe(255); // R
    expect(data[1]).toBe(0); // G
    expect(data[2]).toBe(0); // B
    expect(data[3]).toBe(255); // A

    // Index 1 = B = green
    expect(data[4]).toBe(0);
    expect(data[5]).toBe(255);
    expect(data[6]).toBe(0);
  });

  test('unmapped categories get default color', () => {
    const categories = { A: '#ff0000' };
    const dictionary = ['A', 'B'];
    const { data } = compileCategoricalData(categories, dictionary, '#999999');

    // Index 1 = B = unmapped → default #999999
    expect(data[4]).toBe(153); // 0x99
    expect(data[5]).toBe(153);
    expect(data[6]).toBe(153);
  });

  test('supports object entries with opacity', () => {
    const categories = {
      A: { color: '#ff0000', opacity: 0.5 },
    };
    const dictionary = ['A'];
    const { data } = compileCategoricalData(categories, dictionary);

    expect(data[0]).toBe(255); // R
    expect(data[3]).toBe(128); // A = 0.5 * 255 ≈ 128
  });

  test('empty dictionary produces width 1', () => {
    const { data, width } = compileCategoricalData({}, []);
    expect(width).toBe(1);
    expect(data.length).toBe(4);
  });

  test('custom default color is applied', () => {
    const { data } = compileCategoricalData({}, ['X'], '#00ff00');
    expect(data[0]).toBe(0);
    expect(data[1]).toBe(255);
    expect(data[2]).toBe(0);
  });

  test('large dictionary produces correct width', () => {
    const dictionary = Array.from({ length: 100 }, (_, i) => `cat_${i}`);
    const categories = { cat_0: '#ff0000' };
    const { data, width } = compileCategoricalData(categories, dictionary);

    expect(width).toBe(100);
    expect(data.length).toBe(100 * 4);
    expect(data[0]).toBe(255); // cat_0 = red
  });
});
