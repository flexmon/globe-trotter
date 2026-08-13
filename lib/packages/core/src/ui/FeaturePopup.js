/**
 * FeaturePopup — DOM overlay for GeoJSON feature hover/click popups.
 *
 * Two states:
 *   hover  — follows the mouse; dismissed on mouseout
 *   pinned — stays put; dismissed by Escape or clicking elsewhere
 *
 * Positioning uses style.transform: translate(x,y) so the browser can
 * composite it on the GPU without triggering layout.
 */

export class FeaturePopup {
  /**
   * @param {HTMLElement} container  Globe container element
   */
  constructor(container) {
    this._container = container;
    this._hover = this._createEl('gt-feature-popup gt-popup-hover');
    this._pinned = this._createEl('gt-feature-popup gt-popup-pinned');
    // Append to body so parent overflow:hidden on host-app panels cannot clip the popup.
    // position:fixed in the CSS means these are viewport-relative regardless of container.
    document.body.appendChild(this._hover);
    document.body.appendChild(this._pinned);
  }

  /**
   * Show / update hover popup.
   * @param {{ layerName: string, featureIndex: number, properties: object, sx: number, sy: number }} hit
   */
  showHover(hit, sx, sy) {
    this._render(this._hover, hit);
    this._position(this._hover, sx, sy);
    this._hover.classList.add('gt-popup-visible');
  }

  clearHover() {
    this._hover.classList.remove('gt-popup-visible');
  }

  /**
   * Pin a popup (click). Keeps it at position until cleared.
   */
  showPinned(hit, sx, sy) {
    this._pinnedHTML = buildPopupHTML(hit);
    this._pinned.innerHTML = this._pinnedHTML;
    this._position(this._pinned, sx, sy);
    this._pinned.classList.add('gt-popup-visible');
  }

  /**
   * Refresh the pinned popup's content in place (no reposition) — used to keep
   * a pinned popup's values current as time advances. No-op if not visible or
   * if the rendered content is unchanged (avoids per-frame DOM writes).
   */
  updatePinned(hit) {
    if (!this._pinned.classList.contains('gt-popup-visible')) return;
    const html = buildPopupHTML(hit);
    if (html !== this._pinnedHTML) {
      this._pinned.innerHTML = html;
      this._pinnedHTML = html;
    }
  }

  clearPinned() {
    this._pinned.classList.remove('gt-popup-visible');
    this._pinnedHTML = null;
  }

  destroy() {
    this._hover.remove();
    this._pinned.remove();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _createEl(className) {
    const el = document.createElement('div');
    el.className = className;
    return el;
  }

  _render(el, payload) {
    el.innerHTML = buildPopupHTML(payload);
  }

  _position(el, sx, sy) {
    // Convert canvas-relative (sx,sy) to viewport coordinates so position:fixed works correctly.
    const rect = this._container.getBoundingClientRect();
    const vx = rect.left + sx;
    const vy = rect.top + sy;

    let x = vx + 16;
    let y = vy + 16;

    // Prefer measured dimensions; fall back to approximations before first paint.
    const elW = el.offsetWidth || 220;
    const elH = el.offsetHeight || 160;

    if (x + elW > window.innerWidth) x = vx - elW - 8;
    if (y + elH > window.innerHeight) y = vy - elH - 8;

    el.style.transform = `translate(${x}px,${y}px)`;
  }
}

/**
 * Build the inner HTML for a popup. Pure (DOM-free) and HTML-escaped.
 *
 * Accepts, in priority order:
 *   grouped    — { layerName, title, sections:[{label, rows:[{label,value}]}], layout? }
 *   structured — { layerName, title, rows:[{label,value}], layout? }
 *   legacy     — { layerName, properties }   (renders up to 20 non-null kv pairs)
 *
 * `layout: 'grid'` aligns labels/values into two columns; default is a flex list.
 *
 * @param {object} payload
 * @returns {string}
 */
export function buildPopupHTML(payload = {}) {
  const { layerName, title, properties, rows, sections, layout } = payload;
  const heading = title ?? layerName ?? '';

  let secs;
  if (Array.isArray(sections)) {
    secs = sections;
  } else if (Array.isArray(rows)) {
    secs = [{ label: null, rows }];
  } else {
    const propRows = Object.entries(properties || {})
      .filter(([, v]) => v !== null && v !== undefined)
      .slice(0, 20)
      .map(([k, v]) => ({ label: k, value: typeof v === 'object' ? JSON.stringify(v) : v }));
    secs = [{ label: null, rows: propRows }];
  }

  const grid = layout === 'grid';
  const hasAny = secs.some((s) => s.rows && s.rows.length);
  const body = secs.map((s) => _section(s, grid)).join('');
  const bodyClass = 'gt-popup-body' + (grid ? ' gt-popup-grid' : '');

  return `
            <div class="gt-popup-title">${_esc(heading)}</div>
            <div class="${bodyClass}">${hasAny ? body : '<div class="gt-popup-empty">No properties</div>'}</div>
        `;
}

function _section(section, grid) {
  let html = '';
  if (section.label) html += `<div class="gt-popup-divider">${_esc(section.label)}</div>`;
  html += (section.rows || [])
    .map(({ label, value }) => (grid ? _cells(label, value) : _kv(label, value)))
    .join('');
  return html;
}

function _kv(key, value) {
  return `<div class="gt-popup-kv"><span class="gt-popup-key">${_esc(key)}</span><span class="gt-popup-val">${_esc(String(value))}</span></div>`;
}

// Grid layout: key/value emitted as bare cells so the CSS grid aligns columns.
function _cells(key, value) {
  return `<span class="gt-popup-key">${_esc(key)}</span><span class="gt-popup-val">${_esc(String(value))}</span>`;
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
