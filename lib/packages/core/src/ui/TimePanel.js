/**
 * TimePanel.js — Floating time control panel with clock display,
 * play/pause, scrubber, speed selection, and video recording.
 */

export class TimePanel {
  /**
   * @param {import('../GlobeTrotterEngine.js').GlobeTrotterEngine} engine
   * @param {HTMLElement} container
   */
  constructor(engine, container) {
    this.engine = engine;
    this._recording = false;
    this._mediaRecorder = null;
    this._chunks = [];
    this._createDOM(container);
    this._bindEvents();
    this.updateLabels();
  }

  _createDOM(container) {
    this.panel = document.createElement('div');
    this.panel.className = 'gt-glass-panel gt-time-panel';
    this.panel.innerHTML = `
            <div class="gt-time-display">
                <button class="gt-control-btn gt-play-btn" title="Play/Pause">⏸</button>
                <button class="gt-control-btn gt-record-btn" title="Record Video">
                    <span class="gt-record-dot"></span>
                </button>
                <span class="gt-time-clock gt-mono">00:00:00</span>
                <span class="gt-time-date"></span>
                <span class="gt-time-epoch gt-mono" title="Current epoch / total epochs"></span>
                <span class="gt-time-period">UTC</span>
                <button class="gt-live-badge" title="Jump to live edge">LIVE</button>
                <select class="gt-speed-select" title="Playback Speed"></select>
            </div>
            <div class="gt-time-controls">
                <button class="gt-control-btn gt-step-btn" data-dir="-1" title="Step back one epoch">⏪</button>
                <input type="range" class="gt-scrubber" min="0" max="1000" value="0">
                <button class="gt-control-btn gt-step-btn" data-dir="1" title="Step forward one epoch">⏩</button>
                <div class="gt-scrub-tooltip"></div>
            </div>
            <div class="gt-time-labels"></div>
        `;
    container.appendChild(this.panel);

    // Cache refs
    this._clock = this.panel.querySelector('.gt-time-clock');
    this._dateEl = this.panel.querySelector('.gt-time-date');
    this._epochEl = this.panel.querySelector('.gt-time-epoch');
    this._playBtn = this.panel.querySelector('.gt-play-btn');
    this._recordBtn = this.panel.querySelector('.gt-record-btn');
    this._scrubber = this.panel.querySelector('.gt-scrubber');
    this._speedSelect = this.panel.querySelector('.gt-speed-select');
    this._liveBadge = this.panel.querySelector('.gt-live-badge');
    this._stepBtns = this.panel.querySelectorAll('.gt-step-btn');

    // Populate speed options from TimeController
    const tc = this.engine.time;
    tc.speedOptions.forEach((speed, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      if (speed < 60) opt.textContent = `${speed}x`;
      else if (speed < 3600) opt.textContent = `${speed / 60}min/s`;
      else opt.textContent = `${speed / 3600}hr/s`;
      if (i === tc.speedIndex) opt.selected = true;
      this._speedSelect.appendChild(opt);
    });
    this._labels = this.panel.querySelector('.gt-time-labels');
    this._tooltip = this.panel.querySelector('.gt-scrub-tooltip');

    // Hide live-only controls in replay mode
    this._updateModeVisibility();
  }

