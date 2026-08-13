/**
 * FeaturePopup.test.mjs — pure popup HTML builder (DOM-free).
 * Run: node --test lib/packages/core/src/ui/FeaturePopup.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildPopupHTML } from './FeaturePopup.js';

describe('buildPopupHTML — legacy properties shape', () => {
  it('uses layerName as title and renders key/value rows', () => {
    const html = buildPopupHTML({ layerName: 'Roads', properties: { name: 'I-5', lanes: 4 } });
    assert.match(html, /gt-popup-title">Roads</);
    assert.match(html, /gt-popup-key">name<.*gt-popup-val">I-5</s);
    assert.match(html, /gt-popup-key">lanes<.*gt-popup-val">4</s);
  });

  it('filters out null and undefined properties', () => {
    const html = buildPopupHTML({ layerName: 'L', properties: { a: 1, b: null, c: undefined } });
    assert.match(html, /gt-popup-key">a</);
    assert.doesNotMatch(html, /gt-popup-key">b</);
    assert.doesNotMatch(html, /gt-popup-key">c</);
  });

  it('caps rendered properties at 20', () => {
    const props = {};
    for (let i = 0; i < 30; i++) props[`k${i}`] = i;
    const html = buildPopupHTML({ layerName: 'L', properties: props });
    const count = (html.match(/gt-popup-kv/g) || []).length;
    assert.equal(count, 20);
  });

  it('renders empty-state when no properties', () => {
    const html = buildPopupHTML({ layerName: 'L', properties: {} });
    assert.match(html, /gt-popup-empty/);
  });

  it('stringifies object property values as JSON', () => {
    const html = buildPopupHTML({ layerName: 'L', properties: { meta: { x: 1 } } });
    assert.match(html, /gt-popup-val">\{&quot;x&quot;:1\}</);
  });
});

describe('buildPopupHTML — structured rows shape', () => {
  it('prefers explicit title over layerName', () => {
    const html = buildPopupHTML({
      layerName: 'Sats',
      title: 'Satellite',
      rows: [{ label: 'ID', value: '12345' }],
    });
    assert.match(html, /gt-popup-title">Satellite</);
    assert.match(html, /gt-popup-key">ID<.*gt-popup-val">12345</s);
  });

  it('falls back to layerName when no title', () => {
    const html = buildPopupHTML({ layerName: 'Sats', rows: [{ label: 'ID', value: '1' }] });
    assert.match(html, /gt-popup-title">Sats</);
  });

  it('renders empty-state for empty rows', () => {
    const html = buildPopupHTML({ layerName: 'Sats', title: 'Satellite', rows: [] });
    assert.match(html, /gt-popup-empty/);
  });
});

describe('buildPopupHTML — grouped sections', () => {
  it('renders section dividers with rows under each', () => {
    const html = buildPopupHTML({
      layerName: 'Sat',
      title: 'Satellite',
      sections: [
        { label: 'Forward Link', rows: [{ label: 'Cap', value: '80 Mbps' }] },
        { label: 'Return Link', rows: [{ label: 'Cap', value: '20 Mbps' }] },
      ],
    });
    assert.match(html, /gt-popup-divider">Forward Link</);
    assert.match(html, /gt-popup-divider">Return Link</);
    assert.match(html, /gt-popup-val">80 Mbps</);
    assert.match(html, /gt-popup-val">20 Mbps</);
  });

  it('renders empty-state when all sections are empty', () => {
    const html = buildPopupHTML({ layerName: 'Sat', sections: [] });
    assert.match(html, /gt-popup-empty/);
  });

  it('escapes section labels', () => {
    const html = buildPopupHTML({
      layerName: 'L',
      sections: [{ label: '<x>', rows: [{ label: 'a', value: 'b' }] }],
    });
    assert.match(html, /gt-popup-divider">&lt;x&gt;</);
  });
});

describe('buildPopupHTML — grid layout', () => {
  it('adds the grid class and renders key/val as direct cells (no kv wrapper)', () => {
    const html = buildPopupHTML({
      layerName: 'L',
      layout: 'grid',
      rows: [{ label: 'ID', value: '1' }],
    });
    assert.match(html, /gt-popup-body gt-popup-grid/);
    assert.match(html, /gt-popup-key">ID<\/span><span class="gt-popup-val">1</);
    assert.doesNotMatch(html, /gt-popup-kv/);
  });

  it('list layout (default) keeps the kv wrapper', () => {
    const html = buildPopupHTML({ layerName: 'L', rows: [{ label: 'ID', value: '1' }] });
    assert.match(html, /gt-popup-kv/);
    assert.doesNotMatch(html, /gt-popup-grid/);
  });
});

describe('buildPopupHTML — escaping', () => {
  it('escapes HTML in title, keys, and values', () => {
    const html = buildPopupHTML({ layerName: '<b>&"', properties: { '<k>': '<script>' } });
    assert.match(html, /gt-popup-title">&lt;b&gt;&amp;&quot;</);
    assert.match(html, /&lt;k&gt;/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });
});
