// MercatorCameraController.js — 2D pan/zoom camera for the Web Mercator projection,
// with Phase-3 tilt support (right-drag to tilt, perspective view matrix).
//
// Sibling class to CameraController (the orbital globe camera). The engine swaps
// between the two when `projectionMode` changes. Phase 4 will unify both behind
// a strategy interface; for Phase 2 we keep them parallel and source-of-truth-
// independent so the spherical path is bit-identical to today.
//
// API parity with CameraController:
//   - constructor(canvas, { center: [lat, lon], altitude, tilt, heading })
//   - update() → { view, projection, position, lookPoint, tilt }
//   - flyTo(lat, lon, distance)
//   - resize()
//
// ─── Tilt model ─────────────────────────────────────────────────────────────
// Tilt is stored as an angle in radians, identical to CameraController.
// No projection-space translation is needed: tilt-as-angle is a projector-agnostic
// primitive. In spherical mode the camera orbits around a surface point on a 3D
// sphere; in Mercator it orbits around the same geographic point on a flat plane.
// The rotation axis (local East = screen X) is the same in both frames, and the
// angle means the same thing. The only difference is the coordinate system in
// which the view matrix is constructed — not the tilt value itself.
//
// When tilt = 0: view matrix = top-down orthographic-style (identity + translation).
// When tilt > 0: perspective camera positioned behind + above the look-at point,
//   tilted around the local X axis. Produces a Mapbox 3D-buildings style view.
//
// ─── Note on tile renderers ─────────────────────────────────────────────────
// MercatorTileRenderer(GPU) reads camera.lng/lat/zoom directly and builds its own
// 2D world-pixel projection — it does NOT use view/projection from this class.
// The view/projection matrices returned here are consumed by future 3D consumers
// (task #19: 2.5D extrusion) and any external code that branches on the camera
// matrices. The tile pipeline is unaffected.
//
// Pan sensitivity is corrected for tilt: when the camera is oblique, a pixel of
// drag should still "grab the ground" at the center lat/lon, so we scale
// horizontal panning by 1/cos(tilt) (foreshortening correction).

import * as mat4 from '../math/mat4.js';
import { altitudeToZoom, zoomToAltitude, EARTH_RADIUS_KM } from '../math/geo.js';

const TILE_PX = 256;
const MIN_ZOOM = 0;
const MAX_ZOOM = 22;
const MAX_LAT = 85.051129;

// Maximum tilt: 60° matches Mapbox's hard cap for 3D buildings mode.
const MAX_TILT_RAD = (60 * Math.PI) / 180;

// Tilt drag sensitivity: radians per pixel. Matches the feel of CameraController.
const TILT_DRAG_SENS = 0.005;

// Lerp factor for smooth tilt animation — same as CameraController.
const LERP = 0.15;

export class MercatorCameraController {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [options]
   * @param {[number, number]} [options.center=[39, -98]] - [lat, lon] in degrees
   * @param {number} [options.altitude=12000] - km above surface (converted to zoom)
   * @param {number} [options.tilt=0] - degrees; no projection-space translation needed
   * @param {number} [options.heading=0] - degrees (reserved; heading = 0 in Mercator always-north mode)
   * @param {boolean} [options.renderWorldCopies=false] - bound to a single world copy
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this._useZeroToOneZ = options.useZeroToOneZ === true;

    const center = options.center || [39.0, -98.0];
    const altKm = options.altitude ?? 12000;