  _bindEvents() {
    this._playBtn.addEventListener('click', () => {
      const playing = this.engine.togglePlay();
      this._playBtn.textContent = playing ? '⏸' : '▶';
    });

    this._recordBtn.addEventListener('click', () => {
      if (this._recording) {
        this._stopRecording();
      } else {
        this._startRecording();
      }
    });

    this._speedSelect.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value);
      const speed = this.engine.time.speedOptions[idx];
      this.engine.time.setSpeed(speed);
    });

    // ─── Epoch step buttons ───
    this._stepBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const dir = parseInt(btn.dataset.dir);
        this.engine.time.stepEpoch(dir);
        // Sync play/pause icon (stepEpoch may pause/resume)
        this._playBtn.textContent = this.engine.time.playing ? '⏸' : '▶';
      });
    });

    // ─── LIVE badge: snap to live edge ───
    this._liveBadge.addEventListener('click', () => {
      const tc = this.engine.time;
      if (tc.mode === 'live') {
        tc.isFollowingLive = true;
        tc._liveCurrentEpochIdx = tc._liveTotalEpochs - 1;
        tc.currentTime = tc._epochTime(tc._liveCurrentEpochIdx);
        tc.playing = true;
        this._playBtn.textContent = '⏸';
      }
    });

    // ─── Scrubber: drag freely, commit on release ───
    this._scrubber.addEventListener('pointerdown', () => {
      this.engine._userScrubbing = true;
      this._scrubTarget = null;
    });

    this._scrubber.addEventListener('input', (e) => {
      this._scrubTarget = e.target.value / 1000;
      this._updateTooltip(e.target.value / 1000);
    });

    window.addEventListener('pointerup', () => {
      if (this.engine._userScrubbing) {
        this.engine._userScrubbing = false;
        this._hideTooltip();
        if (this._scrubTarget !== null) {
          this.engine._scrubCommitTime = performance.now();
          this.engine.scrubTo(this._scrubWindowToData(this._scrubTarget));
          // Sync play/pause icon (scrubTo may pause playback)
          this._playBtn.textContent = this.engine.time.playing ? '⏸' : '▶';
          this._scrubTarget = null;
        }
      }
    });

    this._playBtn.textContent = '⏸';
  }

  /** Show/hide controls based on live vs replay mode. */
  _updateModeVisibility() {
    const isLive = this.engine.time.mode === 'live';
    this._liveBadge.style.display = isLive ? '' : 'none';
    // Speed select remains universally visible to allow accelerated scrubbing toward live edge
    this._speedSelect.style.display = '';
  }

  /**
   * Map a window-relative scrubber position (0..1) to the data-normalized value
   * expected by engine.scrubTo(). Identity when no animation window is active.
   * @param {number} n - Slider position in [0, 1]
   * @returns {number}
   */
  _scrubWindowToData(n) {
    const tc = this.engine.time;
    if (tc.mode === 'live' || tc._winStartRel == null || tc.duration <= 0) return n;
    const seconds = tc._winStartRel + n * (tc._winEndRel - tc._winStartRel);
    return seconds / tc.duration;
  }

  /**
   * Show tooltip above scrubber thumb with formatted time.
   * @param {number} normalized - Time in [0, 1]
   */
  _updateTooltip(normalized) {
    const tc = this.engine.time;
    let timeStr;
    if (tc.mode === 'live') {
      const epochIdx = Math.round(normalized * (tc.getTotalEpochs() - 1));
      const ts = tc._oldestTimeSec + epochIdx * tc.epochInterval;
      const d = new Date(ts * 1000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      timeStr = `${hh}:${mm} · Epoch ${epochIdx + 1}/${tc.getTotalEpochs()}`;
    } else {
      // Window active → slider maps across the window; otherwise across full duration.
      const secondsFromStart =
        tc._winStartRel != null
          ? tc._winStartRel + normalized * (tc._winEndRel - tc._winStartRel)
          : normalized * tc.duration;
      const totalSec = Math.floor(secondsFromStart) + tc.startHourUTC * 3600;
      const h = Math.floor(totalSec / 3600) % 24;
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    this._tooltip.textContent = timeStr;
    this._tooltip.style.display = 'block';
    this._tooltip.style.left = `${normalized * 100}%`;
  }

  _hideTooltip() {
    this._tooltip.style.display = 'none';
  }

  async _startRecording() {
    let stream;

    // Try full-app recording via Screen Capture API (captures entire tab)
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'browser', // prefer current tab
          frameRate: 30,
        },
        preferCurrentTab: true, // auto-select this tab (Chrome 109+)
        audio: false,
      });
    } catch (err) {
      // User cancelled picker or API unavailable — fall back to canvas-only
      console.warn('[Record] Tab capture denied, falling back to canvas-only');
      const canvas = this.engine.canvas;
      stream = canvas.captureStream(30);
    }

    // Determine best available codec
    const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    let mimeType = '';
    for (const mt of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mt)) {
        mimeType = mt;
        break;
      }
    }

    if (!mimeType) {
      console.warn('[Record] No supported video MIME type found');
      // Stop any getDisplayMedia tracks
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    this._chunks = [];
    this._mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });

    this._mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this._chunks.push(e.data);
    };

    this._mediaRecorder.onstop = () => {
      // Stop all tracks (important for getDisplayMedia to release the tab indicator)
      stream.getTracks().forEach((t) => t.stop());

      const blob = new Blob(this._chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);

      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `globe-trotter-${ts}.webm`;

      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      this._chunks = [];
      console.debug(`[Record] Saved ${(blob.size / 1e6).toFixed(1)} MB → ${filename}`);
    };

    // If user stops sharing mid-recording via browser UI, handle gracefully
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (this._recording) this._stopRecording();
    });

    this._mediaRecorder.start(1000);
    this._recording = true;
    this._recordBtn.classList.add('gt-recording');
    this._recordBtn.title = 'Stop Recording';

    // Ensure playback is running
    if (!this.engine.time.playing) {
      this.engine.togglePlay();
      this._playBtn.textContent = '⏸';
    }

    console.debug(`[Record] Started — ${mimeType}, 8 Mbps, 30 FPS (full-app)`);
  }

  _stopRecording() {
    if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
      this._mediaRecorder.stop();
    }
    this._recording = false;
    this._recordBtn.classList.remove('gt-recording');
    this._recordBtn.title = 'Record Video';
  }

  /**
   * Rebuild scrubber labels from TimeController epoch range.
   * In live mode: shows adaptive timestamps from oldest→liveEdge.
   * In replay mode: shows fixed hour ticks.
   */
  updateLabels() {
    const tc = this.engine.time;
    if (tc.mode === 'live' && tc.windowDuration > 0) {
      this._updateLiveLabels();
      return;
    }
    if (tc._winStartRel != null) {
      this._updateWindowLabels();
      return;
    }
    const durationHours = tc.duration / 3600;
    const startHour = tc.startHourUTC;
    const stepHours = Math.max(1, Math.round(durationHours / 4));
    const labels = [];
    for (let h = 0; h <= durationHours; h += stepHours) {
      const pct = (h / durationHours) * 100;
      const utcH = (startHour + h) % 24;
      labels.push(`<span style="left:${pct}%">${String(utcH).padStart(2, '0')}:00</span>`);
    }
    this._labels.innerHTML = labels.join('');
  }

  /**
   * Adaptive labels for live mode — show actual timestamps from the sliding window.
   */
  _updateLiveLabels() {
    const tc = this.engine.time;
    const oldest = tc._oldestTimeSec;
    const edge = tc._liveEdgeTimeSec;
    const dur = edge - oldest;
    if (dur <= 0) {
      this._labels.innerHTML = '';
      return;
    }

    // Pick a nice step: ~4 ticks across the window
    const stepSec = this._niceStep(dur / 4);
    const firstTick = Math.ceil(oldest / stepSec) * stepSec;
    const labels = [];
    for (let t = firstTick; t <= edge; t += stepSec) {
      const pct = ((t - oldest) / dur) * 100;
      const d = new Date(t * 1000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      labels.push(`<span style="left:${pct}%">${hh}:${mm}</span>`);
    }
    this._labels.innerHTML = labels.join('');
  }

  /**
   * Labels for an active animation window — ~4 timestamp ticks across [start, end].
   */
  _updateWindowLabels() {
    const tc = this.engine.time;
    const len = tc._winEndRel - tc._winStartRel;
    if (len <= 0) {
      this._labels.innerHTML = '';
      return;
    }

    const base = tc._dataStartSec();
    const startAbs = base + tc._winStartRel;
    const endAbs = base + tc._winEndRel;
    const stepSec = this._niceStep(len / 4);
    const firstTick = Math.ceil(startAbs / stepSec) * stepSec;
    const labels = [];
    for (let t = firstTick; t <= endAbs; t += stepSec) {
      const pct = ((t - startAbs) / len) * 100;
      const d = new Date(t * 1000);
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const mm = String(d.getUTCMinutes()).padStart(2, '0');
      labels.push(`<span style="left:${pct}%">${hh}:${mm}</span>`);
    }
    this._labels.innerHTML = labels.join('');
  }

  /** Pick a human-friendly step interval in seconds. */
  _niceStep(roughSec) {
    const nice = [60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];
    for (const s of nice) {
      if (s >= roughSec) return s;
    }
    return 14400;
  }

  /**
   * Update clock display, scrubber, and live badge. Called each frame.
   * @param {number} normalizedTime - Time in [0, 1]
   */
  update(normalizedTime) {
    const tc = this.engine.time;
    this._clock.textContent = tc.getFormatted();
    const dateStr = tc.getFormattedDate();
    if (this._dateEl.textContent !== dateStr) {
      this._dateEl.textContent = dateStr;
    }

    // Update epoch counter in live mode
    if (tc.mode === 'live') {
      const idx = tc.getEpochIndex() + 1; // 1-based for display
      const total = tc.getTotalEpochs();
      this._epochEl.textContent = `${idx}/${total}`;
      this._epochEl.style.display = '';
    } else {
      this._epochEl.style.display = 'none';
    }

    if (!this.engine._userScrubbing) {
      // With an active animation window the scrubber spans the window, not
      // the full dataset — use window-normalized position.
      const scrubNorm = tc._winStartRel != null ? tc.getWindowNormalized() : normalizedTime;
      this._scrubber.value = Math.round(scrubNorm * 1000);
    }

    // Update LIVE badge glow state
    if (tc.mode === 'live') {
      this._liveBadge.classList.toggle('gt-live-active', tc.isFollowingLive);
    }

    // Periodically refresh live labels (every ~2s)
    if (tc.mode === 'live') {
      const now = performance.now();
      if (!this._lastLabelUpdate || now - this._lastLabelUpdate > 2000) {
        this._lastLabelUpdate = now;
        this._updateLiveLabels();
        this._updateModeVisibility();
      }
    }
  }

  /** Show or hide the panel. */
  setVisible(visible) {
    this.panel.style.display = visible ? '' : 'none';
  }

  destroy() {
    if (this._recording) this._stopRecording();
    if (this.panel.parentNode) {
      this.panel.parentNode.removeChild(this.panel);
    }
  }
}
