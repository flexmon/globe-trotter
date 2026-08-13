/**
 * TimeController.test.mjs — Characterization tests for playback + epoch math (B-3d).
 * Avoids update() (which needs frame timing); covers the deterministic surface.
 * Run: node --test src/time/TimeController.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { TimeController } from './TimeController.js';

describe('TimeController — construction defaults', () => {
  it('replay mode defaults: speed 60, autoplay, 24h duration', () => {
    const tc = new TimeController();
    assert.equal(tc.mode, 'replay');
    assert.equal(tc.speed, 60);
    assert.equal(tc.playing, true);
    assert.equal(tc.duration, 24 * 60 * 60);
  });
  it('live mode defaults speed to 1', () => {
    assert.equal(new TimeController({ mode: 'live' }).speed, 1);
  });
  it('autoplay:false and enabled:false both yield not-playing', () => {
    assert.equal(new TimeController({ autoplay: false }).playing, false);
    assert.equal(new TimeController({ enabled: false }).playing, false);
  });
});

describe('TimeController.setEpochRange', () => {
  it('sets duration = (epochCount − 1) × interval', () => {
    const tc = new TimeController();
    tc.setEpochRange(10, 60);
    assert.equal(tc.duration, 540);
    assert.equal(tc.epochInterval, 60);
  });
  it('coerces NaN startHourUTC to 0', () => {
    const tc = new TimeController();
    tc.setEpochRange(10, 60, NaN);
    assert.equal(tc.startHourUTC, 0);
  });
});

describe('TimeController — replay normalized time + scrub', () => {
  it('getNormalized = currentTime / duration', () => {
    const tc = new TimeController();
    tc.setEpochRange(10, 60); // duration 540
    tc.scrubTo(0.5);
    assert.equal(tc.currentTime, 270);
    assert.equal(tc.getNormalized(), 0.5);
  });
  it('scrub endpoints map to 0 and duration', () => {
    const tc = new TimeController();
    tc.setEpochRange(10, 60);
    tc.scrubTo(0);
    assert.equal(tc.currentTime, 0);
    tc.scrubTo(1);
    assert.equal(tc.currentTime, 540);
    assert.equal(tc.getNormalized(), 1);
  });
});

describe('TimeController — speed controls', () => {
  it('setSpeed updates speed', () => {
    const tc = new TimeController();
    tc.setSpeed(120);
    assert.equal(tc.speed, 120);
  });
  it('cycleSpeed advances through speedOptions', () => {
    const tc = new TimeController(); // default speed 60 → index 3
    assert.equal(tc.cycleSpeed(), 120); // next option
  });
  it('getSpeedLabel formats sub-minute / min / hour rates', () => {
    const tc = new TimeController();
    tc.setSpeed(1);
    assert.equal(tc.getSpeedLabel(), '1x');
    tc.setSpeed(60);
    assert.equal(tc.getSpeedLabel(), '1min/s');
    tc.setSpeed(300);
    assert.equal(tc.getSpeedLabel(), '5min/s');
    tc.setSpeed(3600);
    assert.equal(tc.getSpeedLabel(), '1hr/s');
  });
});

describe('TimeController.getDurationLabel', () => {
  it('formats minutes / hours / hours+minutes', () => {
    const tc = new TimeController();
    tc.setEpochRange(10, 60);
    assert.equal(tc.getDurationLabel(), '9min'); // 540s
    tc.setEpochRange(61, 60);
    assert.equal(tc.getDurationLabel(), '1h'); // 3600s
    tc.setEpochRange(91, 60);
    assert.equal(tc.getDurationLabel(), '1h30m'); // 5400s
  });
});

describe('TimeController — replay stepEpoch clamps to [0, duration]', () => {
  it('steps forward/backward by one interval and clamps', () => {
    const tc = new TimeController();
    tc.setEpochRange(10, 60); // duration 540, interval 60
    tc.currentTime = 120;
    tc.stepEpoch(1);
    assert.equal(tc.currentTime, 180);
    tc.stepEpoch(-1);
    tc.stepEpoch(-1);
    tc.stepEpoch(-1);
    tc.stepEpoch(-1);
    assert.equal(tc.currentTime, 0); // clamped at lower bound
  });
});

describe('TimeController — animation window (start/end epoch)', () => {
  // Helper: replay controller with a known data start (UNIX 1_000_000) and 540s duration.
  const withData = () => {
    const tc = new TimeController();
    tc.setEpochRange(10, 60, 0, 1_000_000); // duration 540, startDate = 1_000_000s, base 1_000_000
    return tc;
  };

  it('setWindow stores absolute bounds and clamps currentTime into range', () => {
    const tc = withData();
    tc.currentTime = 400; // rel 400, past the window end
    tc.setWindow(1_000_120, 1_000_300); // rel [120, 300]
    assert.deepEqual(tc.getWindow(), { startEpochSec: 1_000_120, endEpochSec: 1_000_300 });
    assert.equal(tc.currentTime, 300); // clamped to window end
  });

  it('getNormalized stays data-normalized (currentTime / duration) under a window', () => {
    const tc = withData();
    tc.setWindow(1_000_120, 1_000_300);
    tc.currentTime = 300;
    assert.ok(Math.abs(tc.getNormalized() - 300 / 540) < 1e-9); // NOT window-relative
  });

  it('getWindowNormalized spans 0..1 across the window', () => {
    const tc = withData();
    tc.setWindow(1_000_120, 1_000_300); // rel [120, 300], len 180
    tc.currentTime = 120;
    assert.equal(tc.getWindowNormalized(), 0);
    tc.currentTime = 210;
    assert.equal(tc.getWindowNormalized(), 0.5);
    tc.currentTime = 300;
    assert.equal(tc.getWindowNormalized(), 1);
  });

  it('_wrapWindow loops the playhead within the bounds (both directions)', () => {
    const tc = withData();
    tc.setWindow(1_000_120, 1_000_300); // rel [120, 300], len 180
    assert.equal(tc._wrapWindow(330), 150); // 30 past end wraps to start+30
    assert.equal(tc._wrapWindow(90), 270); // 30 before start wraps to end−30
  });

  it('window set before data loads is applied on setEpochRange', () => {
    const tc = new TimeController();
    tc.setWindow(1_000_120, 1_000_300); // no startDate yet → inactive
    assert.equal(tc.getWindowNormalized(), tc.getNormalized()); // falls back
    tc.setEpochRange(10, 60, 0, 1_000_000); // now derivable → active, clamps to start
    assert.equal(tc.currentTime, 120);
    assert.equal(tc.getWindowNormalized(), 0);
  });

  it('start >= end is a no-op', () => {
    const tc = withData();
    tc.setWindow(1_000_300, 1_000_300);
    assert.equal(tc.getWindow(), null);
  });

  it('clearWindow reverts to the full-dataset timeline', () => {
    const tc = withData();
    tc.setWindow(1_000_120, 1_000_300);
    tc.clearWindow();
    assert.equal(tc.getWindow(), null);
    tc.currentTime = 270;
    assert.equal(tc.getWindowNormalized(), tc.getNormalized()); // back to data-normalized
  });

  it('setWindow is ignored in live mode', () => {
    const tc = new TimeController({ mode: 'live' });
    tc.setLiveMode(3600, 60);
    tc.setWindow(1_000_120, 1_000_300);
    assert.equal(tc.getWindow(), null);
  });
});

describe('TimeController — clock sources + lossless epoch', () => {
  const withData = () => {
    const tc = new TimeController();
    tc.setEpochRange(10, 60, 0, 1_000_000); // duration 540, base 1_000_000
    return tc;
  };

  it('defaults clockSource to internal', () => {
    assert.equal(new TimeController().clockSource, 'internal');
  });

  it('setClockSource("external") stops playback and makes play() a no-op', () => {
    const tc = withData();
    tc.setClockSource('external');
    assert.equal(tc.clockSource, 'external');
    assert.equal(tc.playing, false);
    tc.play();
    assert.equal(tc.playing, false); // no-op in external
  });

  it('update() never self-advances in external mode', () => {
    const tc = withData();
    tc.setClockSource('external');
    tc.currentTime = 100;
    tc.playing = true; // force past the playing gate
    tc._lastRealTime = 0; // would be a large dt if it advanced
    tc.update();
    assert.equal(tc.currentTime, 100);
  });

  it('pushEpoch sets the playhead losslessly in external mode', () => {
    const tc = withData();
    tc.setClockSource('external');
    tc.pushEpoch(1_000_120); // 120s into the data
    assert.equal(tc.currentTime, 120);
    assert.equal(tc.getCurrentEpoch(), 1_000_120); // round-trips exactly
  });

  it('pushEpoch clamps to the data range', () => {
    const tc = withData();
    tc.setClockSource('external');
    tc.pushEpoch(999_000);
    assert.equal(tc.currentTime, 0); // before start
    tc.pushEpoch(2_000_000);
    assert.equal(tc.currentTime, 540); // after end
  });

  it('pushEpoch is ignored when clockSource is not external', () => {
    const tc = withData();
    tc.currentTime = 200;
    tc.pushEpoch(1_000_120); // internal → ignored
    assert.equal(tc.currentTime, 200);
  });

  it('setEpoch writes absolute epoch with no normalized round-trip', () => {
    const tc = withData();
    tc.setEpoch(1_000_137);
    assert.equal(tc.getCurrentEpoch(), 1_000_137);
  });

  it('setClockSource("internal") restores playback control', () => {
    const tc = withData();
    tc.setClockSource('external');
    tc.setClockSource('internal');
    tc.play();
    assert.equal(tc.playing, true);
  });

  it('setClockSource("live") switches to live + follow-edge', () => {
    const tc = withData();
    tc.setClockSource('live');
    assert.equal(tc.clockSource, 'live');
    assert.equal(tc.mode, 'live');
    assert.equal(tc.isFollowingLive, true);
  });
});

describe('TimeController — live mode', () => {
  it('setLiveMode configures window + epoch count', () => {
    const tc = new TimeController({ mode: 'live' });
    tc.setLiveMode(3600, 60);
    assert.equal(tc.mode, 'live');
    assert.equal(tc.speed, 1);
    assert.equal(tc.getTotalEpochs(), 60);
    assert.equal(tc.getNormalized(), 1); // at live edge (idx 59 / 59)
  });
  it('scrubTo maps to an epoch index and drops follow-live off the edge', () => {
    const tc = new TimeController({ mode: 'live' });
    tc.setLiveMode(3600, 60);
    tc.scrubTo(0.5);
    assert.equal(tc.getEpochIndex(), 30); // round(0.5 × 59)
    assert.equal(tc.isFollowingLive, false);
  });
  it('advanceLiveEdge snaps to start-of-latest-epoch when following', () => {
    const tc = new TimeController({ mode: 'live' });
    tc.setLiveMode(3600, 60); // windowDuration 3600, 60 epochs
    tc.advanceLiveEdge(10000, 0, 0);
    assert.equal(tc.getEpochIndex(), 59);
    // currentTime = oldest(6400) + 59×60 = 9940  (= liveEdge − one interval)
    assert.equal(tc.currentTime, 9940);
  });
  it('advanceLiveEdge preserves the configured window when only latest shard is loaded', () => {
    const tc = new TimeController({ mode: 'live' });
    tc.setLiveMode(7200, 60);
    tc.advanceLiveEdge(10_000, 9_940, 1);

    assert.equal(tc.getTotalEpochs(), 120);
    assert.equal(tc.getEpochIndex(), 119);
    assert.equal(tc.currentTime, 9_940);
  });
  it('advanceLiveEdge preserves host-controlled playhead in external clock mode', () => {
    const tc = new TimeController({ mode: 'live' });
    tc.setLiveMode(3600, 60);
    tc.advanceLiveEdge(10_000, 6_400, 60);
    tc.setClockSource('external');
    tc.pushEpoch(9_700);

    tc.advanceLiveEdge(10_060, 6_460, tc.getTotalEpochs());

    assert.equal(tc.clockSource, 'external');
    assert.equal(tc.currentTime, 9_700);
    assert.equal(tc.getCurrentEpoch(), 9_700);
    assert.equal(tc.getEpochIndex(), 54);
  });
  it('setReplayMode exits live + follow', () => {
    const tc = new TimeController({ mode: 'live' });
    tc.setLiveMode(3600, 60);
    tc.setReplayMode();
    assert.equal(tc.mode, 'replay');
    assert.equal(tc.isFollowingLive, false);
  });
});
