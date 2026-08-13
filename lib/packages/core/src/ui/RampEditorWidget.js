/**
 * RampEditorWidget.js
 * A reusable UI component for managing continuous color ramps (stops & domains).
 * Displays an interactive gradient track, draggable stop handles, and a table of explicit stops.
 */

export function lerpHex(hex1, hex2, t) {
  const r1 = parseInt(hex1.slice(1, 3), 16),
    g1 = parseInt(hex1.slice(3, 5), 16),
    b1 = parseInt(hex1.slice(5, 7), 16);
  const r2 = parseInt(hex2.slice(1, 3), 16),
    g2 = parseInt(hex2.slice(3, 5), 16),
    b2 = parseInt(hex2.slice(5, 7), 16);
  const r = Math.round(r1 + (r2 - r1) * t),
    g = Math.round(g1 + (g2 - g1) * t),
    b = Math.round(b1 + (b2 - b1) * t);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export class RampEditorWidget {
  /**
   * @param {HTMLElement} container - The DOM element to mount the editor within.
   * @param {Object} options
   * @param {Array<{value: number, color: string, opacity?: number}>} options.stops
   * @param {number[]} options.domain - [min, max]
   * @param {Function} options.onChange - Callback fired with (stops, domain) on any edit
   */
  constructor(container, options) {
    this.container = container;
    this.stops = (options.stops || []).map((s) => ({ ...s }));
    this.domain = [...(options.domain || [0, 100])];
    this.originalStops = this.stops.map((s) => ({ ...s }));
    this.originalDomain = [...this.domain];
    this.onChange = options.onChange || (() => {});

    this._build();
  }

  _build() {
    this.container.innerHTML = '';

    // ── Gradient track ──
    const track = document.createElement('div');
    track.className = 'gt-lm-ramp-track';
    this.container.appendChild(track);

    // ── Stop handles container ──
    const handlesContainer = document.createElement('div');
    handlesContainer.className = 'gt-lm-ramp-handles';
    this.container.appendChild(handlesContainer);

    // ── Editable stops table ──
    const stopsTable = document.createElement('div');
    stopsTable.style.cssText = 'margin-top:6px;max-height:120px;overflow-y:auto;';
    this.container.appendChild(stopsTable);

    // ── Domain inputs ──
    const domainRow = document.createElement('div');
    domainRow.className = 'gt-lm-domain-row';

    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.className = 'gt-lm-domain-input';
    minInput.value = this.domain[0];
    minInput.title = 'Domain minimum';

    const spacer = document.createElement('div');
    spacer.className = 'gt-lm-domain-spacer';

    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.className = 'gt-lm-domain-input';
    maxInput.value = this.domain[1];
    maxInput.title = 'Domain maximum';

    domainRow.appendChild(minInput);
    domainRow.appendChild(spacer);
    domainRow.appendChild(maxInput);
    this.container.appendChild(domainRow);

    // ── Actions row ──
    const actionsRow = document.createElement('div');
    actionsRow.className = 'gt-lm-ramp-actions';

    const addBtn = document.createElement('button');
    addBtn.className = 'gt-lm-ramp-action-btn';
    addBtn.textContent = '+ Stop';
    addBtn.title = 'Add a new color stop at the midpoint';

    const resetBtn = document.createElement('button');
    resetBtn.className = 'gt-lm-ramp-action-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.title = 'Reset to original stops';

    actionsRow.appendChild(addBtn);
    actionsRow.appendChild(resetBtn);
    this.container.appendChild(actionsRow);

    const fmtVal = (v) =>
      Math.abs(v) >= 1000
        ? `${(v / 1000).toFixed(1)}k`
        : Number.isInteger(v)
          ? String(v)
          : v.toFixed(1);

    // ── Visual update function ──
    const updateVisuals = () => {
      const sorted = [...this.stops].sort((a, b) => a.value - b.value);
      const range = this.domain[1] - this.domain[0] || 1;

      // Gradient
      const gradStops = sorted
        .map((s) => {
          const pct = (((s.value - this.domain[0]) / range) * 100).toFixed(1);
          return `${s.color} ${pct}%`;
        })
        .join(', ');
      track.style.background = `linear-gradient(to right, ${gradStops})`;

      // Handles
      handlesContainer.innerHTML = '';
      sorted.forEach((s, i) => {
        const handle = document.createElement('div');
        handle.className = 'gt-lm-ramp-handle';
        handle.style.left = `calc(${(((s.value - this.domain[0]) / range) * 100).toFixed(1)}% - 7px)`;
        handle.style.background = s.color;
        handle.title = `${fmtVal(s.value)}: ${s.color} (α ${(s.opacity ?? 1).toFixed(2)})`;

        // Color picker on click
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.value = s.color;
        picker.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none';
        handle.appendChild(picker);

        handle.addEventListener('click', (ev) => {
          ev.stopPropagation();
          picker.click();
        });
        picker.addEventListener('input', (ev) => {
          s.color = ev.target.value;
          updateVisuals();
          emitChange();
        });

        // Drag to reposition
        handle.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const trackRect = track.getBoundingClientRect();
          const onMove = (moveEv) => {
            const pct = Math.max(
              0,
              Math.min(1, (moveEv.clientX - trackRect.left) / trackRect.width)
            );
            s.value = this.domain[0] + pct * range;
            updateVisuals();
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            emitChange();
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });

        // Remove on right-click (if > 2 stops)
        handle.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (this.stops.length > 2) {
            const idx = this.stops.indexOf(s);
            if (idx >= 0) this.stops.splice(idx, 1);
            updateVisuals();
            emitChange();
          }
        });

        handlesContainer.appendChild(handle);
      });

      // ── Editable stop rows ──
      stopsTable.innerHTML = '';
      const hdr = document.createElement('div');
      hdr.style.cssText =
        'display:flex;gap:4px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:2px;';
      hdr.innerHTML = `
                <span style="flex:0 0 24px;font-size:8px;color:rgba(255,255,255,0.35)">Color</span>
                <span style="flex:1;font-size:8px;color:rgba(255,255,255,0.35)">Value</span>
                <span style="flex:0 0 50px;font-size:8px;color:rgba(255,255,255,0.35)">Opacity</span>
                <span style="flex:0 0 16px"></span>
            `;
      stopsTable.appendChild(hdr);

      sorted.forEach((s) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:1px 0;';

        const colorIn = document.createElement('input');
        colorIn.type = 'color';
        colorIn.value = s.color;
        colorIn.style.cssText =
          'flex:0 0 24px;width:24px;height:16px;border:1px solid rgba(255,255,255,0.2);border-radius:2px;background:transparent;cursor:pointer;padding:0;';
        colorIn.addEventListener('input', (ev) => {
          s.color = ev.target.value;
          updateVisuals();
          emitChange();
        });

        const valIn = document.createElement('input');
        valIn.type = 'number';
        valIn.value = parseFloat(s.value.toFixed(2));
        valIn.step = 'any';
        valIn.style.cssText =
          'flex:1;min-width:0;height:18px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:2px;color:#fff;font-size:9px;padding:0 4px;';
        // Trigger compilation externally only when user hits Enter or drops focus to prevent mid-parse crashes
        valIn.addEventListener('change', () => {
          const v = parseFloat(valIn.value);
          if (!isNaN(v)) {
            s.value = v;
            updateVisuals();
            emitChange();
          }
        });

        const opIn = document.createElement('input');
        opIn.type = 'number';
        opIn.min = '0';
        opIn.max = '1';
        opIn.step = '0.05';
        opIn.value = (s.opacity ?? 1).toFixed(2);
        opIn.style.cssText =
          'flex:0 0 50px;height:18px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:2px;color:#fff;font-size:9px;padding:0 4px;';
        opIn.addEventListener('change', () => {
          const o = parseFloat(opIn.value);
          if (!isNaN(o)) {
            s.opacity = Math.max(0, Math.min(1, o));
            updateVisuals();
            emitChange();
          }
        });

        const rmBtn = document.createElement('button');
        rmBtn.textContent = '×';
        rmBtn.title = 'Remove stop';
        rmBtn.style.cssText =
          'flex:0 0 16px;width:16px;height:16px;background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:12px;padding:0;line-height:16px;';
        rmBtn.addEventListener('click', () => {
          if (this.stops.length > 2) {
            const idx = this.stops.indexOf(s);
            if (idx >= 0) this.stops.splice(idx, 1);
            updateVisuals();
            emitChange();
          }
        });

        row.appendChild(colorIn);
        row.appendChild(valIn);
        row.appendChild(opIn);
        row.appendChild(rmBtn);
        stopsTable.appendChild(row);
      });
    };

    // ── Click track to add stop ──
    track.addEventListener('click', (ev) => {
      const rect = track.getBoundingClientRect();
      const pct = (ev.clientX - rect.left) / rect.width;
      const newVal = this.domain[0] + pct * (this.domain[1] - this.domain[0]);
      const sorted = [...this.stops].sort((a, b) => a.value - b.value);
      let newColor = sorted[0]?.color || '#ffffff';
      let newOpacity = 1.0;
      for (let s = 0; s < sorted.length - 1; s++) {
        if (newVal >= sorted[s].value && newVal <= sorted[s + 1].value) {
          const t = (newVal - sorted[s].value) / (sorted[s + 1].value - sorted[s].value);
          newColor = lerpHex(sorted[s].color, sorted[s + 1].color, t);
          newOpacity =
            (sorted[s].opacity ?? 1.0) +
            ((sorted[s + 1].opacity ?? 1.0) - (sorted[s].opacity ?? 1.0)) * t;
          break;
        }
      }
      this.stops.push({ value: newVal, color: newColor, opacity: newOpacity });
      updateVisuals();
      emitChange();
    });

    // ── Event Emitter ──
    const emitChange = () => {
      const sorted = [...this.stops].sort((a, b) => a.value - b.value);
      this.onChange(sorted, this.domain);
    };

    // ── Domain change ──
    const onDomainChange = () => {
      const newMin = parseFloat(minInput.value);
      const newMax = parseFloat(maxInput.value);
      if (isNaN(newMin) || isNaN(newMax) || newMin >= newMax) return;
      const oldRange = this.domain[1] - this.domain[0];
      const newRange = newMax - newMin;
      if (oldRange > 0) {
        for (const s of this.stops) {
          const t = (s.value - this.domain[0]) / oldRange;
          s.value = newMin + t * newRange;
        }
      } else {
        const sorted = [...this.stops].sort((a, b) => a.value - b.value);
        sorted.forEach((s, i) => {
          const t = sorted.length > 1 ? i / (sorted.length - 1) : 0.5;
          s.value = newMin + t * newRange;
        });
      }
      this.domain[0] = newMin;
      this.domain[1] = newMax;
      updateVisuals();
      emitChange();
    };
    minInput.addEventListener('change', onDomainChange);
    maxInput.addEventListener('change', onDomainChange);

    // ── Add stop ──
    addBtn.addEventListener('click', () => {
      const midVal = (this.domain[0] + this.domain[1]) / 2;
      this.stops.push({ value: midVal, color: '#ffffff', opacity: 0.7 });
      updateVisuals();
      emitChange();
    });

    // ── Reset ──
    resetBtn.addEventListener('click', () => {
      this.stops.length = 0;
      this.originalStops.forEach((s) => this.stops.push({ ...s }));
      this.domain[0] = this.originalDomain[0];
      this.domain[1] = this.originalDomain[1];
      minInput.value = this.domain[0];
      maxInput.value = this.domain[1];
      updateVisuals();
      emitChange();
    });

    // Initial render
    updateVisuals();
  }
}
