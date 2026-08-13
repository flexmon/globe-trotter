// tests/timeController.test.js — Unit tests for TimeController
import { TimeController } from '../src/time/TimeController.js';

// Mock performance.now for deterministic tests
let mockNow = 0;
const originalPerformance = global.performance;

beforeEach(() => {
  mockNow = 0;
  global.performance = {
    now: () => mockNow,
  };
});

afterEach(() => {
  global.performance = originalPerformance;
});

describe('TimeController', () => {
  test('initial state is playing at 60x speed', () => {
    const tc = new TimeController();
    expect(tc.playing).toBe(true);
    expect(tc.speed).toBe(60);
    expect(tc.currentTime).toBe(0);
  });

  test('getNormalized returns value in [0, 1]', () => {
    const tc = new TimeController();
    expect(tc.getNormalized()).toBeGreaterThanOrEqual(0);
    expect(tc.getNormalized()).toBeLessThanOrEqual(1);
  });

  test('time advances based on speed multiplier', () => {
    const tc = new TimeController();
    tc.speed = 100; // 100 sim seconds per real second

    // Simulate 50ms passing (under the 100ms dt cap)
    mockNow = 0;
    tc._lastRealTime = 0;
    mockNow = 50; // 50ms later
    tc.update();

    // 0.05s × 100 speed = 5 sim seconds
    expect(tc.currentTime).toBeCloseTo(5, 0);
  });

  test('pause stops time advancement', () => {
    const tc = new TimeController();
    tc.currentTime = 1000;
    tc.setPlaying(false);

    mockNow = 0;
    tc._lastRealTime = 0;
    mockNow = 5000;
    tc.update();

    expect(tc.currentTime).toBe(1000); // Should not have changed
  });

  test('togglePlay switches between play and pause', () => {
    const tc = new TimeController();
    expect(tc.playing).toBe(true);

    tc.togglePlay();
    expect(tc.playing).toBe(false);

    tc.togglePlay();
    expect(tc.playing).toBe(true);
  });

  test('scrubTo sets time directly', () => {
    const tc = new TimeController();
    tc.scrubTo(0.5); // Midpoint of 24h

    expect(tc.currentTime).toBeCloseTo(12 * 3600, 0); // 12 hours
    expect(tc.getNormalized()).toBeCloseTo(0.5, 5);
  });

  test('time wraps at 24h boundary', () => {
    const tc = new TimeController();
    tc.currentTime = 24 * 3600 - 50; // Near end of day
    tc.speed = 100;

    mockNow = 0;
    tc._lastRealTime = 0;
    mockNow = 1000; // 1 second
    tc.update();

    // Should have wrapped
    expect(tc.currentTime).toBeLessThan(24 * 3600);
    expect(tc.currentTime).toBeGreaterThanOrEqual(0);
  });

  test('getHours returns correct hour value', () => {
    const tc = new TimeController();
    tc.currentTime = 6 * 3600; // 6 AM
    expect(tc.getHours()).toBeCloseTo(6, 5);

    tc.currentTime = 18 * 3600; // 6 PM
    expect(tc.getHours()).toBeCloseTo(18, 5);
  });

  test('getFormatted returns HH:MM:SS string', () => {
    const tc = new TimeController();
    tc.currentTime = 3661; // 1 hour, 1 minute, 1 second
    expect(tc.getFormatted()).toBe('01:01:01');

    tc.currentTime = 0;
    expect(tc.getFormatted()).toBe('00:00:00');

    tc.currentTime = 23 * 3600 + 59 * 60 + 59;
    expect(tc.getFormatted()).toBe('23:59:59');
  });

  test('cycleSpeed cycles through speed options', () => {
    const tc = new TimeController();
    const speeds = [];
    for (let i = 0; i < tc.speedOptions.length; i++) {
      speeds.push(tc.cycleSpeed());
    }

    // Starting at index 3 (60x), each cycle increments index
    // So we get speeds at indices 4,5,6,7,0,1,2,3
    const allSpeeds = new Set(speeds);
    expect(allSpeeds.size).toBe(tc.speedOptions.length);
    for (const s of tc.speedOptions) {
      expect(allSpeeds.has(s)).toBe(true);
    }
  });

  test('getSpeedLabel returns human-readable label', () => {
    const tc = new TimeController();
    tc.speed = 1;
    expect(tc.getSpeedLabel()).toBe('1x');

    tc.speed = 60;
    expect(tc.getSpeedLabel()).toBe('1min/s');

    tc.speed = 3600;
    expect(tc.getSpeedLabel()).toBe('1hr/s');
  });

  test('setSpeed updates speed and index', () => {
    const tc = new TimeController();
    tc.setSpeed(300);
    expect(tc.speed).toBe(300);
  });

  test('duration is 24 hours in seconds', () => {
    const tc = new TimeController();
    expect(tc.duration).toBe(86400);
  });

  describe('live mode', () => {
    test('setLiveMode switches mode and configures window', () => {
      const tc = new TimeController();
      tc.setLiveMode(3600, 60);

      expect(tc.mode).toBe('live');
      expect(tc.epochInterval).toBe(60);
      expect(tc.windowDuration).toBe(3600);
      expect(tc._liveTotalEpochs).toBe(60); // 3600/60
      expect(tc.isFollowingLive).toBe(true);
      expect(tc.playing).toBe(true);
      expect(tc.speed).toBe(1);
    });

    test('advanceLiveEdge updates liveEdge and snaps to latest when following', () => {
      const tc = new TimeController();
      tc.setLiveMode(3600, 60);

      const liveEdge = 1_700_000_000;
      const oldest = liveEdge - 3600;
      const totalEpochs = 60;

      tc.advanceLiveEdge(liveEdge, oldest, totalEpochs);

      expect(tc._liveEdgeTimeSec).toBe(liveEdge);
      // isFollowingLive → snap to last epoch
      expect(tc._liveCurrentEpochIdx).toBe(tc._liveTotalEpochs - 1);
    });

    test('advanceLiveEdge does not snap when not following live', () => {
      const tc = new TimeController();
      tc.setLiveMode(3600, 60);

      const liveEdge = 1_700_000_000;
      tc.advanceLiveEdge(liveEdge, liveEdge - 3600, 60);

      // Scrub to middle — clears isFollowingLive
      tc.scrubTo(0.5);
      expect(tc.isFollowingLive).toBe(false);

      const prevIdx = tc._liveCurrentEpochIdx;

      // Advance the edge further
      const newLiveEdge = liveEdge + 60;
      tc.advanceLiveEdge(newLiveEdge, newLiveEdge - 3600, 60);

      // Should NOT have snapped to the new end
      expect(tc._liveCurrentEpochIdx).not.toBe(tc._liveTotalEpochs - 1);
      // Index should stay near where we scrubbed (recalculated from same absolute time)
      expect(tc._liveCurrentEpochIdx).toBeGreaterThanOrEqual(0);
    });

    test('getNormalized in live mode maps epoch index over window', () => {
      const tc = new TimeController();
      tc.setLiveMode(3600, 60);
      const liveEdge = 1_700_000_000;
      tc.advanceLiveEdge(liveEdge, liveEdge - 3600, 60);

      // isFollowingLive → at last index → normalized = 1
      expect(tc.getNormalized()).toBeCloseTo(1, 5);
    });

    test('stepEpoch moves epoch index and clears followLive', () => {
      const tc = new TimeController();
      tc.setLiveMode(3600, 60);
      const liveEdge = 1_700_000_000;
      tc.advanceLiveEdge(liveEdge, liveEdge - 3600, 60);

      const startIdx = tc._liveCurrentEpochIdx; // = _liveTotalEpochs - 1
      tc.stepEpoch(-1);

      expect(tc._liveCurrentEpochIdx).toBe(startIdx - 1);
      expect(tc.isFollowingLive).toBe(false);
    });

    test('toggleFollowLive re-snaps to live edge', () => {
      const tc = new TimeController();
      tc.setLiveMode(3600, 60);
      const liveEdge = 1_700_000_000;
      tc.advanceLiveEdge(liveEdge, liveEdge - 3600, 60);

      tc.stepEpoch(-5);
      expect(tc.isFollowingLive).toBe(false);

      tc.toggleFollowLive();
      expect(tc.isFollowingLive).toBe(true);
      expect(tc._liveCurrentEpochIdx).toBe(tc._liveTotalEpochs - 1);
    });

    test('suspend pauses and resume restores playback', () => {
      const tc = new TimeController();
      expect(tc.playing).toBe(true);

      tc.suspend();
      expect(tc.playing).toBe(false);
      expect(tc._suspended).toBe(true);

      tc.resume();
      expect(tc.playing).toBe(true);
      expect(tc._suspended).toBe(false);
    });

    test('setReplayMode switches mode back to replay', () => {
      const tc = new TimeController();
      tc.setLiveMode(3600, 60);
      expect(tc.mode).toBe('live');

      tc.setReplayMode();
      expect(tc.mode).toBe('replay');
    });

    test('getCurrentEpoch in live mode returns floor of currentTime', () => {
      const tc = new TimeController();
      tc.setLiveMode(3600, 60);
      tc.currentTime = 1_700_000_123.7;

      expect(tc.getCurrentEpoch()).toBe(1_700_000_123);
    });

    test('getFormattedDate in live mode returns UTC date string', () => {
      const tc = new TimeController();
      tc.setLiveMode(3600, 60);
      // 2024-01-15 12:00:00 UTC
      tc.currentTime = new Date('2024-01-15T12:00:00Z').getTime() / 1000;

      const formatted = tc.getFormattedDate();
      expect(formatted).toMatch(/Jan/);
      expect(formatted).toMatch(/15/);
    });
  });
});
