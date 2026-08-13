/**
 * LoadingScreen.js — Brandable fullscreen loading overlay.
 *
 * Self-injecting UI widget that shows a logo, title, subtitle, spinner,
 * status text, and progress bar. Auto-hides when loading completes.
 *
 * CSS custom properties for skinning:
 *   --gt-loading-bg            Background (default: radial gradient)
 *   --gt-loading-accent        Spinner / progress color (default: --gt-accent-cyan)
 *   --gt-loading-logo-height   Logo height (default: 36px)
 */

import { injectStyles } from './styles.js';

export class LoadingScreen {
  /**
   * @param {HTMLElement} container - Parent element (typically document.body)
   * @param {Object} [options]
   * @param {string} [options.logoUrl] - URL to brand logo image
   * @param {string} [options.iconUrl] - URL to brand icon (shown beside logo)
   * @param {string} [options.title] - Title text
   * @param {string} [options.subtitle] - Subtitle text
   * @param {string} [options.backgroundColor] - Override background color
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this._hidden = false;
    this._timers = []; // track setTimeout IDs for cleanup

    // Ensure all gt-loading-* CSS classes are available
    injectStyles();

    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'gt-loading-overlay';

    if (this.options.backgroundColor) {
      el.style.background = this.options.backgroundColor;
    }

    // ─── Center section (logo + title) ───
    let centerHTML = '';
    const hasLogo = this.options.logoUrl || this.options.iconUrl;

    if (hasLogo) {
      centerHTML += '<div class="gt-loading-brand-row">';
      if (this.options.logoUrl) {
        centerHTML += `<img class="gt-loading-logo" src="${this.options.logoUrl}" alt="" />`;
      }
      if (this.options.iconUrl) {
        centerHTML += `<img class="gt-loading-icon" src="${this.options.iconUrl}" alt="" />`;
      }
      centerHTML += '</div>';
    }

    if (this.options.title) {
      centerHTML += `<p class="gt-loading-title">${this.options.title}</p>`;
    }
    if (this.options.subtitle) {
      centerHTML += `<p class="gt-loading-subtitle">${this.options.subtitle}</p>`;
    }

    el.innerHTML = `
            <div class="gt-loading-center">
                ${centerHTML}
            </div>
            <div class="gt-loading-loader">
                <div class="gt-loading-spinner"></div>
                <p class="gt-loading-status">Initializing engine...</p>
                <div class="gt-loading-bar">
                    <div class="gt-loading-fill"></div>
                </div>
            </div>
        `;

    this._el = el;
    this._statusEl = el.querySelector('.gt-loading-status');
    this._fillEl = el.querySelector('.gt-loading-fill');

    this.container.appendChild(el);
  }

  /**
   * Update progress message and bar.
   * @param {string} message - Status text
   * @param {number} percent - 0–100
   */
  update(message, percent) {
    if (this._hidden) return;
    if (this._statusEl) this._statusEl.textContent = message;
    if (this._fillEl) this._fillEl.style.width = percent + '%';
  }

  /**
   * Show an error message (red text).
   * @param {string} message
   */
  showError(message) {
    if (this._statusEl) {
      this._statusEl.textContent = message;
      this._statusEl.style.color = '#ff4444';
    }
  }

  /**
   * Hide with a fade-out transition, then remove from DOM.
   * @param {number} [delay=400] - Delay before starting fade (ms)
   */
  hide(delay = 400) {
    if (this._hidden) return;
    this._hidden = true;

    const t1 = setTimeout(() => {
      if (!this._el) return; // already destroyed
      this._el.classList.add('gt-loading-hidden');
      // Remove from DOM after CSS transition completes
      const t2 = setTimeout(() => {
        if (!this._el) return;
        this._el.remove();
        this._el = null;
        this._statusEl = null;
        this._fillEl = null;
      }, 1100);
      this._timers.push(t2);
    }, delay);
    this._timers.push(t1);
  }

  /** Destroy and remove immediately — clears all pending timers. */
  destroy() {
    this._hidden = true;
    // Clear any pending hide/fade timers to prevent leaked closures
    for (const id of this._timers) clearTimeout(id);
    this._timers.length = 0;
    this._el?.remove();
    this._el = null;
    this._statusEl = null;
    this._fillEl = null;
    this.container = null;
    this.options = null;
  }
}
