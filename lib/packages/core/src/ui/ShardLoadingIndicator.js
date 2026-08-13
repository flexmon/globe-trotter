/**
 * ShardLoadingIndicator.js — Lightweight overlay that shows shard loading progress
 * when the user scrubs the time slider into an unloaded time region.
 *
 * Shows a slim progress bar + spinner text above the time panel.
 * Auto-hides with a brief "✓ Data loaded" toast on completion.
 */

export class ShardLoadingIndicator {
  /**
   * @param {HTMLElement} container - Parent element (typically document.body)
   */
  constructor(container) {
    this._visible = false;
    this._toastTimer = null;
    this._createDOM(container);
  }

  _createDOM(container) {
    this.el = document.createElement('div');
    this.el.className = 'gt-shard-loading';
    this.el.innerHTML = `
            <div class="gt-shard-loading-bar">
                <div class="gt-shard-loading-fill"></div>
            </div>
            <div class="gt-shard-loading-text">
                <span class="gt-shard-loading-spinner"></span>
                <span class="gt-shard-loading-label">Loading data…</span>
            </div>
            <div class="gt-shard-loading-toast">✓ Data loaded</div>
        `;
    container.appendChild(this.el);

    this._fill = this.el.querySelector('.gt-shard-loading-fill');
    this._label = this.el.querySelector('.gt-shard-loading-label');
    this._toast = this.el.querySelector('.gt-shard-loading-toast');
  }

  /**
   * Show the loading indicator.
   */
  show() {
    if (this._visible) return;
    this._visible = true;
    this._toast.classList.remove('gt-shard-toast-show');
    clearTimeout(this._toastTimer);
    this.el.classList.add('gt-shard-loading-active');
  }

  /**
   * Update progress.
   * @param {number} ready - Layers with shards loaded
   * @param {number} total - Total sharded layers
   * @param {string[]} pendingNames - Names of layers still loading
   */
  updateProgress(ready, total, pendingNames) {
    if (total === 0) return;
    const pct = (ready / total) * 100;
    this._fill.style.width = `${pct}%`;
    if (pendingNames.length > 0) {
      this._label.textContent = `Loading data… (${ready}/${total} layers)`;
    }
  }

  /**
   * Hide the indicator with optional success toast.
   * @param {boolean} [showToast=true] - Whether to show the "✓ Data loaded" toast
   */
  hide(showToast = true) {
    if (!this._visible) return;
    this._visible = false;
    this.el.classList.remove('gt-shard-loading-active');
    this._fill.style.width = '0%';

    if (showToast) {
      this._toast.classList.add('gt-shard-toast-show');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        this._toast.classList.remove('gt-shard-toast-show');
      }, 1500);
    }
  }

  get visible() {
    return this._visible;
  }

  destroy() {
    clearTimeout(this._toastTimer);
    this.el?.remove();
  }
}