    // Stored as separate [lng, lat] for the 2D math; pull from [lat, lon] tuple.
    this.lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, center[0]));
    this.lng = center[1];
    this.zoom = altitudeToZoom(altKm, this.lat);

    // ─── Tilt state ────────────────────────────────────────────────────────
    // Tilt is stored in radians, clamped to [0, MAX_TILT_RAD].
    // No translation from spherical values needed — the angle transfers directly.
    const tiltDeg = options.tilt ?? 0;
    this.tilt = Math.max(0, Math.min(MAX_TILT_RAD, tiltDeg * (Math.PI / 180)));
    this.targetTilt = this.tilt;

    // heading is north-up always in Mercator; we store it for round-trip parity
    // with CameraController but do not rotate the view around Z.
    this.heading = 0;
    this.targetHeading = 0;

    this.minZoom = options.minZoom ?? MIN_ZOOM;
    this.maxZoom = options.maxZoom ?? MAX_ZOOM;
    // Default ON: a web map shows continuous horizontal world copies. Callers
    // can pass renderWorldCopies:false to bound navigation to a single world.
    this.renderWorldCopies = options.renderWorldCopies ?? true;

    // Synthetic spherical-style fields so engine code reading these doesn't
    // crash in mercator mode. Distance is a stand-in (km altitude as
    // globe-radius units) for any path that branches on "how zoomed in".
    this.distance = 1.0 + altKm / EARTH_RADIUS_KM;

    // Output matrices — built in update(). Identity until first update() call.
    this.viewMatrix = mat4.create();
    this.projMatrix = mat4.create();
    this.cameraPosition = new Float32Array(3);
    this.lookPoint = new Float32Array(3);
    // Look-point set to the unit-sphere point under (lng, lat) — keeps
    // ShardedLoaders that compute great-circle distances functional.
    this._updateLookPoint();

    // ─── Drag state ────────────────────────────────────────────────────────
    this._dragging = false;
    this._tilting = false;
    this._lastX = 0;
    this._lastY = 0;
    this._lastMoveTime = 0;
    this._pointerId = null;
    this._velocityHistory = []; // for pan inertia (same pattern as CameraController)
    this.thetaVel = 0; // pan inertia — reuse CameraController field names so
    this.phiVel = 0; //   any external code that zero-checks them still works

    this._abortController = null;
    this._bindEvents();
  }

  // ─── Synthetic spherical state ─────────────────────────────────────────

  _updateLookPoint() {
    // Project (lng, lat) → unit-sphere ECEF for any spherical-frame consumer.
    const DEG2RAD = Math.PI / 180;
    const latRad = this.lat * DEG2RAD;
    const lonRad = this.lng * DEG2RAD;
    const cosLat = Math.cos(latRad);
    this.lookPoint[0] = cosLat * Math.sin(lonRad);
    this.lookPoint[1] = Math.sin(latRad);
    this.lookPoint[2] = cosLat * Math.cos(lonRad);

    // Camera position: elevated above look-point by tilt-adjusted distance.
    // For spherical consumers that only need a rough "where is the camera"
    // (e.g. LOD heuristics), the top-down approximation is fine.
    this.cameraPosition[0] = this.lookPoint[0] * this.distance;
    this.cameraPosition[1] = this.lookPoint[1] * this.distance;
    this.cameraPosition[2] = this.lookPoint[2] * this.distance;
  }

  // ─── View / projection matrix construction (new in Phase 3) ─────────────

  /**
   * Rebuild viewMatrix and projMatrix from current tilt + zoom.
   *
   * Coordinate system: the Mercator tile renderers work in world-pixel space
   * (2D). The view/projection matrices produced here are for *3D consumers*
   * (task #19 extrusion layer). We use a right-handed eye-space where:
   *   - X = right (East)
   *   - Y = up (screen up, North in top-down view)
   *   - Z = towards viewer (camera forward = -Z)
   *
   * Camera geometry (tilt > 0):
   *   - Look-at target = (0, 0, 0) in a local "screen-centred" 3D space.
   *   - Camera eye = (0, h·tan(tilt), h) where h = virtual camera height.
   *     (sits behind the target by sin(tilt)·h and above by cos(tilt)·h in
   *     the tilt-rotation sense; simplifies to eye along +Z rotated by tilt.)
   *   - Up vector = (0, 1, 0) — always screen-up (north-up).
   *
   * Virtual camera height h = halfH / tan(fovY/2) where halfH is the
   * viewport half-height in pixels. This gives a 1:1 pixel mapping at
   * tilt = 0, and correct perspective foreshortening at tilt > 0.
   *
   * The projection NDC produced by these matrices is NOT used by tile
   * renderers — they use their own world-pixel → NDC formula. These
   * matrices are provided for layer renderers (extrusion, vector) that
   * need a 3D projection.
   */
  _updateMatrices() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const aspect = w / h;

    // FoV: use 45° (π/4), same as CameraController.
    const fovY = Math.PI / 4;
    const tanHalfFov = Math.tan(fovY / 2);

    // Virtual camera height in world-pixel units: sized so that at tilt=0
    // the camera sees exactly the viewport without foreshortening.
    const worldSize = TILE_PX * Math.pow(2, this.zoom);
    const halfH_px = h / 2;
    const cameraH = halfH_px / tanHalfFov;

    // Camera distance from look-at along the tilted view axis.
    // eye = (0, sin(tilt)*cameraH, cos(tilt)*cameraH) in screen-XYZ.
    // We place the look-at at origin, so eye is offset.
    const sinT = Math.sin(this.tilt);
    const cosT = Math.cos(this.tilt);

    // eye offset from look-at (screen-space local frame):
    //   dx = 0 (no sideways offset — north-up, no heading)
    //   dy = sin(tilt) * cameraH  (moves "up" on screen = North)
    //   dz = cos(tilt) * cameraH  (moves towards viewer)
    //
    // Note: the tile renderer still computes its own 2D offset so this
    // does not change what tiles are visible — it only affects 3D consumers.
    const eyeY = sinT * cameraH;
    const eyeZ = cosT * cameraH;

    const eye = new Float32Array([0, eyeY, eyeZ]);
    const center = new Float32Array([0, 0, 0]);
    const up = new Float32Array([0, 1, 0]);
    mat4.lookAt(this.viewMatrix, eye, center, up);

    // Perspective projection: near/far chosen to bracket the camera range.
    const near = cameraH * 0.01;
    const far = cameraH * 10.0;
    const perspectiveFn = this._useZeroToOneZ ? mat4.perspectiveZO : mat4.perspective;
    perspectiveFn(this.projMatrix, fovY, aspect, near, far);

    // Unused worldSize — kept for future consumers that may need it.
    this._lastWorldSize = worldSize;
    this._lastCameraH = cameraH;
  }

  // ─── Pan sensitivity helpers ────────────────────────────────────────────

  /**
   * Pan the map by screen-pixel delta (dx, dy).
   *
   * When tilt > 0 the map is foreshortened: moving the mouse forward (up the
   * screen) should move the map point under the cursor, not the center. We
   * correct Y motion for perspective foreshortening so the ground moves with
   * the finger — matches Mapbox behaviour.
   *
   * Correction: at tilt θ the ground-plane Y distance per screen-pixel is
   *   1/cos(θ) × (1 pixel in world-pixel units).
   * X motion is unaffected (parallel to the view axis when heading=0).
   */
  pan(dx, dy) {
    // Pointer deltas arrive in CSS px; the world is in device px.
    const dpr = this._dpr();
    const scale = TILE_PX * Math.pow(2, this.zoom);
    const dLng = ((dx * dpr) / scale) * 360;

    // Foreshortening correction for tilt: forward drag (dy) covers more
    // ground as the camera tilts. At tilt=0 the factor is 1 (no change).
    const cosT = Math.max(0.1, Math.cos(this.tilt)); // clamp avoids div/0 near 90°
    const effectiveDy = (dy * dpr) / cosT;

    const sinLat = Math.sin((this.lat * Math.PI) / 180);
    const mercatorY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    const newMercatorY = mercatorY - effectiveDy;
    const n = Math.PI - (2 * Math.PI * newMercatorY) / scale;
    const newLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));

    this.lng = this.lng - dLng;
    this.lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, newLat));

    this._clampState();
    this._updateLookPoint();
  }

  // ─── Pan / zoom / clamp (moved from PanZoomCamera) ─────────────────────

  /** Device pixels per CSS pixel — reconciles CSS-px pointer input with the
   *  device-px world space the renderer draws in (worldSize = 256·2^zoom). */
  _dpr() {
    const cw = this.canvas.clientWidth || 0;
    return cw > 0 ? (this.canvas.width || cw) / cw : 1;
  }

  /** Viewport width/height in device pixels (the render's world-pixel unit). */
  _vpW() {
    return this.canvas.width || (this.canvas.clientWidth || 0) * this._dpr();
  }
  _vpH() {
    return this.canvas.height || (this.canvas.clientHeight || 0) * this._dpr();
  }

  /**
   * Compute the minimum zoom at which the world fills the viewport, so the map
   * never shrinks smaller than the viewport (which would show void). In
   * single-world mode both axes must be filled; with world copies the X axis
   * is continuous, so only the viewport HEIGHT constrains min zoom.
   * Uses device pixels to match the renderer's world-pixel scale (DPR-correct).
   */
  _effectiveMinZoom() {
    const w = this._vpW();
    const h = this._vpH();
    if (w > 0 && h > 0) {
      const dim = this.renderWorldCopies ? h : Math.max(w, h);
      const dynamicMin = Math.log2(dim / TILE_PX);
      return Math.max(this.minZoom, dynamicMin);
    }
    return this.minZoom;
  }

  _clampState() {
    const effectiveMin = this._effectiveMinZoom();
    this.zoom = Math.max(effectiveMin, Math.min(this.maxZoom, this.zoom));

    const worldSize = TILE_PX * Math.pow(2, this.zoom);
    const halfH = this._vpH() / 2;

    // Latitude clamp always applies (prevents scrolling off top/bottom edge)
    const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, this.lat));
    const sinLat = Math.sin((clampedLat * Math.PI) / 180);
    const centerY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;
    const minCenterY = halfH;
    const maxCenterY = worldSize - halfH;

    let newLat = clampedLat;
    if (minCenterY > maxCenterY) {
      newLat = 0;
    } else {
      const clampedCenterY = Math.max(minCenterY, Math.min(maxCenterY, centerY));
      if (clampedCenterY !== centerY) {
        const n = Math.PI - (2 * Math.PI * clampedCenterY) / worldSize;
        newLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
        newLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, newLat));
      }
    }
    this.lat = newLat;

    // Longitude clamp only in single-world mode
    if (this.renderWorldCopies) return;
    const halfW = this._vpW() / 2;
    const halfLngDeg = (halfW / worldSize) * 360;
    if (halfLngDeg >= 180) {
      this.lng = 0;
    } else {
      this.lng = Math.max(-180 + halfLngDeg, Math.min(180 - halfLngDeg, this.lng));
    }
  }

  zoom_by(delta, around) {
    const oldZoom = this.zoom;
    const newZoom = Math.max(this._effectiveMinZoom(), Math.min(this.maxZoom, oldZoom + delta));
    if (newZoom === oldZoom) return;

    if (around != null) {
      // Zoom-to-cursor: keep the geo point under `around` fixed on screen.
      const oldScale = TILE_PX * Math.pow(2, oldZoom);
      const newScale = TILE_PX * Math.pow(2, newZoom);

      const sinLat = Math.sin((this.lat * Math.PI) / 180);
      const centerX = ((this.lng + 180) / 360) * oldScale;
      const centerY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * oldScale;

      // `around` is CSS px; convert to device px to match world scale.
      const dpr = this._dpr();
      const halfW = this._vpW() / 2;
      const halfH = this._vpH() / 2;
      const offX = around.x * dpr - halfW;
      const offY = around.y * dpr - halfH;

      const cursorWorldX = centerX + offX;
      const cursorWorldY = centerY + offY;
      const ratio = newScale / oldScale;
      const newCenterX = cursorWorldX * ratio - offX;
      const newCenterY = cursorWorldY * ratio - offY;

      const newLng = (newCenterX / newScale) * 360 - 180;
      const n = Math.PI - (2 * Math.PI * newCenterY) / newScale;
      const newLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));

      this.zoom = newZoom;
      this.lng = newLng;
      this.lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, newLat));
    } else {
      this.zoom = newZoom;
    }

    this._clampState();

    // Keep synthetic spherical `distance` in sync so consumers reading it
    // (tile-selection LOD heuristics, etc.) see a consistent altitude.
    const altKm = zoomToAltitude(this.zoom, this.lat);
    this.distance = 1.0 + altKm / EARTH_RADIUS_KM;

    this._updateLookPoint();
  }

  /**
   * Project a lat/lon/altitude point to canvas pixel coordinates — the inverse
   * of screenToLngLat. Required by CPU screen-space picking (GFBPointAdapter),
   * which early-returns null if the camera has no project(). Mirrors the
   * spherical CameraController.project() signature and return shape.
   *
   * Altitude is ignored (the flat Mercator map has no elevation). For
   * world-copies mode the point is projected into the world copy nearest the
   * viewport centre so the on-screen instance is the one that gets picked.
   *
   * @param {number} lat      degrees
   * @param {number} lon      degrees
   * @param {number} _altFeet altitude in feet (ignored in Mercator)
   * @param {number} w        canvas CSS width  (matches screenToLngLat units)
   * @param {number} h        canvas CSS height
   * @returns {{ sx: number, sy: number, visible: boolean }}
   */
  project(lat, lon, _altFeet, w, h) {
    const worldSize = TILE_PX * Math.pow(2, this.zoom);
    const clampedLat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const sinLat = Math.sin((clampedLat * Math.PI) / 180);
    const worldX = ((lon + 180) / 360) * worldSize;
    const worldY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;

    const camSinLat = Math.sin((this.lat * Math.PI) / 180);
    const centerWX = ((this.lng + 180) / 360) * worldSize;
    const centerWY =
      (0.5 - Math.log((1 + camSinLat) / (1 - camSinLat)) / (4 * Math.PI)) * worldSize;

    // Wrap X into the world copy nearest the camera centre so points near the
    // antimeridian (and world copies) project onto their on-screen instance.
    let dx = worldX - centerWX;
    dx -= Math.round(dx / worldSize) * worldSize;

    // World offsets are device px; screen output is CSS px (w/h are CSS).
    const dpr = this._dpr();
    return {
      sx: dx / dpr + w / 2,
      sy: (worldY - centerWY) / dpr + h / 2,
      visible: true,
    };
  }

  /**
   * Convert a screen position (CSS pixels) to [lng, lat].
   * Used by acetate footers and hit-testing.
   */
  screenToLngLat(sx, sy) {
    const w = this.canvas.clientWidth || 0;
    const h = this.canvas.clientHeight || 0;
    const worldSize = TILE_PX * Math.pow(2, this.zoom);

    const sinLat = Math.sin((this.lat * Math.PI) / 180);
    const centerWX = ((this.lng + 180) / 360) * worldSize;
    const centerWY = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;

    // sx/sy are CSS px; the world is device px — scale the offset by DPR.
    const dpr = this._dpr();
    const dx = (sx - w / 2) * dpr;
    const dy = (sy - h / 2) * dpr;
    const wx = centerWX + dx;
    const wy = centerWY + dy;

    const lng = (wx / worldSize) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * wy) / worldSize;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));

    return { lng, lat: Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) };
  }

  /**
   * Compatibility shim for callers (AcetateFooter, hit-test overlays) that
   * were written against the spherical CameraController's _screenToGlobe.
   * Returns the same {theta, phi} radians shape so consumers don't need to
   * branch on projection mode. sx/sy/w/h are in physical (device) pixels.
   */
  _screenToGlobe(sx, sy, w, _h) {
    const cssW = this.canvas.clientWidth || w;
    const dpr = w > 0 && cssW > 0 ? w / cssW : 1;
    const { lng, lat } = this.screenToLngLat(sx / dpr, sy / dpr);
    const DEG2RAD = Math.PI / 180;
    return { theta: (lng + 180) * DEG2RAD, phi: lat * DEG2RAD };
  }

  // ─── Event handling ────────────────────────────────────────────────────

  _bindEvents() {
    const c = this.canvas;
    const controller = new AbortController();
    const { signal } = controller;

    c.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });

    // ─── Pointer down — distinguish pan (left) vs tilt (right/middle) ───
    c.addEventListener(
      'pointerdown',
      (e) => {
        this._lastX = e.clientX;
        this._lastY = e.clientY;
        this._lastMoveTime = performance.now();

        if (e.button === 2 || e.button === 1) {
          // Right-click or middle-click: tilt mode (mirrors CameraController)
          this._tilting = true;
          this._dragging = false;
          this._pointerId = e.pointerId;
          try {
            c.setPointerCapture(e.pointerId);
          } catch {
            /* not supported */
          }
        } else {
          // Left-click: pan mode
          this._dragging = true;
          this._tilting = false;
          this._pointerId = e.pointerId;
          this.thetaVel = 0;
          this.phiVel = 0;
          this._velocityHistory = [];
          try {
            c.setPointerCapture(e.pointerId);
          } catch {
            /* not supported */
          }
        }
      },
      { signal }
    );

    c.addEventListener(
      'pointermove',
      (e) => {
        const dx = e.clientX - this._lastX;
        const dy = e.clientY - this._lastY;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
        this._lastMoveTime = performance.now();

        if (this._dragging) {
          // ─── Pan: left-drag ───
          this.pan(dx, dy);

          // Track velocity for swipe inertia (keep last 3 moves).
          // Store raw pixel deltas so update() can call pan(thetaVel, phiVel)
          // directly — avoids duplicating the lat/lng conversion formulas.
          this._velocityHistory.push({ dx, dy, time: performance.now() });
          if (this._velocityHistory.length > 3) this._velocityHistory.shift();
        } else if (this._tilting) {
          // ─── Tilt: right-drag vertical ───
          // Vertical drag tilts the camera (down = more tilt, up = less tilt).
          // Matches CameraController: targetTilt -= dy * 0.005.
          this.targetTilt -= dy * TILT_DRAG_SENS;
          this.targetTilt = Math.max(0, Math.min(MAX_TILT_RAD, this.targetTilt));
          // Horizontal drag is ignored (heading is always north-up in Mercator).
        }
      },
      { signal }
    );

    const endDrag = () => {
      if (this._dragging) {
        // Apply pan inertia on fast swipe (matches CameraController logic)
        const timeSinceLastMove = performance.now() - this._lastMoveTime;
        const history = this._velocityHistory;
        if (timeSinceLastMove < 80 && history.length >= 2) {
          let avgDx = 0,
            avgDy = 0;
          for (const h of history) {
            avgDx += h.dx;
            avgDy += h.dy;
          }
          avgDx /= history.length;
          avgDy /= history.length;
          const speed = Math.sqrt(avgDx * avgDx + avgDy * avgDy);
          if (speed > 0.5) {
            // Store pixel velocities — pan() will be called in update()
            this.thetaVel = avgDx;
            this.phiVel = avgDy;
          } else {
            this.thetaVel = 0;
            this.phiVel = 0;
          }
        } else {
          this.thetaVel = 0;
          this.phiVel = 0;
        }
        this._velocityHistory = [];
      }

      this._dragging = false;
      this._tilting = false;
      if (this._pointerId != null) {
        try {
          c.releasePointerCapture(this._pointerId);
        } catch {
          /* ignore */
        }
        this._pointerId = null;
      }
    };
    c.addEventListener('pointerup', endDrag, { signal });
    c.addEventListener('pointercancel', endDrag, { signal });

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        // deltaMode 1 = LINE; normalize to pixels.
        const rawDelta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const delta = -rawDelta * 0.01;
        this.zoom_by(delta, { x, y });
      },
      { signal, passive: false }
    );

    // Double-click: reset tilt to 0 (mirrors CameraController dblclick behaviour)
    c.addEventListener(
      'dblclick',
      (e) => {
        if (this.tilt > 0.01) {
          this.targetTilt = 0;
          e.preventDefault();
        }
      },
      { signal }
    );

    window.addEventListener('resize', () => this.resize(), { signal });

    this._abortController = controller;
  }

  // ─── Main update loop ──────────────────────────────────────────────────

  /**
   * Returns the same {view, projection, position, lookPoint, tilt} shape as
   * CameraController so the engine render loop can treat both uniformly.
   *
   * Phase 3: tilt lerp + inertia + view/projection matrix construction.
   * The tile renderers read camera.lng/lat/zoom directly so the matrices
   * here are consumed by future 3D layer renderers only.
   */
  update() {
    // ─── Lerp tilt ────────────────────────────────────────────────────
    this.tilt += (this.targetTilt - this.tilt) * LERP;
    if (Math.abs(this.tilt - this.targetTilt) < 0.001) this.tilt = this.targetTilt;

    // ─── Pan inertia ──────────────────────────────────────────────────
    // thetaVel/phiVel are raw pixel deltas from the last swipe. Call pan()
    // directly so the foreshortening correction and Mercator math are applied
    // identically to interactive drags — no formula duplication.
    if (!this._dragging && (Math.abs(this.thetaVel) > 0.5 || Math.abs(this.phiVel) > 0.5)) {
      this.pan(this.thetaVel, this.phiVel);

      // Decay inertia — 0.92 feels snappier than spherical, matching the
      // lighter "flat map" feel of a 2D pan.
      const damping = 0.92;
      this.thetaVel *= damping;
      this.phiVel *= damping;
      if (Math.abs(this.thetaVel) < 0.5) this.thetaVel = 0;
      if (Math.abs(this.phiVel) < 0.5) this.phiVel = 0;
    }

    // ─── Rebuild 3D view / projection matrices ───────────────────────
    this._updateMatrices();

    return {
      view: this.viewMatrix,
      projection: this.projMatrix,
      position: this.cameraPosition,
      lookPoint: this.lookPoint,
      tilt: this.tilt,
    };
  }

  /**
   * API-parity flyTo. `distance` is treated as globe-radius units
   * (matching CameraController) and converted to a Mercator zoom level.
   */
  flyTo(lat, lon, distance = 1.05) {
    this.lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    this.lng = lon;
    const altKm = Math.max(distance - 1.0, 0.00001) * EARTH_RADIUS_KM;
    this.zoom = Math.max(
      this._effectiveMinZoom(),
      Math.min(this.maxZoom, altitudeToZoom(altKm, this.lat))
    );
    this.distance = 1.0 + altKm / EARTH_RADIUS_KM;
    this._clampState();
    this._updateLookPoint();
  }

  resize() {
    this._clampState();
    this._updateLookPoint();
  }

  /** Detach all DOM event listeners. */
  detach() {
    this._abortController?.abort();
    this._abortController = null;
  }
}
