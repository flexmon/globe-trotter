// TimeController.js — Simulation time management with playback controls

export class TimeController {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.enabled=true] - false = static map, no animation
   * @param {boolean} [options.autoplay=true] - start playing on load
   * @param {number} [options.speed=60] - playback multiplier
   * @param {number} [options.startOffset=0] - seconds from data start
   * @param {boolean} [options.loop=true] - wrap around at end
   * @param {'replay'|'live'} [options.mode='replay'] - time mode
   */
  constructor(options = {}) {
    const {
      enabled = true,
      autoplay = true,
      mode = 'replay',
      startOffset = 0,
      loop = true,
    } = options;

    const isLiveMode = mode === 'live' || options.live === true;

    // Default playback speed: Live targets 1x, Replay targets 60x (1min/sec)
    const speed = options.speed ?? (isLiveMode ? 1 : 60);

    // Simulation spans 24 hours (overridden by setEpochRange)
    this.duration = 24 * 60 * 60;
    this.currentTime = startOffset;
    this.speed = speed;
    this.playing = enabled && autoplay;
    this.enabled = enabled;
    this.loop = loop;
    this.startHourUTC = 0;
    this.startDate = options.startDate || null; // ISO date string or Date
    this.speedOptions = [1, 10, 30, 60, 120, 300, 600, 1800];
    const idx = this.speedOptions.indexOf(this.speed);
    this.speedIndex = idx >= 0 ? idx : 3;

    // ─── Live mode fields ───
    this.mode = mode; // 'replay' | 'live'
    this.isFollowingLive = true; // Playhead tracks live edge
    this.liveEdgeEpoch = 0; // Latest available epoch
    this.oldestEpoch = 0; // Oldest epoch in ring buffer
    this.epochInterval = 60; // Seconds per epoch (from manifest)
    this.windowDuration = 0; // Total window in seconds (from TTL)
    this._liveEdgeTimeSec = 0; // Live edge in seconds (UNIX)
    this._oldestTimeSec = 0; // Oldest epoch in seconds (UNIX)
    this._liveTotalEpochs = 0; // Maximum epochs in window (TTL/epochInterval)
    this._liveCurrentEpochIdx = 0; // Current epoch index (0 = oldest)

    // ─── Animation window (replay only) ───
    // Host-supplied playback window in ABSOLUTE UNIX seconds. When active, replay
    // playback loops within [start, end] and the UI scrubber represents this range.
    // Renderers are unaffected: getNormalized() stays data-normalized so epoch
    // selection still spans the full dataset.
    this._windowStartSec = null; // absolute UNIX sec, or null when no window
    this._windowEndSec = null;
    this._winStartRel = null; // derived: seconds-from-data-start, or null if not yet derivable
    this._winEndRel = null;

    // ─── Clock source (who drives the playhead) ───
    //   'internal' → this controller self-advances (play/pause/scrub/window)
    //   'external' → host owns the clock; self-advance OFF, playhead set via pushEpoch()
    //   'live'     → follows the data live edge (live mode)
    this.clockSource = isLiveMode ? 'live' : 'internal';
  }

  update() {
    if (!this.enabled || !this.playing) return this.getNormalized();
    // External clock: the host owns the playhead (via pushEpoch); never self-advance.
    if (this.clockSource === 'external') return this.getNormalized();

    const now = performance.now() / 1000;
    let dt = now - this._lastRealTime;
    this._lastRealTime = now;
    dt = Math.min(dt, 0.1); // 100ms max jump

    // ─── Live mode ───
    if (this.mode === 'live') {
      if (this.isFollowingLive) {
        // Snap to the latest epoch (start-of-epoch position)
        this._liveCurrentEpochIdx = this._liveTotalEpochs - 1;
        this.currentTime = this._epochTime(this._liveCurrentEpochIdx);
        return this.getNormalized();
      }

      // Animate catch-up using playback speed!
      this.currentTime += dt * this.speed;

      // Clamp and lock when we reach the live edge
      if (this.currentTime >= this._liveEdgeTimeSec) {
        this.currentTime = this._liveEdgeTimeSec;
        this.isFollowingLive = true; // Dynamically snap back natively
      }

      // Re-calculate the epoch index based on the animated playhead
      this._liveCurrentEpochIdx = Math.round(
        (this.currentTime - this._oldestTimeSec) / this.epochInterval
      );
      this._liveCurrentEpochIdx = Math.max(
        0,
        Math.min(this._liveCurrentEpochIdx, this._liveTotalEpochs - 1)
      );

      return this.getNormalized();
    }

    // ─── Replay mode (existing behavior) ───
    this.currentTime += dt * this.speed;

    // Active animation window: always loop within [winStart, winEnd].
    if (this._winStartRel != null) {
      this.currentTime = this._wrapWindow(this.currentTime);
      return this.getNormalized();
    }

    // Wrap or clamp at end
    if (this.currentTime >= this.duration) {
      if (this.loop) {
        this.currentTime -= this.duration;
      } else {
        this.currentTime = this.duration;
        this.playing = false;
      }
    }

    return this.getNormalized();
  }

  /**
   * Get normalized time [0, 1] representing position within the time range.
   * In live mode: maps over the sliding window [oldest, liveEdge].
   * In replay mode: maps over the fixed duration.
   */
  getNormalized() {
    if (this.mode === 'live') {
      if (this._liveTotalEpochs <= 1) return 1;
      return this._liveCurrentEpochIdx / (this._liveTotalEpochs - 1);
    }
    if (this.duration <= 0) return 0;
    return this.currentTime / this.duration;
  }

  /**
   * Set an animation window (replay only). Playback loops between the two
   * absolute-UNIX-second bounds and the UI scrubber represents this range.
   * No-op in live mode or when start >= end.
   * @param {number} startEpochSec - Window start, absolute UNIX seconds
   * @param {number} endEpochSec - Window end, absolute UNIX seconds
   */
  setWindow(startEpochSec, endEpochSec) {
    if (this.mode === 'live') {
      console.warn('[TimeController] setWindow ignored in live mode');
      return;
    }
    if (!(endEpochSec > startEpochSec)) {
      console.warn(
        `[TimeController] setWindow ignored: start (${startEpochSec}) >= end (${endEpochSec})`
      );
      return;
    }
    this._windowStartSec = startEpochSec;
    this._windowEndSec = endEpochSec;
    this._deriveWindowBounds();
  }

  /** Clear the animation window and return to the full-dataset timeline. */
  clearWindow() {
    this._windowStartSec = null;
    this._windowEndSec = null;
    this._winStartRel = null;
    this._winEndRel = null;
  }

  /**
   * Get the active animation window in absolute UNIX seconds, or null if none set.
   * @returns {{ startEpochSec: number, endEpochSec: number } | null}
   */
  getWindow() {
    if (this._windowStartSec == null) return null;
    return { startEpochSec: this._windowStartSec, endEpochSec: this._windowEndSec };
  }

  /**
   * Normalized position [0,1] within the active window, for the UI scrubber only.
   * Falls back to getNormalized() (data-normalized) when no window is active or
   * the window is not yet derivable (data not loaded).
   */
  getWindowNormalized() {
    if (this._winStartRel == null) return this.getNormalized();
    const len = this._winEndRel - this._winStartRel;
    if (len <= 0) return 0;
    return (this.currentTime - this._winStartRel) / len;
  }

  /**
   * Derive internal seconds-from-data-start window bounds from the stored absolute
   * bounds, clamping to [0, duration]. Deactivates the window (rel bounds null) when
   * the data start isn't known yet or the clamped window is empty. Called by
   * setWindow() and re-run from setEpochRange() once epoch metadata arrives.
   */
  _deriveWindowBounds() {
    if (this._windowStartSec == null) {
      this._winStartRel = null;
      this._winEndRel = null;
      return;
    }
    const base = this._dataStartSec();
    const s = Math.max(0, Math.min(this._windowStartSec - base, this.duration));
    const e = Math.max(0, Math.min(this._windowEndSec - base, this.duration));
    if (e <= s) {
      // Not derivable yet (data unloaded) or window fully outside the dataset.
      this._winStartRel = null;
      this._winEndRel = null;
      return;
    }
    this._winStartRel = s;
    this._winEndRel = e;
    // Snap the playhead inside the window.
    this.currentTime = Math.max(s, Math.min(this.currentTime, e));
  }

  /** Data start as absolute UNIX seconds (matches getCurrentEpoch's base), or 0. */
  _dataStartSec() {
    if (this.startDate instanceof Date) return Math.floor(this.startDate.getTime() / 1000);
    if (typeof this.startDate === 'string') {
      return Math.floor(new Date(this.startDate + 'T00:00:00Z').getTime() / 1000);
    }
    return 0;
  }

  /** Wrap a seconds-from-start value into the active window via modulo (loops both ways). */
  _wrapWindow(t) {
    const len = this._winEndRel - this._winStartRel;
    if (len <= 0) return this._winStartRel;
    let rel = (t - this._winStartRel) % len;
    if (rel < 0) rel += len;
    return this._winStartRel + rel;
  }

  /**
   * Get current time as hours (0-24).
   */
  getHours() {
    return this.currentTime / 3600;
  }

  /**
   * Get formatted time string HH:MM:SS (offset by startHourUTC)
   */
  getFormatted() {
    if (this.mode === 'live') {
      // In live mode, show full date + time UTC
      const d = new Date(this.currentTime * 1000);
      const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ];
      const mon = months[d.getUTCMonth()];
      const day = d.getUTCDate();
      const h = String(d.getUTCHours()).padStart(2, '0');
      const m = String(d.getUTCMinutes()).padStart(2, '0');
      const s = String(d.getUTCSeconds()).padStart(2, '0');
      return `${mon} ${day} ${h}:${m}:${s}`;
    }
    const totalSec = Math.floor(this.currentTime) + this.startHourUTC * 3600;
    const h = Math.floor(totalSec / 3600) % 24;
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Get formatted date string for the current simulation time.
   * Rolls the date forward as simulation crosses midnight boundaries.
   * @returns {string} e.g. "Mon, Mar 04" or "" if no startDate configured
   */
  getFormattedDate() {
    if (this.mode === 'live') {
      // In live mode, use UNIX timestamp to get actual date
      const d = new Date(this.currentTime * 1000);
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ];
      return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    if (!this.startDate) return '';
    const base =
      this.startDate instanceof Date ? this.startDate : new Date(this.startDate + 'T00:00:00Z');
    // Total seconds from the base date's midnight
    const totalSec = Math.floor(this.currentTime) + this.startHourUTC * 3600;
    const dayOffset = Math.floor(totalSec / 86400);
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  /** Start playback. */
  play() {
    this.setPlaying(true);
  }

  /** Pause playback. */
  pause() {
    this.setPlaying(false);
  }

  togglePlay() {
    if (this.clockSource === 'external') return this.playing; // host-driven: no-op
    this.playing = !this.playing;
    if (this.playing) {
      this._lastRealTime = performance.now() / 1000;
    }
    return this.playing;
  }

  setPlaying(playing) {
    if (this.clockSource === 'external') return; // host-driven: play/pause are no-ops
    this.playing = playing;
    if (playing) {
      this._lastRealTime = performance.now() / 1000;
    }
  }

  /**
   * Select who drives the playhead.
   * - `'internal'` — this controller self-advances (play/pause/scrub/window).
   * - `'external'` — host owns the clock; self-advance is off and play/pause are
   *   no-ops. Set the playhead with {@link pushEpoch}.
   * - `'live'` — follow the data live edge (live mode).
   * @param {'internal'|'external'|'live'} source
   */
  setClockSource(source) {
    if (source !== 'internal' && source !== 'external' && source !== 'live') {
      console.warn(`[TimeController] unknown clock source: ${source}`);
      return;
    }
    if (source === 'live') {
      this.mode = 'live';
      this.isFollowingLive = true;
    } else if (source === 'internal') {
      if (this.mode === 'live') {
        this.mode = 'replay';
        this.isFollowingLive = false;
      }
    } else {
      // external
      this.playing = false;
    }
    this.clockSource = source;
  }

  /**
   * Push an absolute playhead position (UNIX seconds) from the host. Valid only
   * when the clock source is `'external'`; ignored otherwise. Lossless — writes
   * the absolute epoch directly without a normalized round-trip.
   * @param {number} epochSec
   */
  pushEpoch(epochSec) {
    if (this.clockSource !== 'external') {
      console.warn('[TimeController] pushEpoch ignored: clock source is not "external"');
      return;
    }
    this._setAbsoluteEpoch(epochSec);
  }

  /**
   * Set the playhead to an absolute UNIX timestamp (seconds), losslessly.
   * Unlike scrubbing, this writes the absolute epoch directly (no 0..1
   * round-trip), so getCurrentEpoch() reads back exactly what was set.
   * @param {number} epochSec
   */
  setEpoch(epochSec) {
    this._setAbsoluteEpoch(epochSec);
  }

  /**
   * Write the playhead from an absolute epoch, clamped to the data range (and
   * to the active animation window, if any). The single lossless write path
   * shared by setEpoch()/pushEpoch().
   * @param {number} epochSec
   * @private
   */
  _setAbsoluteEpoch(epochSec) {
    if (this.mode === 'live') {
      this.currentTime = epochSec;
      if (this.epochInterval > 0) {
        const idx = Math.round((epochSec - this._oldestTimeSec) / this.epochInterval);
        this._liveCurrentEpochIdx = Math.max(0, Math.min(idx, this._liveTotalEpochs - 1));
      }
    } else {
      let rel = epochSec - this._dataStartSec();
      rel = Math.max(0, Math.min(rel, this.duration));
      if (this._winStartRel != null) {
        rel = Math.max(this._winStartRel, Math.min(rel, this._winEndRel));
      }
      this.currentTime = rel;
    }
    this._lastRealTime = performance.now() / 1000;
  }

  /**
   * Suspend time controller (tab hidden).
   * Records playing state and pauses — call resume() when tab returns.
   */
  suspend() {
    this._wasPlaying = this.playing;
    this.playing = false;
    this._suspended = true;
  }

  /**
   * Resume time controller (tab visible).
   * Resets _lastRealTime to discard background elapsed time,
   * preventing catch-up bursts. Restores previous playing state.
   */
  resume() {
    this._lastRealTime = performance.now() / 1000;
    this._suspended = false;
    if (this._wasPlaying) {
      this.playing = true;
    }
  }

  /**
   * Scrub to a normalized position [0, 1]. When a replay animation window is
   * active, clamp the target to that window instead of wrapping.
   */
  scrubTo(normalized) {
    normalized = Math.max(0, Math.min(Number.isFinite(normalized) ? normalized : 0, 1));
    if (this.mode === 'live') {
      // Map slider position to epoch index
      const epochIdx = Math.round(normalized * (this._liveTotalEpochs - 1));
      this._liveCurrentEpochIdx = Math.max(0, Math.min(epochIdx, this._liveTotalEpochs - 1));
      this.currentTime = this._oldestTimeSec + this._liveCurrentEpochIdx * this.epochInterval;
      const atEdge = this._liveCurrentEpochIdx >= this._liveTotalEpochs - 1;
      this.isFollowingLive = atEdge;
      this.playing = atEdge;
    } else {
      let rel = normalized * this.duration;
      if (this._winStartRel != null) {
        rel = Math.max(this._winStartRel, Math.min(rel, this._winEndRel));
      }
      this.currentTime = rel;
    }
    this._lastRealTime = performance.now() / 1000;
  }

  /**
   * Step forward or backward by one epoch.
   * In live mode: pauses playback so the position holds. Click LIVE to snap back.
   * @param {number} direction - +1 for forward, -1 for backward
   */
  stepEpoch(direction) {
    if (this.mode === 'live') {
      const newIdx = this._liveCurrentEpochIdx + direction;
      this._liveCurrentEpochIdx = Math.max(0, Math.min(newIdx, this._liveTotalEpochs - 1));
      this.currentTime = this._oldestTimeSec + this._liveCurrentEpochIdx * this.epochInterval;
      const atEdge = this._liveCurrentEpochIdx >= this._liveTotalEpochs - 1;
      this.isFollowingLive = atEdge;
      this.playing = atEdge;
    } else {
      const step = direction * this.epochInterval;
      this.currentTime = Math.max(0, Math.min(this.currentTime + step, this.duration));
    }
    this._lastRealTime = performance.now() / 1000;
  }

  cycleSpeed() {
    this.speedIndex = (this.speedIndex + 1) % this.speedOptions.length;
    this.speed = this.speedOptions[this.speedIndex];
    return this.speed;
  }

  getSpeedLabel() {
    const s = this.speed;
    if (s < 60) return `${s}x`;
    if (s < 3600) return `${s / 60}min/s`;
    return `${s / 3600}hr/s`;
  }

  setSpeed(speed) {
    this.speed = speed;
    const idx = this.speedOptions.indexOf(speed);
    if (idx >= 0) this.speedIndex = idx;
  }

  /**
   * Set duration from loaded layer epoch metadata.
   * @param {number} epochCount - Number of epochs
   * @param {number} intervalSec - Seconds per epoch
   * @param {number} [startHourUTC=0] - Hour of day (0-23) for the first epoch
   * @param {number} [startTimestamp] - Unix epoch seconds for the first epoch (from manifest)
   */
  setEpochRange(epochCount, intervalSec, startHourUTC = 0, startTimestamp = null) {
    if (Number.isNaN(startHourUTC) || startHourUTC === null || startHourUTC === undefined)
      startHourUTC = 0;
    if (Number.isNaN(startTimestamp) || startTimestamp === null || startTimestamp === undefined)
      startTimestamp = null;

    this.epochInterval = intervalSec;
    this.startHourUTC = startHourUTC;
    this.duration = (epochCount - 1) * intervalSec;

    if (Number.isNaN(this.currentTime)) {
      this.currentTime = 0;
    }

    // Derive startDate from manifest timestamp (data-driven, not config-driven)
    // Only set if not already overridden by YAML config
    if (startTimestamp != null && !this.startDate) {
      this.startDate = new Date(startTimestamp * 1000);
    }

    // Clamp current time if it exceeds new duration
    if (this.currentTime >= this.duration) {
      this.currentTime = 0;
    }

    // Re-derive any pending/active animation window now that the data start and
    // duration are known (a window may have been set before data loaded).
    this._deriveWindowBounds();

    console.debug(
      `[TimeController] Duration set to ${this.duration}s (${epochCount} epochs × ${intervalSec}s, start ${startHourUTC}:00 UTC${this.startDate ? ', date=' + this.getFormattedDate() : ''})`
    );
  }

  /**
   * Advance the live edge (called by streaming loaders when new data arrives).
   * Updates the sliding window timestamps and recalculates epoch index.
   * @param {number} liveEdgeTimestamp - UNIX timestamp of live edge (seconds)
   * @param {number} oldestTimestamp - UNIX timestamp of oldest data (seconds)
   * @param {number} totalEpochs - Total epochs currently loaded in ring
   */
  advanceLiveEdge(liveEdgeTimestamp, oldestTimestamp, totalEpochs) {
    const prevEdge = this._liveEdgeTimeSec;
    this._liveEdgeTimeSec = liveEdgeTimestamp;
    this._oldestTimeSec =
      this.windowDuration > 0
        ? liveEdgeTimestamp - this.windowDuration
        : Number.isFinite(oldestTimestamp)
          ? oldestTimestamp
          : liveEdgeTimestamp;

    const configuredEpochs =
      this.epochInterval > 0 && this.windowDuration > 0
        ? Math.max(1, Math.round(this.windowDuration / this.epochInterval))
        : 0;
    const loadedEpochs = totalEpochs > 0 ? totalEpochs : 0;
    this._liveTotalEpochs = Math.max(
      configuredEpochs,
      loadedEpochs,
      Math.max(1, Math.round((liveEdgeTimestamp - this._oldestTimeSec) / this.epochInterval))
    );

    // If following live AND we own the clock, snap to the latest epoch.
    // When clockSource is 'external' the host drives the playhead via pushEpoch(),
    // so we must not overwrite currentTime here — just keep the epoch index
    // consistent with whatever the host last set.
    if (this.isFollowingLive && this.clockSource !== 'external') {
      this._liveCurrentEpochIdx = this._liveTotalEpochs - 1;
      this.currentTime = this._epochTime(this._liveCurrentEpochIdx);
    } else if (prevEdge > 0) {
      // Window slid forward (or host owns the clock) — keep epoch index
      // pointing at the same absolute time by recalculating from currentTime.
      this._liveCurrentEpochIdx = Math.round(
        (this.currentTime - this._oldestTimeSec) / this.epochInterval
      );
      this._liveCurrentEpochIdx = Math.max(
        0,
        Math.min(this._liveCurrentEpochIdx, this._liveTotalEpochs - 1)
      );
    }

    console.debug(
      `[TimeController] Live edge: liveEdge=${new Date(liveEdgeTimestamp * 1000).toISOString()}, ` +
        `oldestTimeSec=${this._oldestTimeSec} (${new Date(this._oldestTimeSec * 1000).toISOString()}), ` +
        `windowDur=${this.windowDuration}s, totalEpochs=${this._liveTotalEpochs}, ` +
        `currentIdx=${this._liveCurrentEpochIdx}, ` +
        `currentTime=${this.currentTime} (${new Date(this.currentTime * 1000).toISOString()})`
    );
  }

  /**
   * Enter live mode with manifest-driven window parameters.
   * @param {number} [ttlSeconds=3600] - Total window duration from manifest TTL
   * @param {number} [epochIntervalSec=60] - Seconds per epoch from manifest
   */
  setLiveMode(ttlSeconds = 3600, epochIntervalSec = 60) {
    this.mode = 'live';
    this.clockSource = 'live';
    this.isFollowingLive = true;
    this.speed = 1;
    this.playing = true;
    this.epochInterval = epochIntervalSec;
    this.windowDuration = ttlSeconds;
    this._liveTotalEpochs = Math.round(ttlSeconds / epochIntervalSec);
    this._liveCurrentEpochIdx = this._liveTotalEpochs - 1;
    this._lastRealTime = performance.now() / 1000;
    console.debug(
      `[TimeController] LIVE mode: ${ttlSeconds}s TTL, ` +
        `${epochIntervalSec}s/epoch, ${this._liveTotalEpochs} epochs`
    );
  }

  /**
   * Return to replay mode.
   */
  setReplayMode() {
    this.mode = 'replay';
    this.clockSource = 'internal';
    this.isFollowingLive = false;
    console.debug(`[TimeController] Switched to REPLAY mode`);
  }

  /**
   * Toggle follow-live in live mode.
   * If not following, scrubbing/rewinding is allowed.
   * If following, playhead snaps to live edge.
   */
  toggleFollowLive() {
    if (this.mode !== 'live') return;
    this.isFollowingLive = !this.isFollowingLive;
    if (this.isFollowingLive) {
      this._liveCurrentEpochIdx = this._liveTotalEpochs - 1;
      this.currentTime = this._epochTime(this._liveCurrentEpochIdx);
      this.playing = true;
    }
    return this.isFollowingLive;
  }

  /**
   * Compute the UNIX timestamp for the START of a given epoch index.
   * @param {number} idx - 0-based epoch index
   * @returns {number} UNIX seconds
   */
  _epochTime(idx) {
    return this._oldestTimeSec + idx * this.epochInterval;
  }

  /**
   * Get current absolute epoch timestamp (UNIX seconds).
   * In live mode: returns this.currentTime.
   * In replay mode: returns this.currentTime + startTimestamp.
   */
  getCurrentEpoch() {
    if (this.mode === 'live') return Math.floor(this.currentTime);

    const base = this.startDate instanceof Date ? Math.floor(this.startDate.getTime() / 1000) : 0; // Fallback if no start date
    return Math.floor(base + this.currentTime);
  }

  /**
   * Get current epoch index (0 = oldest in window).
   */
  getEpochIndex() {
    return this._liveCurrentEpochIdx;
  }

  /**
   * Get total epoch count in the live window.
   */
  getTotalEpochs() {
    return this._liveTotalEpochs;
  }

  /**
   * Get human-readable duration label.
   */
  getDurationLabel() {
    const mins = Math.round(this.duration / 60);
    if (mins < 60) return `${mins}min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs}h${rem}m` : `${hrs}h`;
  }
}
