// tests/rampCompiler.test.js — Unit tests for color ramp compiler
import { compileRampData, parseColor, RAMP_WIDTH } from '../src/styles/RampCompiler.js';

describe('parseColor', () => {
  test('parses 6-char hex', () => {
    const c = parseColor('#ff0000');
    expect(c[0]).toBeCloseTo(1.0);
    expect(c[1]).toBeCloseTo(0.0);
    expect(c[2]).toBeCloseTo(0.0);
    expect(c[3]).toBeCloseTo(1.0);
  });

  test('parses 6-char hex without #', () => {
    const c = parseColor('00ff00');
    expect(c[0]).toBeCloseTo(0.0);
    expect(c[1]).toBeCloseTo(1.0);
    expect(c[2]).toBeCloseTo(0.0);
  });

  test('parses 8-char hex with alpha', () => {
    const c = parseColor('#ff000080');
    expect(c[0]).toBeCloseTo(1.0);
    expect(c[3]).toBeCloseTo(0.502, 1);
  });

  test('parses 3-char shorthand', () => {
    const c = parseColor('#f00');
    expect(c[0]).toBeCloseTo(1.0);
    expect(c[1]).toBeCloseTo(0.0);
    expect(c[2]).toBeCloseTo(0.0);
    expect(c[3]).toBeCloseTo(1.0);
  });

  test('returns magenta for invalid input', () => {
    const c = parseColor('zz'); // 2-char — not 3, 6, or 8 → fallback
    expect(c[0]).toBe(1);
    expect(c[1]).toBe(0);
    expect(c[2]).toBe(1);
  });

  test('white is [1,1,1,1]', () => {
    const c = parseColor('#ffffff');
    expect(c).toEqual([1, 1, 1, 1]);
  });

  test('black is [0,0,0,1]', () => {
    const c = parseColor('#000000');
    expect(c).toEqual([0, 0, 0, 1]);
  });
});

describe('compileRampData', () => {
  test('produces 256×4 byte array', () => {
    const stops = [
      { value: 0, color: '#000000' },
      { value: 100, color: '#ffffff' },
    ];
    const data = compileRampData(stops, [0, 100]);
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBe(RAMP_WIDTH * 4);
  });

  test('first texel matches first stop color', () => {
    const data = compileRampData(
      [
        { value: 0, color: '#ff0000' },
        { value: 100, color: '#0000ff' },
      ],
      [0, 100]
    );
    // First pixel: red
    expect(data[0]).toBe(255); // R
    expect(data[1]).toBe(0); // G
    expect(data[2]).toBe(0); // B
  });

  test('last texel matches last stop color', () => {
    const data = compileRampData(
      [
        { value: 0, color: '#ff0000' },
        { value: 100, color: '#0000ff' },
      ],
      [0, 100]
    );
    const lastIdx = (RAMP_WIDTH - 1) * 4;
    expect(data[lastIdx]).toBe(0); // R
    expect(data[lastIdx + 1]).toBe(0); // G
    expect(data[lastIdx + 2]).toBe(255); // B
  });

  test('midpoint interpolates correctly', () => {
    const data = compileRampData(
      [
        { value: 0, color: '#000000' },
        { value: 100, color: '#ffffff' },
      ],
      [0, 100]
    );
    // Midpoint pixel (index 127 or 128 of 256)
    const midIdx = 128 * 4;
    // Should be roughly 128/255 ≈ 0.50 → ~128
    expect(data[midIdx]).toBeGreaterThan(100);
    expect(data[midIdx]).toBeLessThan(160);
  });

  test('multi-stop ramp', () => {
    const data = compileRampData(
      [
        { value: 0, color: '#ff0000' },
        { value: 50, color: '#00ff00' },
        { value: 100, color: '#0000ff' },
      ],
      [0, 100]
    );
    // First = red, middle ≈ green, last = blue
    expect(data[0]).toBe(255); // R at start
    const lastIdx = (RAMP_WIDTH - 1) * 4;
    expect(data[lastIdx + 2]).toBe(255); // B at end
  });

  test('graduated opacity (opacityStops) overrides color alpha', () => {
    const data = compileRampData(
      [
        { value: 0, color: '#ff0000' },
        { value: 100, color: '#ff0000' },
      ],
      [0, 100],
      [
        { value: 0, opacity: 0.0 },
        { value: 100, opacity: 1.0 },
      ]
    );
    // First texel alpha should be ~0
    expect(data[3]).toBeLessThan(10);
    // Last texel alpha should be ~255
    const lastAlpha = data[(RAMP_WIDTH - 1) * 4 + 3];
    expect(lastAlpha).toBeGreaterThan(245);
  });

  test('without opacityStops, alpha comes from color hex', () => {
    const data = compileRampData(
      [
        { value: 0, color: '#ff000080' },
        { value: 100, color: '#0000ff80' },
      ],
      [0, 100]
    );
    // Alpha should be ~128 (0x80) throughout
    expect(data[3]).toBeGreaterThan(100);
    expect(data[3]).toBeLessThan(160);
  });

  test('unsorted stops are handled correctly', () => {
    // Stops given out of order should still produce correct ramp
    const data = compileRampData(
      [
        { value: 100, color: '#0000ff' },
        { value: 0, color: '#ff0000' },
      ],
      [0, 100]
    );
    expect(data[0]).toBe(255); // R at start
    const lastIdx = (RAMP_WIDTH - 1) * 4;
    expect(data[lastIdx + 2]).toBe(255); // B at end
  });
});
