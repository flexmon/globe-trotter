/**
 * ui/styles.js — Injects all Globe-Trotter UI widget CSS programmatically.
 * Idempotent: only injects once per page.
 */

const STYLE_ID = 'globe-trotter-ui-styles';

const CSS = `
/* ─── Globe-Trotter UI Widget Styles ─── */

:root {
  --gt-glass-bg: rgba(10, 15, 30, 0.65);
  --gt-glass-border: rgba(100, 160, 255, 0.15);
  --gt-glass-shadow: rgba(0, 0, 0, 0.4);
  --gt-accent-cyan: #00e5ff;
  --gt-accent-blue: #2979ff;
  --gt-text-primary: #e8eaf0;
  --gt-text-secondary: #8892a8;
  --gt-font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --gt-font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}

/* Glass Panel Base */
.gt-glass-panel {
  position: absolute;
  background: rgba(8, 12, 24, 0.88);
  border: 1px solid var(--gt-glass-border);
  border-radius: 14px;
  /* No backdrop-filter — blur() causes severe GPU contention with WebGL canvas */
  box-shadow: 0 8px 32px var(--gt-glass-shadow),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  padding: 16px 20px;
  z-index: 10;
  transition: opacity 0.3s ease;
}

.gt-mono {
  font-family: var(--gt-font-mono);
}

/* ─── Acetate Status Footer ─── */
.gt-acetate-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: rgba(30, 30, 30, 0.80);
  color: rgba(255, 255, 255, 0.75);
  font-family: var(--gt-font-mono);
  font-size: 11px;
  z-index: 20;
  pointer-events: none;
  user-select: none;
}

.gt-acetate-left,
.gt-acetate-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.gt-acetate-item {
  white-space: nowrap;
}

.gt-acetate-label {
  font-family: var(--gt-font-sans);
  font-weight: 500;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: rgba(255, 255, 255, 0.45);
  margin-right: 2px;
}

.gt-acetate-sep {
  color: rgba(255, 255, 255, 0.15);
  font-weight: 300;
}

/* Basemap attribution — sits in the left cluster after ZOOM. Slightly
   dimmer than the data readouts because it is informational, not interactive.
   The text comes from the active BasemapProvider (Mapbox: static string;
   Google: copyright field returned by createSession). */
.gt-footer-attribution {
  color: rgba(255, 255, 255, 0.55);
  font-size: 10px;
}

.gt-footer-attribution-wrap {
  white-space: nowrap;
}

/* ─── Layers Toggle Button ─── */
.gt-layers-btn {
  top: 150px;
  left: 20px;
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--gt-accent-cyan);
  font-family: var(--gt-font-sans);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.3px;
  border: none;
  opacity: 1 !important;
  transition: all 0.2s ease;
}

.gt-layers-btn:hover {
  background: rgba(4, 6, 12, 0.95);
  border-color: var(--gt-accent-cyan);
  box-shadow: inset 0 0 0 1px var(--gt-accent-cyan), 0 4px 16px rgba(0, 229, 255, 0.4);
  transform: translateY(-1px);
  color: #ffffff;
  opacity: 1;
}

.gt-layers-btn svg { flex-shrink: 0; }

/* ─── Search Button ─── */
.gt-search-btn {
  top: 112px;
  left: 20px;
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--gt-accent-cyan);
  font-family: var(--gt-font-sans);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.3px;
  border: none;
  opacity: 1 !important;
  transition: all 0.2s ease;
}

.gt-search-btn:hover {
  background: rgba(4, 6, 12, 0.95);
  border-color: var(--gt-accent-cyan);
  box-shadow: inset 0 0 0 1px var(--gt-accent-cyan), 0 4px 16px rgba(0, 229, 255, 0.4);
  transform: translateY(-1px);
  color: #ffffff;
  opacity: 1;
}

/* ─── Geocoder Panel ─── */
.gt-geocoder-panel {
  top: 20px;
  left: 170px;
  width: 320px;
  padding: 0;
  background: rgba(30, 40, 65, 0.92);
  animation: gt-fade-in 0.2s ease;
}

.gt-geocoder-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
}

.gt-geocoder-icon {
  color: var(--gt-text-secondary);
  flex-shrink: 0;
}

.gt-geocoder-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  color: var(--gt-text-primary);
  font-family: var(--gt-font-sans);
  font-size: 13px;
  font-weight: 400;
  caret-color: var(--gt-accent-cyan);
}

.gt-geocoder-input::placeholder {
  color: var(--gt-text-secondary);
  opacity: 0.6;
}

.gt-geocoder-clear-btn {
  background: none;
  border: none;
  color: var(--gt-text-secondary);
  font-size: 18px;
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
  transition: color 0.15s;
}

.gt-geocoder-clear-btn:hover {
  color: var(--gt-text-primary);
}

.gt-geocoder-results {
  border-top: 1px solid var(--gt-glass-border);
  max-height: 280px;
  overflow-y: auto;
}

.gt-geocoder-results:empty { display: none; }

.gt-geocoder-result-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  cursor: pointer;
  transition: background 0.15s;
  border-bottom: 1px solid rgba(100, 160, 255, 0.04);
}

.gt-geocoder-result-item:last-child { border-bottom: none; }

.gt-geocoder-result-item:hover {
  background: rgba(0, 229, 255, 0.08);
}

.gt-geocoder-result-icon {
  color: var(--gt-accent-cyan);
  flex-shrink: 0;
  margin-top: 2px;
}

.gt-geocoder-result-text {
  flex: 1;
  min-width: 0;
}

.gt-geocoder-result-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--gt-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gt-geocoder-result-context {
  font-size: 10px;
  color: var(--gt-text-secondary);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ─── Layer Manager Dialog ─── */
.gt-layer-manager-panel {
  position: fixed;
  width: 320px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  padding: 0;
  animation: gt-fade-in 0.2s ease;
  zoom: 1.0;
}

@keyframes gt-fade-in {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

.gt-lm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 6px;
  border-bottom: 1px solid var(--gt-glass-border);
  cursor: grab;
  user-select: none;
}

.gt-lm-header:active { cursor: grabbing; }

.gt-lm-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--gt-text-primary);
  letter-spacing: 0.02em;
  margin: 0;
}

.gt-lm-close-btn {
  background: none;
  border: none;
  color: var(--gt-text-secondary);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.15s;
}

.gt-lm-close-btn:hover { color: var(--gt-text-primary); }

.gt-lm-zoom-select {
  background: rgba(0, 229, 255, 0.06);
  border: 1px solid rgba(100, 160, 255, 0.15);
  border-radius: 4px;
  color: var(--gt-text-secondary);
  font-family: var(--gt-font-mono);
  font-size: 10px;
  padding: 2px 4px;
  outline: none;
  cursor: pointer;
  margin-left: auto;
  margin-right: 6px;
}

.gt-lm-zoom-select:hover {
  border-color: var(--gt-accent-cyan);
  color: var(--gt-text-primary);
}

.gt-lm-section {
  padding: 8px 14px;
  border-bottom: 1px solid var(--gt-glass-border);
}

.gt-lm-section:last-child { border-bottom: none; }

/* Upload bar inside layer manager */
.gt-lm-upload-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0 4px;
}

.gt-lm-add-geojson-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-family: var(--gt-font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--gt-accent-cyan);
  background: rgba(0, 229, 255, 0.08);
  border: 1px solid rgba(0, 229, 255, 0.3);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  white-space: nowrap;
}
.gt-lm-add-geojson-btn:hover {
  background: rgba(0, 229, 255, 0.16);
  border-color: rgba(0, 229, 255, 0.55);
}

.gt-lm-upload-status {
  font-size: 10px;
  color: var(--gt-text-secondary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gt-lm-upload-status.gt-upload-error {
  color: #ff6b6b;
}
.gt-lm-upload-status.gt-upload-ok {
  color: #4ade80;
}

/* Full-canvas drag-drop overlay */
.gt-upload-zone {
  position: absolute;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s ease;
  background: rgba(0, 10, 30, 0.72);
}
.gt-upload-zone.gt-upload-zone-active {
  opacity: 1;
  pointer-events: auto;
}
.gt-upload-zone-label {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px 48px;
  border: 2px dashed rgba(0, 229, 255, 0.6);
  border-radius: 16px;
  color: var(--gt-accent-cyan);
  font-family: var(--gt-font-sans);
  font-size: 16px;
  font-weight: 500;
}
.gt-upload-zone-label svg {
  opacity: 0.8;
}

.gt-lm-section-label {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--gt-text-secondary);
  margin-bottom: 4px;
}

.gt-lm-basemap-row { display: flex; }
.gt-lm-basemap-select { flex: 1; }

.gt-lm-layer-row {
  padding: 6px 0 8px;
  border-bottom: 1px solid rgba(100, 160, 255, 0.18);
  margin-bottom: 1px;
}

.gt-lm-layer-row:last-child { border-bottom: none; margin-bottom: 0; }

.gt-lm-layer-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gt-lm-toggle {
  position: relative;
  width: 34px;
  height: 18px;
  flex-shrink: 0;
}

.gt-lm-toggle input { opacity: 0; width: 0; height: 0; }

.gt-lm-toggle-track {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 9px;
  cursor: pointer;
  transition: background 0.25s;
}

.gt-lm-toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  background: var(--gt-text-secondary);
  border-radius: 50%;
  transition: transform 0.25s, background 0.25s;
}

.gt-lm-toggle input:checked + .gt-lm-toggle-track {
  background: rgba(0, 229, 255, 0.3);
}

.gt-lm-toggle input:checked + .gt-lm-toggle-track::after {
  transform: translateX(16px);
  background: var(--gt-accent-cyan);
}

/* Small toggle variant for extrusion controls */
.gt-lm-toggle-small .gt-lm-toggle-track {
  width: 32px;
  height: 16px;
}
.gt-lm-toggle-small .gt-lm-toggle-track::after {
  width: 12px;
  height: 12px;
}
.gt-lm-toggle-small input:checked + .gt-lm-toggle-track::after {
  transform: translateX(14px);
}

/* Extrusion controls section */
.gt-lm-extrude-section {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px solid rgba(100, 160, 255, 0.08);
}

.gt-lm-extrude-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.gt-lm-extrude-label {
  font-size: 11px;
  color: var(--gt-text-secondary);
  white-space: nowrap;
}

.gt-lm-extrude-slider-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.gt-lm-extrude-slider {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: rgba(100, 160, 255, 0.15);
  outline: none;
  cursor: pointer;
  min-width: 40px;
}

.gt-lm-extrude-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--gt-accent-cyan);
  border: 1px solid rgba(0, 229, 255, 0.3);
  cursor: pointer;
}

.gt-lm-extrude-val {
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  font-size: 10px;
  color: var(--gt-accent-cyan);
  min-width: 28px;
  text-align: right;
}

.gt-lm-layer-info { flex: 1; min-width: 0; }

.gt-lm-layer-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--gt-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gt-lm-layer-meta {
  font-size: 10px;
  color: var(--gt-text-secondary);
  margin-top: 2px;
  font-family: var(--gt-font-mono);
}

.gt-lm-style-preview { margin-top: 4px; }

.gt-lm-ramp-bar {
  height: 6px;
  border-radius: 3px;
  width: 100%;
}

.gt-lm-ramp-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-size: 9px;
  font-family: var(--gt-font-mono);
  color: var(--gt-text-secondary);
}

.gt-lm-ramp-attr {
  font-size: 9px;
  font-family: var(--gt-font-sans);
  font-weight: 500;
  color: var(--gt-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

/* ─── Interactive Ramp Stop Editor ─── */
.gt-lm-ramp-editor {
  margin-top: 8px;
}

.gt-lm-ramp-track {
  position: relative;
  height: 14px;
  border-radius: 7px;
  width: 100%;
  cursor: crosshair;
  border: 1px solid rgba(100, 160, 255, 0.12);
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.3);
}


.gt-lm-ramp-handle {
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.7);
  cursor: grab;
  transform: translateX(-50%);
  top: 3px;
  transition: box-shadow 0.15s ease, transform 0.1s ease;
  z-index: 2;
}

.gt-lm-ramp-handle:hover {
  transform: translateX(-50%) scale(1.2);
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);
  z-index: 3;
}

.gt-lm-ramp-handle.gt-active {
  transform: translateX(-50%) scale(1.3);
  box-shadow: 0 0 12px rgba(0, 229, 255, 0.6);
  border-color: var(--gt-accent-cyan);
  z-index: 4;
}

.gt-lm-ramp-handle:active {
  cursor: grabbing;
}

.gt-lm-ramp-handle-color {
  display: none;
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
  overflow: hidden;
}

/* ─── Stop Detail Popover ─── */
.gt-lm-stop-popover {
  position: absolute;
  top: 22px;
  transform: translateX(-50%);
  background: rgba(18, 22, 36, 0.95);
  border: 1px solid rgba(100, 160, 255, 0.15);
  border-radius: 8px;
  padding: 8px 10px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  z-index: 100;
  min-width: 160px;
  backdrop-filter: blur(12px);
}

.gt-lm-pop-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.gt-lm-pop-row:last-child { margin-bottom: 0; }

.gt-lm-pop-label {
  font-family: var(--gt-font-sans);
  font-size: 9px;
  color: var(--gt-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  white-space: nowrap;
}

.gt-lm-pop-color {
  -webkit-appearance: none;
  appearance: none;
  width: 22px;
  height: 22px;
  border: 1px solid rgba(100, 160, 255, 0.2);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
  background: transparent;
}

.gt-lm-pop-color::-webkit-color-swatch-wrapper { padding: 1px; }
.gt-lm-pop-color::-webkit-color-swatch { border-radius: 3px; border: none; }

.gt-lm-pop-value {
  width: 58px;
  background: rgba(0, 229, 255, 0.04);
  border: 1px solid rgba(100, 160, 255, 0.12);
  border-radius: 4px;
  padding: 3px 6px;
  outline: none;
  color: var(--gt-text-primary);
  font-family: var(--gt-font-mono);
  font-size: 10px;
  text-align: center;
  caret-color: var(--gt-accent-cyan);
}

.gt-lm-pop-value:focus {
  border-color: var(--gt-accent-cyan);
  background: rgba(0, 229, 255, 0.08);
}

.gt-lm-pop-opacity-slider {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  height: 3px;
  background: rgba(100, 160, 255, 0.15);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.gt-lm-pop-opacity-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--gt-accent-cyan);
  border: 1px solid rgba(0, 229, 255, 0.3);
  cursor: pointer;
}

.gt-lm-pop-opacity-val {
  font-family: var(--gt-font-mono);
  font-size: 9px;
  color: var(--gt-text-secondary);
  min-width: 28px;
  text-align: right;
}

.gt-lm-pop-delete {
  width: 100%;
  margin-top: 4px;
  background: rgba(255, 80, 80, 0.08);
  border: 1px solid rgba(255, 80, 80, 0.15);
  border-radius: 4px;
  color: rgba(255, 100, 100, 0.8);
  font-family: var(--gt-font-sans);
  font-size: 9px;
  font-weight: 500;
  cursor: pointer;
  padding: 3px 8px;
  transition: all 0.15s ease;
}

.gt-lm-pop-delete:hover {
  color: #ff5555;
  background: rgba(255, 80, 80, 0.15);
  border-color: rgba(255, 80, 80, 0.3);
}

.gt-lm-ramp-handles {
  position: relative;
  height: 36px;
  margin-top: 2px;
}

.gt-lm-ramp-handle-label {
  position: absolute;
  top: 19px;
  transform: translateX(-50%);
  font-family: var(--gt-font-mono);
  font-size: 8px;
  color: var(--gt-text-secondary);
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}

.gt-lm-domain-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.gt-lm-domain-input {
  width: 52px;
  background: rgba(0, 229, 255, 0.04);
  border: 1px solid rgba(100, 160, 255, 0.12);
  border-radius: 4px;
  padding: 3px 6px;
  outline: none;
  color: var(--gt-text-primary);
  font-family: var(--gt-font-mono);
  font-size: 10px;
  text-align: center;
  caret-color: var(--gt-accent-cyan);
  transition: all 0.2s ease;
}

.gt-lm-domain-input:focus {
  border-color: var(--gt-accent-cyan);
  background: rgba(0, 229, 255, 0.08);
  box-shadow: 0 0 6px rgba(0, 229, 255, 0.15);
}

.gt-lm-domain-spacer {
  flex: 1;
}

.gt-lm-ramp-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 4px;
}

.gt-lm-ramp-action-btn {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(100, 160, 255, 0.1);
  border-radius: 4px;
  color: var(--gt-text-secondary);
  font-family: var(--gt-font-sans);
  font-size: 9px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  cursor: pointer;
  padding: 3px 8px;
  transition: all 0.15s ease;
}

.gt-lm-ramp-action-btn:hover {
  color: var(--gt-accent-cyan);
  background: rgba(0, 229, 255, 0.08);
  border-color: rgba(0, 229, 255, 0.2);
}

.gt-stats-select {
  font-family: var(--gt-font-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--gt-accent-cyan);
  background: rgba(0, 229, 255, 0.08);
  border: 1px solid var(--gt-glass-border);
  border-radius: 6px;
  padding: 5px 8px;
  cursor: pointer;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  transition: all 0.2s ease;
}

.gt-stats-select:hover {
  background: rgba(0, 229, 255, 0.15);
  border-color: var(--gt-accent-cyan);
}

.gt-stats-select:focus {
  border-color: var(--gt-accent-cyan);
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.2);
}

.gt-stats-select option {
  background: #0a0f1e;
  color: var(--gt-text-primary);
}

/* ─── GPU Filter Input ─── */
.gt-lm-filter-section {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(100, 160, 255, 0.08);
}

.gt-lm-filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.gt-lm-filter-icon {
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
  opacity: 0.5;
}

.gt-lm-filter-clear-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(100, 160, 255, 0.12);
  border-radius: 6px;
  color: var(--gt-text-secondary);
  font-size: 13px;
  cursor: pointer;
  padding: 5px 8px;
  line-height: 1;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.gt-lm-filter-clear-btn:hover {
  color: var(--gt-text-primary);
  background: rgba(255, 80, 80, 0.15);
  border-color: rgba(255, 80, 80, 0.3);
}
.gt-lm-filter-input {
  width: 100%;
  box-sizing: border-box;
  background: rgba(0, 229, 255, 0.04);
  border: 1px solid rgba(100, 160, 255, 0.12);
  border-radius: 6px;
  padding: 6px 10px;
  outline: none;
  color: var(--gt-text-primary);
  font-family: var(--gt-font-mono);
  font-size: 11px;
  font-weight: 400;
  caret-color: var(--gt-accent-cyan);
  transition: all 0.2s ease;
  min-width: 0;
}

.gt-lm-filter-input::placeholder {
  color: var(--gt-text-secondary);
  opacity: 0.5;
}

.gt-lm-filter-input:focus {
  border-color: var(--gt-accent-cyan);
  background: rgba(0, 229, 255, 0.08);
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.15);
}

/* ─── Autocomplete Dropdown ─── */
.gt-ac-wrapper {
  position: relative;
  flex: 1;
  min-width: 0;
}

.gt-ac-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 1000;
  margin-top: 4px;
  background: rgba(8, 14, 30, 0.96);
  border: 1px solid rgba(100, 160, 255, 0.18);
  border-radius: 8px;
  backdrop-filter: blur(12px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  max-height: 240px;
  overflow-y: auto;
  padding: 4px;
}

/* Flip dropdown upward when near the bottom of the panel */
.gt-ac-dropdown-up {
  top: auto;
  bottom: 100%;
  margin-top: 0;
  margin-bottom: 4px;
}

.gt-ac-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.gt-ac-item:hover,
.gt-ac-item.active {
  background: rgba(0, 229, 255, 0.12);
}

.gt-ac-label {
  font-family: var(--gt-font-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--gt-text-primary);
}

.gt-ac-badge {
  font-family: var(--gt-font-mono);
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 1px 6px;
  border-radius: 3px;
  flex-shrink: 0;
}

.gt-ac-badge-numeric {
  color: var(--gt-accent-cyan);
  background: rgba(0, 229, 255, 0.1);
  border: 1px solid rgba(0, 229, 255, 0.2);
}

.gt-ac-badge-enum {
  color: #ffab40;
  background: rgba(255, 171, 64, 0.1);
  border: 1px solid rgba(255, 171, 64, 0.2);
}

.gt-ac-badge-op {
  color: #b388ff;
  background: rgba(179, 136, 255, 0.1);
  border: 1px solid rgba(179, 136, 255, 0.2);
}

.gt-ac-badge-value {
  color: #69f0ae;
  background: rgba(105, 240, 174, 0.1);
  border: 1px solid rgba(105, 240, 174, 0.2);
}

.gt-ac-badge-logic {
  color: #ff80ab;
  background: rgba(255, 128, 171, 0.1);
  border: 1px solid rgba(255, 128, 171, 0.2);
}

.gt-ac-more {
  font-family: var(--gt-font-mono);
  font-size: 10px;
  color: var(--gt-text-secondary);
  text-align: center;
  padding: 4px;
  opacity: 0.6;
}

/* ─── Time Panel ─── */
.gt-time-panel {
  bottom: 42px;
  left: 20px;
  width: min(500px, calc(100% - 40px));
  padding: 8px 20px;
}

.gt-time-display {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 4px;
}

.gt-time-clock {
  font-size: 15px;
  font-weight: 600;
  color: var(--gt-accent-cyan);
  letter-spacing: 0.04em;
  font-family: var(--gt-font-mono);
}

.gt-time-period {
  font-size: 9px;
  color: var(--gt-text-secondary);
  font-weight: 500;
}

.gt-time-date {
  font-size: 9px;
  font-weight: 500;
  color: var(--gt-text-secondary);
  font-family: var(--gt-font-mono);
  letter-spacing: 0.3px;
}

.gt-time-epoch {
  font-size: 10px;
  font-weight: 600;
  color: rgba(255, 140, 60, 0.85);
  font-family: var(--gt-font-mono);
  letter-spacing: 0.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255, 140, 60, 0.1);
  border: 1px solid rgba(255, 140, 60, 0.2);
}

.gt-time-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  position: relative;
}

.gt-step-btn {
  width: 22px;
  height: 22px;
  font-size: 11px;
  padding: 0;
  flex-shrink: 0;
}

.gt-live-badge {
  font-family: var(--gt-font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.8px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid rgba(255, 60, 60, 0.25);
  background: rgba(255, 60, 60, 0.08);
  color: rgba(255, 100, 100, 0.5);
  cursor: pointer;
  transition: all 0.3s ease;
  flex-shrink: 0;
}

.gt-live-badge:hover {
  background: rgba(255, 60, 60, 0.18);
  border-color: rgba(255, 60, 60, 0.5);
  color: #ff6666;
}

.gt-live-badge.gt-live-active {
  background: rgba(255, 40, 40, 0.2);
  border-color: rgba(255, 40, 40, 0.6);
  color: #ff4444;
  box-shadow: 0 0 10px rgba(255, 40, 40, 0.35);
  animation: gt-pulse-live 2s ease-in-out infinite;
}

@keyframes gt-pulse-live {
  0%, 100% { box-shadow: 0 0 8px rgba(255, 40, 40, 0.3); }
  50% { box-shadow: 0 0 16px rgba(255, 40, 40, 0.55); }
}

.gt-scrub-tooltip {
  display: none;
  position: absolute;
  top: -32px;
  transform: translateX(-50%);
  background: rgba(10, 15, 30, 0.92);
  border: 1px solid var(--gt-glass-border);
  border-radius: 6px;
  padding: 3px 8px;
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  font-size: 12px;
  color: var(--gt-accent-cyan);
  white-space: nowrap;
  pointer-events: none;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
}

.gt-control-btn {
  width: 24px;
  height: 24px;
  border: 1px solid var(--gt-glass-border);
  border-radius: 5px;
  background: rgba(0, 229, 255, 0.08);
  color: var(--gt-accent-cyan);
  font-size: 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.gt-control-btn:hover {
  background: rgba(0, 229, 255, 0.2);
  border-color: var(--gt-accent-cyan);
  box-shadow: 0 0 12px rgba(0, 229, 255, 0.2);
}

.gt-speed-select {
  font-family: var(--gt-font-mono);
  font-size: 9px;
  font-weight: 500;
  color: var(--gt-accent-cyan);
  background: rgba(0, 229, 255, 0.08);
  border: 1px solid var(--gt-glass-border);
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2300e5ff' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
  padding-right: 20px;
  transition: all 0.2s ease;
}

.gt-speed-select:hover {
  background-color: rgba(0, 229, 255, 0.15);
  border-color: var(--gt-accent-cyan);
  box-shadow: 0 0 12px rgba(0, 229, 255, 0.2);
}

.gt-speed-select:focus {
  border-color: var(--gt-accent-cyan);
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.2);
}

.gt-speed-select option {
  background: #0a0f1e;
  color: var(--gt-text-primary);
}

.gt-record-btn {
  position: relative;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.gt-record-dot {
  display: block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #cc3333;
  transition: all 0.2s ease;
}

.gt-record-btn:hover .gt-record-dot {
  background: #ff4444;
  box-shadow: 0 0 8px rgba(255, 68, 68, 0.5);
}

.gt-recording .gt-record-dot {
  background: #ff2222;
  box-shadow: 0 0 12px rgba(255, 34, 34, 0.8);
  animation: gt-pulse-record 1s ease-in-out infinite;
}

@keyframes gt-pulse-record {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.85); }
}

.gt-scrubber {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 3px;
  border-radius: 2px;
  background: rgba(100, 160, 255, 0.15);
  outline: none;
  cursor: pointer;
}

.gt-scrubber::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--gt-accent-cyan);
  border: 1.5px solid rgba(0, 229, 255, 0.4);
  box-shadow: 0 0 6px rgba(0, 229, 255, 0.3);
  cursor: pointer;
  transition: transform 0.15s ease;
}

.gt-scrubber::-webkit-slider-thumb:hover { transform: scale(1.2); }

.gt-scrubber::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--gt-accent-cyan);
  border: 2px solid rgba(0, 229, 255, 0.4);
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.4);
  cursor: pointer;
}

.gt-time-labels {
  position: relative;
  height: 16px;
  margin-top: 3px;
  font-size: 9px;
  color: rgba(220, 225, 240, 0.9);
  font-family: var(--gt-font-mono);
}

.gt-time-labels span {
  position: absolute;
  transform: translateX(-50%);
  white-space: nowrap;
}

.gt-time-labels span:first-child {
  transform: translateX(0);
}

.gt-time-labels span:last-child {
  transform: translateX(-100%);
}

.gt-time-labels span::before {
  content: '';
  position: absolute;
  top: -5px;
  left: 50%;
  width: 1px;
  height: 4px;
  background: var(--gt-text-secondary);
  opacity: 0.5;
}

/* ─── Responsive ─── */
@media (max-width: 640px) {
  .gt-time-panel {
    bottom: 15px;
    padding: 12px 16px;
  }

  .gt-time-clock { font-size: 22px; }
}

/* ─── Legend Button ─── */
.gt-legend-btn {
  top: 264px;
  left: 20px;
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--gt-accent-cyan);
  font-family: var(--gt-font-sans);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.3px;
  border: none;
  transition: all 0.2s ease;
}
.gt-legend-btn:hover {
  background: rgba(4, 6, 12, 0.95);
  border-color: var(--gt-accent-cyan);
  box-shadow: inset 0 0 0 1px var(--gt-accent-cyan), 0 4px 16px rgba(0, 229, 255, 0.4);
  transform: translateY(-1px);
  color: #ffffff;
}
.gt-legend-btn svg { flex-shrink: 0; }



/* ─── Charts Toggle Button ─── */
.gt-charts-btn {
  top: 188px;
  left: 20px;
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--gt-accent-cyan);
  font-family: var(--gt-font-sans);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.3px;
  border: none;
  transition: all 0.2s ease;
}
.gt-charts-btn:hover {
  background: rgba(4, 6, 12, 0.95);
  border-color: var(--gt-accent-cyan);
  box-shadow: inset 0 0 0 1px var(--gt-accent-cyan), 0 4px 16px rgba(0, 229, 255, 0.4);
  transform: translateY(-1px);
  color: #ffffff;
}
.gt-charts-btn svg { flex-shrink: 0; }

/* ─── Chart Visibility Toggle (bottom-right, above footer) ─── */
.gt-chart-toggle-btn {
  bottom: 52px;
  right: 20px;
  width: 44px;
  height: 44px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--gt-accent-cyan);
  border: none;
  transition: all 0.25s ease;
  box-shadow: 0 2px 12px rgba(0, 229, 255, 0.15);
}
.gt-chart-toggle-btn:hover {
  background: rgba(4, 6, 12, 0.95);
  border-color: var(--gt-accent-cyan);
  box-shadow: inset 0 0 0 1px var(--gt-accent-cyan), 0 4px 20px rgba(0, 229, 255, 0.45);
  transform: translateY(-2px);
  color: #ffffff;
}
.gt-chart-toggle-btn svg { flex-shrink: 0; }

/* ─── 2D/3D Projection Toggle (sits left of chart toggle) ─── */
.gt-projection-toggle-btn {
  bottom: 52px;
  right: 72px;
  width: 44px;
  height: 44px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: var(--gt-accent-cyan);
  border: none;
  transition: all 0.25s ease;
  box-shadow: 0 2px 12px rgba(0, 229, 255, 0.15);
}
.gt-projection-toggle-btn:hover {
  background: rgba(4, 6, 12, 0.95);
  border-color: var(--gt-accent-cyan);
  box-shadow: inset 0 0 0 1px var(--gt-accent-cyan), 0 4px 20px rgba(0, 229, 255, 0.45);
  transform: translateY(-2px);
  color: #ffffff;
}
.gt-projection-toggle-btn svg { flex-shrink: 0; }

/* Dimmed state when charts are hidden */
.gt-chart-toggle-off {
  opacity: 0.35;
  color: var(--gt-text-secondary);
  box-shadow: none;
}
.gt-chart-toggle-off:hover {
  opacity: 0.8;
  color: var(--gt-accent-cyan);
}

/* ─── Chart Manager Panel ─── */
.gt-chart-manager-panel {
  position: fixed;
  width: 460px;
  max-height: 80vh;
  overflow-y: auto;
  padding: 0;
  z-index: 100;
  border-radius: 12px;
}
.gt-cm-layout {
  display: flex;
  min-height: 200px;
}
.gt-cm-chart-list {
  width: 120px;
  min-width: 120px;
  border-right: 1px solid rgba(0, 229, 255, 0.1);
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  max-height: 60vh;
}
.gt-cm-chart-pill {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 10px;
  font-family: var(--gt-font-sans);
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
}
.gt-cm-chart-pill:hover {
  background: rgba(0, 229, 255, 0.08);
  border-color: rgba(0, 229, 255, 0.2);
  color: rgba(255, 255, 255, 0.85);
}
.gt-cm-chart-pill.gt-cm-pill-active {
  background: rgba(0, 229, 255, 0.12);
  border-color: rgba(0, 229, 255, 0.35);
  color: rgba(255, 255, 255, 0.95);
  box-shadow: 0 0 8px rgba(0, 229, 255, 0.15);
}
.gt-cm-pill-icon {
  font-size: 11px;
  flex-shrink: 0;
}
.gt-cm-pill-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.gt-cm-pill-text {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}
.gt-cm-pill-source {
  font-size: 8px;
  color: rgba(0, 229, 255, 0.45);
  overflow: hidden;
  text-overflow: ellipsis;
}
.gt-cm-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 6px;
  margin-top: 4px;
  background: rgba(0, 229, 255, 0.06);
  border: 1px dashed rgba(0, 229, 255, 0.2);
  border-radius: 6px;
  color: rgba(0, 229, 255, 0.6);
  cursor: pointer;
  transition: all 0.2s;
}
.gt-cm-add-btn:hover {
  background: rgba(0, 229, 255, 0.15);
  border-color: rgba(0, 229, 255, 0.4);
  color: var(--gt-accent-cyan);
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.15);
}
.gt-cm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(0, 229, 255, 0.12);
  cursor: grab;
}
.gt-cm-title {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin: 0;
}
.gt-cm-close-btn {
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.2s;
}
.gt-cm-close-btn:hover { color: var(--gt-accent-cyan); }

.gt-cm-body {
  flex: 1;
  padding: 6px 10px 8px;
  overflow-y: auto;
  max-height: 70vh;
}
.gt-cm-section {
  margin-bottom: 4px;
}
.gt-cm-label {
  display: block;
  font-size: 9px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.5);
  letter-spacing: 0.3px;
  text-transform: uppercase;
  margin-bottom: 2px;
}
.gt-cm-select, .gt-cm-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(0, 229, 255, 0.15);
  border-radius: 4px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 11px;
  padding: 3px 6px;
  font-family: var(--gt-font-sans);
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}
.gt-cm-select:focus, .gt-cm-input:focus {
  border-color: var(--gt-accent-cyan);
}
.gt-cm-select option {
  background: #0a0e1a;
}
.gt-cm-row {
  display: flex;
  gap: 6px;
}
.gt-cm-half {
  flex: 1;
}
.gt-cm-divider {
  height: 1px;
  background: rgba(0, 229, 255, 0.08);
  margin: 5px 0;
}
.gt-cm-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.gt-cm-apply-btn {
  flex: 1;
  padding: 5px 0;
  background: rgba(0, 229, 255, 0.12);
  border: 1px solid rgba(0, 229, 255, 0.25);
  border-radius: 4px;
  color: var(--gt-accent-cyan);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  cursor: pointer;
  transition: all 0.2s;
  font-family: var(--gt-font-sans);
}
.gt-cm-apply-btn:hover {
  background: rgba(0, 229, 255, 0.22);
  box-shadow: 0 0 12px rgba(0, 229, 255, 0.2);
}
.gt-cm-remove-btn {
  padding: 5px 10px;
  background: rgba(255, 80, 80, 0.08);
  border: 1px solid rgba(255, 80, 80, 0.2);
  border-radius: 4px;
  color: rgba(255, 120, 120, 0.8);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.2s;
  font-family: var(--gt-font-sans);
}
.gt-cm-remove-btn:hover {
  background: rgba(255, 80, 80, 0.2);
  color: rgba(255, 120, 120, 1);
}

/* ─── Legend Panel ─── */
.gt-legend-panel {
  position: absolute;
  width: auto;
  min-width: 220px;
  max-width: 420px;
  max-height: 400px;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 90;
}
.gt-legend-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--gt-glass-border);
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.gt-legend-header:active { cursor: grabbing; }
.gt-legend-title {
  margin: 0;
  font-family: var(--gt-font-sans);
  font-size: 13px;
  font-weight: 600;
  color: var(--gt-accent-cyan);
  letter-spacing: 1.5px;
  text-transform: uppercase;
}
.gt-legend-close {
  background: none;
  border: none;
  color: var(--gt-text-secondary);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.15s;
}
.gt-legend-close:hover { color: #fff; }

.gt-legend-body {
  padding: 10px 14px 14px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 229, 255, 0.25) transparent;
}
.gt-legend-body::-webkit-scrollbar {
  width: 5px;
}
.gt-legend-body::-webkit-scrollbar-track {
  background: transparent;
}
.gt-legend-body::-webkit-scrollbar-thumb {
  background: rgba(0, 229, 255, 0.2);
  border-radius: 3px;
}
.gt-legend-body::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 229, 255, 0.4);
}
.gt-legend-section {
  margin-bottom: 16px;
}
.gt-legend-section:last-child { margin-bottom: 0; }

.gt-legend-section-title {
  font-family: var(--gt-font-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--gt-text-primary);
  margin-bottom: 6px;
  letter-spacing: 0.5px;
}
.gt-legend-attr-label {
  font-family: var(--gt-font-mono);
  font-size: 10px;
  color: var(--gt-text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* Categorical grid (auto-fit columns) */
.gt-legend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 3px 10px;
}
.gt-legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-radius: 6px;
  transition: background 0.15s;
}
.gt-legend-item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.gt-legend-swatch {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.gt-legend-swatch svg {
  display: block;
}
.gt-legend-label {
  font-family: var(--gt-font-sans);
  font-size: 11px;
  color: var(--gt-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}

/* Ramp bar */
.gt-legend-ramp-row {
  margin-top: 4px;
}
.gt-legend-ramp-bar {
  height: 10px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.gt-legend-ramp-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-family: var(--gt-font-mono);
  font-size: 10px;
  color: var(--gt-text-secondary);
}

/* ─── Layer Info Button ─── */
.gt-lm-layer-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.gt-lm-info-btn {
  background: none;
  border: none;
  color: var(--gt-text-secondary);
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  opacity: 0.5;
  transition: all 0.15s;
}
.gt-lm-info-btn:hover {
  color: var(--gt-accent-cyan);
  opacity: 1;
}
.gt-lm-symbology-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(0, 212, 255, 0.08);
  border: 1px solid rgba(0, 212, 255, 0.2);
  border-radius: 6px;
  color: var(--gt-accent-cyan);
  font-family: var(--gt-font-sans);
  font-size: 11px;
  font-weight: 500;
  padding: 5px 10px;
  cursor: pointer;
  transition: all 0.15s ease;
  width: 100%;
  justify-content: center;
}
.gt-lm-symbology-btn:hover {
  background: rgba(0, 212, 255, 0.15);
  border-color: rgba(0, 212, 255, 0.35);
}

/* ─── Layer Info Overlay ─── */
.gt-layer-info-overlay {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(0.95);
  width: 420px;
  max-height: 80vh;
  z-index: 1000;
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  opacity: 0;
  transition: all 0.25s ease;
}
.gt-layer-info-overlay.gt-info-visible {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}
.gt-info-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--gt-glass-border);
}
.gt-info-title {
  margin: 0;
  font-family: var(--gt-font-sans);
  font-size: 15px;
  font-weight: 600;
  color: var(--gt-text-primary);
  letter-spacing: 0.3px;
}
.gt-info-close {
  background: none;
  border: none;
  color: var(--gt-text-secondary);
  font-size: 22px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  transition: color 0.15s;
}
.gt-info-close:hover { color: #fff; }

.gt-info-body {
  padding: 16px 20px 20px;
  overflow-y: auto;
  flex: 1;
}

/* Format badge */
.gt-info-badge {
  display: inline-block;
  background: rgba(0, 229, 255, 0.12);
  color: var(--gt-accent-cyan);
  font-family: var(--gt-font-mono);
  font-size: 11px;
  font-weight: 500;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(0, 229, 255, 0.2);
  margin-bottom: 14px;
  letter-spacing: 0.5px;
}

/* Stats grid */
.gt-info-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
}
.gt-info-stat {
  flex: 1;
  min-width: 70px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 8px;
  padding: 10px 12px;
  text-align: center;
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.gt-info-stat-wide { flex-basis: 100%; }
.gt-info-stat-value {
  display: block;
  font-family: var(--gt-font-mono);
  font-size: 16px;
  font-weight: 600;
  color: var(--gt-text-primary);
}
.gt-info-stat-label {
  display: block;
  font-family: var(--gt-font-sans);
  font-size: 10px;
  color: var(--gt-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-top: 3px;
}

/* Section headings */
.gt-info-section-title {
  font-family: var(--gt-font-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--gt-accent-cyan);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin: 14px 0 8px;
}
.gt-info-section-subtitle {
  font-family: var(--gt-font-mono);
  font-size: 11px;
  font-weight: 500;
  color: var(--gt-text-primary);
  margin: 10px 0 4px;
}
.gt-info-count {
  font-weight: 400;
  color: var(--gt-text-secondary);
  font-size: 11px;
  letter-spacing: 0;
  text-transform: none;
}

/* Schema table */
.gt-info-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--gt-font-sans);
  font-size: 12px;
}
.gt-info-table th {
  text-align: left;
  padding: 6px 8px;
  color: var(--gt-text-secondary);
  font-weight: 500;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  border-bottom: 1px solid var(--gt-glass-border);
}
.gt-info-table td {
  padding: 5px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.03);
}
.gt-info-table tr:hover td {
  background: rgba(255, 255, 255, 0.03);
}
.gt-info-col-name {
  font-family: var(--gt-font-mono);
  color: var(--gt-text-primary);
  font-weight: 500;
}
.gt-info-col-type {
  font-family: var(--gt-font-mono);
  color: var(--gt-text-secondary);
  font-size: 11px;
}

/* Role badges */
.gt-info-badge-sm {
  display: inline-block;
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.gt-info-badge-temporal {
  background: rgba(76, 175, 80, 0.15);
  color: #66bb6a;
  border: 1px solid rgba(76, 175, 80, 0.3);
}
.gt-info-badge-static {
  background: rgba(158, 158, 158, 0.12);
  color: #9e9e9e;
  border: 1px solid rgba(158, 158, 158, 0.2);
}

/* Dictionary grid */
.gt-info-dict-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.gt-info-dict-item {
  font-family: var(--gt-font-sans);
  font-size: 11px;
  color: var(--gt-text-primary);
  background: rgba(255, 255, 255, 0.06);
  padding: 3px 8px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

/* ═══════════════════════════════════════════════════════════
   Symbology Dialog
   ═══════════════════════════════════════════════════════════ */
.gt-sym-overlay {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 320px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  z-index: 1200;
  opacity: 0;
  transform: translate(-50%, -50%) scale(0.95);
  transition: opacity 0.25s ease, transform 0.25s ease;
  padding: 0;
}
.gt-sym-overlay.gt-sym-visible {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}
.gt-sym-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  cursor: grab;
  user-select: none;
}
.gt-sym-header:active { cursor: grabbing; }
.gt-sym-title {
  font-family: var(--gt-font-sans);
  font-size: 14px;
  font-weight: 600;
  color: var(--gt-text-primary);
  margin: 0;
}
.gt-sym-layer-name {
  font-family: var(--gt-font-mono);
  font-size: 11px;
  color: var(--gt-accent-cyan);
  opacity: 0.7;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gt-sym-close {
  background: none;
  border: none;
  color: var(--gt-text-secondary);
  font-size: 20px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.gt-sym-close:hover { color: var(--gt-text-primary); }
.gt-sym-body {
  padding: 8px 16px 16px;
}
.gt-sym-section {
  margin-bottom: 14px;
}
.gt-sym-section-title {
  font-family: var(--gt-font-sans);
  font-size: 11px;
  font-weight: 600;
  color: var(--gt-accent-cyan);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 8px;
}
.gt-sym-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.gt-sym-label {
  font-family: var(--gt-font-sans);
  font-size: 12px;
  color: var(--gt-text-secondary);
  min-width: 44px;
}
.gt-sym-select {
  flex: 1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: var(--gt-text-primary);
  font-family: var(--gt-font-sans);
  font-size: 12px;
  padding: 5px 8px;
  cursor: pointer;
}
.gt-sym-slider-row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}
.gt-sym-slider {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.gt-sym-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--gt-accent-cyan);
  border: 2px solid rgba(8, 12, 24, 0.9);
  cursor: pointer;
}
.gt-sym-value {
  font-family: var(--gt-font-mono);
  font-size: 11px;
  color: var(--gt-text-primary);
  min-width: 36px;
  text-align: right;
}
/* Mode toggle */
.gt-sym-mode-toggle {
  display: flex;
  gap: 0;
  flex: 1;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.gt-sym-mode-btn {
  flex: 1;
  background: transparent;
  border: none;
  color: var(--gt-text-secondary);
  font-family: var(--gt-font-sans);
  font-size: 11px;
  padding: 6px 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.gt-sym-mode-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}
.gt-sym-mode-btn.gt-sym-mode-active {
  background: rgba(0, 212, 255, 0.15);
  color: var(--gt-accent-cyan);
  font-weight: 600;
}
/* Category list */
.gt-sym-category-list {
  max-height: 280px;
  overflow-y: auto;
  margin-top: 4px;
}
.gt-sym-attr-value {
  font-family: var(--gt-font-mono);
  font-size: 11px;
  color: var(--gt-accent-cyan);
}
.gt-sym-cat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.gt-sym-color-input {
  -webkit-appearance: none;
  appearance: none;
  width: 24px;
  height: 24px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  background: transparent;
  flex-shrink: 0;
}
.gt-sym-color-input::-webkit-color-swatch-wrapper {
  padding: 0;
}
.gt-sym-color-input::-webkit-color-swatch {
  border: none;
  border-radius: 50%;
}
.gt-sym-cat-name {
  font-family: var(--gt-font-sans);
  font-size: 12px;
  color: var(--gt-text-primary);
}
/* Reset button */
.gt-sym-reset-btn {
  width: 100%;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: var(--gt-text-secondary);
  font-family: var(--gt-font-sans);
  font-size: 11px;
  padding: 7px 12px;
  cursor: pointer;
  margin-top: 4px;
  transition: all 0.15s ease;
}
.gt-sym-reset-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--gt-text-primary);
}
/* Scrollbar for category list */
.gt-sym-category-list::-webkit-scrollbar {
  width: 4px;
}
.gt-sym-category-list::-webkit-scrollbar-track {
  background: transparent;
}
.gt-sym-category-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}

/* ═══════════════════════════════════════════════════════════
   Loading Screen
   ═══════════════════════════════════════════════════════════ */
.gt-loading-overlay {
  position: absolute;
  inset: 0;
  background: var(--gt-loading-bg, radial-gradient(ellipse at center, #0a1628 0%, #020408 70%));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  transition: opacity 1.0s ease;
}

.gt-loading-hidden {
  opacity: 0;
  pointer-events: none;
}

.gt-loading-center {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.gt-loading-brand-row {
  display: flex;
  align-items: center;
  gap: 12px;
  animation: gt-heartbeat 1s ease-in-out infinite;
}

.gt-loading-logo {
  height: var(--gt-loading-logo-height, 36px);
  width: auto;
}

.gt-loading-icon {
  width: 64px;
  height: 64px;
  animation: gt-heartbeat-glow 1s ease-in-out infinite;
}

.gt-loading-title {
  font-family: var(--gt-font-sans);
  font-size: 18px;
  font-weight: 600;
  color: var(--gt-text-primary);
  letter-spacing: 0.5px;
  margin: 0;
}

.gt-loading-subtitle {
  font-family: 'Outfit', var(--gt-font-sans);
  font-size: 15px;
  font-weight: 300;
  color: var(--gt-text-secondary);
  letter-spacing: 1.5px;
  margin: 4px 0 0;
  text-transform: uppercase;
}

/* Heartbeat: double-beat scale */
@keyframes gt-heartbeat {
  0%   { transform: scale(1); }
  14%  { transform: scale(1.18); }
  28%  { transform: scale(1); }
  42%  { transform: scale(1.12); }
  55%  { transform: scale(1); }
  100% { transform: scale(1); }
}

/* Icon glow heartbeat */
@keyframes gt-heartbeat-glow {
  0%   { filter: drop-shadow(0 0 10px rgba(0, 229, 255, 0.1)); }
  14%  { filter: drop-shadow(0 0 30px rgba(0, 229, 255, 0.6)); }
  28%  { filter: drop-shadow(0 0 10px rgba(0, 229, 255, 0.1)); }
  42%  { filter: drop-shadow(0 0 24px rgba(0, 229, 255, 0.4)); }
  55%  { filter: drop-shadow(0 0 10px rgba(0, 229, 255, 0.1)); }
  100% { filter: drop-shadow(0 0 10px rgba(0, 229, 255, 0.1)); }
}

/* Loader section — pinned near bottom */
.gt-loading-loader {
  position: absolute;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
  z-index: 2001;
}

.gt-loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(0, 229, 255, 0.1);
  border-top-color: var(--gt-loading-accent, var(--gt-accent-cyan));
  border-radius: 50%;
  margin: 0 auto 16px;
  animation: gt-loading-spin 1s linear infinite;
}

@keyframes gt-loading-spin {
  to { transform: rotate(360deg); }
}

.gt-loading-status {
  font-family: var(--gt-font-sans);
  font-size: 12px;
  color: var(--gt-text-secondary);
  margin: 0 0 16px;
}

.gt-loading-bar {
  width: 240px;
  height: 3px;
  background: rgba(100, 160, 255, 0.1);
  border-radius: 2px;
  margin: 0 auto;
  overflow: hidden;
}

.gt-loading-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg,
    var(--gt-loading-accent, var(--gt-accent-cyan)),
    var(--gt-accent-blue, #4A90D9));
  border-radius: 2px;
  transition: width 0.3s ease;
}

/* ─── Shard Loading Indicator ─── */
.gt-shard-loading {
  position: absolute;
  bottom: 130px;
  left: 20px;
  width: min(500px, calc(100% - 40px));
  z-index: 25;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.25s ease;
}

.gt-shard-loading-active {
  opacity: 1;
}

.gt-shard-loading-bar {
  width: 240px;
  height: 3px;
  background: rgba(100, 160, 255, 0.12);
  border-radius: 2px;
  overflow: hidden;
}

.gt-shard-loading-fill {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--gt-accent-cyan), var(--gt-accent-blue));
  border-radius: 2px;
  transition: width 0.3s ease;
}

.gt-shard-loading-text {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--gt-font-sans);
  font-size: 11px;
  color: var(--gt-text-secondary);
  background: rgba(8, 12, 24, 0.85);
  border: 1px solid var(--gt-glass-border);
  border-radius: 8px;
  padding: 5px 12px;
}

/* Feature popup overlay */
.gt-feature-popup {
  position: fixed;
  top: 0;
  left: 0;
  /* position:fixed escapes parent overflow:hidden so the popup is never clipped
     by host-app panel containers. High z-index keeps it above host chrome. */
  z-index: 2147483000;
  min-width: 280px;
  max-width: 280px;
  pointer-events: none;
  opacity: 0;
  transform: translate(0,0);
  transition: opacity 0.12s ease;
  font-family: var(--gt-font-sans);
  font-size: 11px;
  background: rgba(8, 12, 24, 0.92);
  border: 1px solid var(--gt-glass-border);
  border-radius: 8px;
  padding: 8px 10px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  backdrop-filter: blur(8px);
}
.gt-feature-popup.gt-popup-visible {
  opacity: 1;
}
.gt-popup-pinned {
  border-color: rgba(0, 229, 255, 0.45);
  /* Pinned popups must be interactive so a long, scrollable field list can be
     scrolled/selected. (Hover popups keep pointer-events:none so they don't
     intercept the cursor while following it.) */
  pointer-events: auto;
}
/* Pinned popups can hold many fields — give the body a taller, viewport-aware
   scroll area than the compact hover popup. */
.gt-popup-pinned .gt-popup-body {
  max-height: min(60vh, 440px);
}
.gt-popup-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--gt-accent-cyan);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gt-popup-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
}
.gt-popup-kv {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.gt-popup-key {
  color: var(--gt-text-secondary);
  white-space: nowrap;
  flex-shrink: 0;
}
.gt-popup-val {
  color: var(--gt-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gt-popup-empty {
  color: var(--gt-text-secondary);
  font-style: italic;
}
.gt-popup-divider {
  font-size: 9px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--gt-text-secondary);
  border-top: 1px solid var(--gt-glass-border);
  margin: 5px 0 2px;
  padding-top: 4px;
}
/* Two-column layout: labels/values align in a shared grid; dividers span both. */
.gt-popup-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 10px;
  row-gap: 2px;
  align-items: baseline;
}
.gt-popup-grid .gt-popup-divider {
  grid-column: 1 / -1;
}
.gt-popup-grid .gt-popup-val {
  text-align: right;
  white-space: pre-line;     /* preserve objectList line breaks; still wraps long text */
  word-break: break-word;
  overflow: visible;
  text-overflow: clip;
}

.gt-shard-loading-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(0, 229, 255, 0.2);
  border-top-color: var(--gt-accent-cyan);
  border-radius: 50%;
  animation: gt-shard-spin 0.8s linear infinite;
}

@keyframes gt-shard-spin {
  to { transform: rotate(360deg); }
}

.gt-shard-loading-toast {
  position: absolute;
  bottom: 130px;
  left: 20px;
  width: min(500px, calc(100% - 40px));
  text-align: center;
  font-family: var(--gt-font-sans);
  font-size: 11px;
  font-weight: 500;
  color: #4ade80;
  background: rgba(8, 12, 24, 0.85);
  border: 1px solid rgba(74, 222, 128, 0.2);
  border-radius: 8px;
  padding: 5px 14px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}

.gt-shard-toast-show {
  opacity: 1;
}
`;

let injected = false;

export function injectStyles() {
  if (injected || document.getElementById(STYLE_ID)) {
    injected = true;
    return;
  }

  // Inject Google Fonts if not already present
  if (!document.querySelector('link[href*="fonts.googleapis.com/css2?family=Inter"]')) {
    const preconnect1 = document.createElement('link');
    preconnect1.rel = 'preconnect';
    preconnect1.href = 'https://fonts.googleapis.com';
    document.head.appendChild(preconnect1);

    const preconnect2 = document.createElement('link');
    preconnect2.rel = 'preconnect';
    preconnect2.href = 'https://fonts.gstatic.com';
    preconnect2.crossOrigin = '';
    document.head.appendChild(preconnect2);

    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href =
      'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';
    document.head.appendChild(fontLink);
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  injected = true;
}
