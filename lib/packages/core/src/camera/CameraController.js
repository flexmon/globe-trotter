// CameraController.js — Orbital camera with tilt, smooth inertia, and surface navigation
import * as mat4 from '../math/mat4.js';
import { projectToScreen } from '../math/globeGeo.js';

const DEG2RAD_CAM = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;

export class CameraController {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [options]
   * @param {number[]} [options.center=[39,-98]] - [lat, lon] in degrees
   * @param {number} [options.altitude=12000] - km above surface
   * @param {number} [options.tilt=0] - degrees (0=nadir, 85=oblique)
   * @param {number} [options.heading=0] - degrees clockwise from north
   * @param {boolean} [options.useZeroToOneZ=false] - Use NDC z range [0, 1] (WebGPU) instead of [-1, 1] (WebGL2).
   *   When unset, WebGPU near-plane fragments at NDC z<0 get clipped — visible as small foreground geometry that
   *   only appears when rotated past the silhouette.
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this._useZeroToOneZ = options.useZeroToOneZ === true;

    // Resolve initial camera state from options (defaults to US-centered)
    const center = options.center || [39.0, -98.0];
    const altKm = options.altitude ?? 12000;
    const tiltDeg = options.tilt ?? 0;
    const headingDeg = options.heading ?? 0;

    // Convert lat/lon to spherical coordinates
    this.theta = (center[1] + 180) * DEG2RAD_CAM; // lon → theta (match geodetic convention)
    this.phi = center[0] * DEG2RAD_CAM; // lat → phi
    this.distance = 1.0 + altKm / EARTH_RADIUS_KM; // km → globe-radius units

    // Smooth animation targets
    this.targetDistance = this.distance;
    this.targetTheta = this.theta;
    this.targetPhi = this.phi;

    // Tilt (camera pitch — 0 = top-down, maxTilt = nearly horizontal)
    this.tilt = tiltDeg * DEG2RAD_CAM;
    this.targetTilt = this.tilt;

    // Heading offset for helicopter-style orbit (added to theta when tilted)
    this.heading = headingDeg * DEG2RAD_CAM;
    this.targetHeading = this.heading;

    // Inertia
    this.thetaVel = 0;
    this.phiVel = 0;
    this._velocityHistory = []; // track recent move velocities for swipe detection

    // Limits
    // minDist floor: below ~13,000 ft the camera gets within ~4 tile-widths of the
    // TILE_RADIUS=1.0001 shell; polygonOffset(-1,-8) then shifts fragments past the
    // near clip plane and the tile layer disappears. 13k ft keeps a safe margin.
    this.minDist = 1.000622; // ~13,000 feet altitude
    this.maxDist = 2.91; // ~40M feet — full globe visible, avoids depth z-fighting
    this.maxPhi = Math.PI / 2 - 0.01;
    this.maxTilt = Math.PI / 2 - 0.05; // ~85 degrees — nearly horizontal

    // Clamp initial distance to valid range (YAML configs may exceed maxDist)
    this.distance = Math.min(this.distance, this.maxDist);
    this.targetDistance = this.distance;

    // State
    this.isDragging = false;
    this.isTilting = false;
    this.lastX = 0;
    this.lastY = 0;

    // Output matrices
    this.viewMatrix = mat4.create();
    this.projMatrix = mat4.create();
    this.cameraPosition = new Float32Array(3);
    this.lookPoint = new Float32Array(3);

    // Pre-allocated scratch for lookAt (eliminates per-frame typed array allocs)
    this._lookAtTarget = new Float32Array(3);
    this._lookAtUp = new Float32Array(3);

    // Projection cache (skip recalc when distance + aspect unchanged)
    this._lastProjDist = -1;
    this._lastProjAspect = -1;

    this._bindEvents();
    this._updateProjection();
  }

  /**
   * Pan sensitivity: proportional to altitude so each pixel of drag always
   * moves the same fraction of the visible ground.
   */
  _orbitSensitivity() {
    const alt = Math.max(this.distance - 1.0, 0.00001);
    return Math.max(0.004 * alt, 0.0000005);
  }

  /**
   * Damping: smoother at close zoom, snappier at globe level.
   */
  _damping() {
    const alt = Math.max(this.distance - 1.0, 0.00001);
    return 0.9 + 0.06 * (1.0 - Math.min(alt / 3.0, 1.0));
  }

  /**
   * Compute the spherical (theta, phi) coordinates of the point on the
   * unit globe that lies under screen pixel (sx, sy).
   */
  _screenToGlobe(sx, sy, w, h) {
    const vm = this.viewMatrix;
    const right = [vm[0], vm[4], vm[8]];
    const up = [vm[1], vm[5], vm[9]];
    const fwd = [-vm[2], -vm[6], -vm[10]];

    const ndcX = (sx / w) * 2 - 1;
    const ndcY = 1 - (sy / h) * 2;

    const aspect = w / h;
    const fovScale = Math.tan(Math.PI / 8);
    const dirX = fwd[0] + ndcX * aspect * fovScale * right[0] + ndcY * fovScale * up[0];
    const dirY = fwd[1] + ndcX * aspect * fovScale * right[1] + ndcY * fovScale * up[1];
    const dirZ = fwd[2] + ndcX * aspect * fovScale * right[2] + ndcY * fovScale * up[2];

    const ox = this.cameraPosition[0];
    const oy = this.cameraPosition[1];
    const oz = this.cameraPosition[2];

    const a = dirX * dirX + dirY * dirY + dirZ * dirZ;
    const b = 2 * (ox * dirX + oy * dirY + oz * dirZ);
    const c = ox * ox + oy * oy + oz * oz - 1.0;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;

    const t = (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0) return null;

    const hx = ox + t * dirX;
    const hy = oy + t * dirY;
    const hz = oz + t * dirZ;

    return {
      theta: Math.atan2(hx, hz),
      phi: Math.asin(Math.max(-1, Math.min(1, hy))),
    };
  }

  /**
   * Project a lat/lon/altitude point to canvas pixel coordinates — the inverse
   * of _screenToGlobe. Uses the current view/projection matrices so the result
   * matches what the GPU renders. Required by CPU screen-space picking.
   * @param {number} lat        degrees
   * @param {number} lon        degrees
   * @param {number} altFeet    altitude in feet
   * @param {number} w          canvas CSS width  (must match the render aspect)
   * @param {number} h          canvas CSS height
   * @returns {{ sx: number, sy: number, visible: boolean }}
   */
  project(lat, lon, altFeet, w, h) {
    return projectToScreen(lat, lon, altFeet, {
      viewMatrix: this.viewMatrix,
      projMatrix: this.projMatrix,
      cameraPosition: this.cameraPosition,
      width: w,
      height: h,
    });
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // --- Mouse drag ---
    c.addEventListener('mousedown', (e) => {
      if (e.button === 2 || e.button === 1) {
        // Right-click or middle-click: tilt + heading orbit
        this.isTilting = true;
      } else {
        this.isDragging = true;
      }
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.thetaVel = 0;
      this.phiVel = 0;
    });

    window.addEventListener('mousemove', (e) => {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this._lastMoveTime = performance.now();

      if (this.isDragging) {
        const sens = this._orbitSensitivity();
        let dTheta, dPhi;

        if (this.tilt > 0.05) {
          // ─── Oblique panning ("grab the map" metaphor) ───
          const cosH = Math.cos(this.heading);
          const sinH = Math.sin(this.heading);
          const tiltFactor = Math.max(0.3, Math.cos(this.tilt));
          const panX = -dx * cosH - dy * sinH;
          const panY = -dx * sinH + dy * cosH * tiltFactor;
          dTheta = panX * sens;
          dPhi = panY * sens;
        } else {
          // ─── Standard globe orbit (top-down) ───
          dTheta = -dx * sens;
          dPhi = dy * sens;
        }

        this.theta += dTheta;
        this.phi += dPhi;
        this.phi = Math.max(-this.maxPhi, Math.min(this.maxPhi, this.phi));
        this.targetTheta = this.theta;
        this.targetPhi = this.phi;

        // Track velocity history for swipe detection (keep last 3)
        this._velocityHistory.push({ dTheta, dPhi, time: performance.now() });
        if (this._velocityHistory.length > 3) this._velocityHistory.shift();
      } else if (this.isTilting) {
        // ─── Right-click: tilt (vertical) + heading orbit (horizontal) ───
        // Vertical drag = tilt/pitch
        this.targetTilt -= dy * 0.005;
        this.targetTilt = Math.max(0, Math.min(this.maxTilt, this.targetTilt));

        // Horizontal drag = heading orbit (helicopter rotate)
        this.targetHeading += dx * 0.005;
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.isDragging) {
        const timeSinceLastMove = performance.now() - (this._lastMoveTime || 0);
        const history = this._velocityHistory;

        // Only apply inertia if this was a fast swipe:
        //   - Last move was very recent (< 80ms ago)
        //   - Average velocity exceeds the swipe threshold
        if (timeSinceLastMove < 80 && history.length >= 2) {
          // Average velocity over recent moves
          let avgTheta = 0,
            avgPhi = 0;
          for (const h of history) {
            avgTheta += h.dTheta;
            avgPhi += h.dPhi;
          }
          avgTheta /= history.length;
          avgPhi /= history.length;

          const speed = Math.sqrt(avgTheta * avgTheta + avgPhi * avgPhi);
          if (speed > 0.001) {
            // Fast swipe — apply inertia
            this.thetaVel = avgTheta;
            this.phiVel = avgPhi;
          } else {
            // Slow release — sticky stop
            this.thetaVel = 0;
            this.phiVel = 0;
          }
        } else {
          // Paused before releasing — sticky stop
          this.thetaVel = 0;
          this.phiVel = 0;
        }
        this._velocityHistory = [];
      }
      this.isDragging = false;
      this.isTilting = false;
    });

    // --- Mouse wheel (zoom toward cursor) ---
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();

        const rect = c.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hit = this._screenToGlobe(mx, my, rect.width, rect.height);

        // Zoom: continuous exponential scaling proportional to scroll delta
        // deltaMode 1 = DOM_DELTA_LINE (some mice), normalize to pixels
        const rawDelta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const zoomRatio = Math.exp(rawDelta * 0.004);
        const prevTarget = this.targetDistance;
        let alt = this.targetDistance - 1.0;
        alt *= zoomRatio;
        this.targetDistance = 1.0 + alt;
        this.targetDistance = Math.max(this.minDist, Math.min(this.maxDist, this.targetDistance));

        // Cap divergence from current distance
        const curAlt = Math.max(this.distance - 1.0, 0.00001);
        const tgtAlt = Math.max(this.targetDistance - 1.0, 0.00001);
        const r = tgtAlt / curAlt;
        if (r < 0.5) this.targetDistance = 1.0 + curAlt * 0.5;
        if (r > 2.0) this.targetDistance = 1.0 + curAlt * 2.0;

        const zoomChanged = Math.abs(this.targetDistance - prevTarget) > 0.0000001;

        if (hit && zoomChanged) {
          const shift = 1.0 - zoomRatio;
          let dTheta = hit.theta - this.targetTheta;
          const dPhi = hit.phi - this.targetPhi;
          while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
          while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
          this.targetTheta += dTheta * shift;
          this.targetPhi += dPhi * shift;
          this.targetPhi = Math.max(-this.maxPhi, Math.min(this.maxPhi, this.targetPhi));
        }
      },
      { passive: false }
    );

    // --- Touch support ---
    let lastTouchDist = 0;
    c.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 1) {
          this.isDragging = true;
          this.lastX = e.touches[0].clientX;
          this.lastY = e.touches[0].clientY;
          this.thetaVel = 0;
          this.phiVel = 0;
        } else if (e.touches.length === 2) {
          const dx = e.touches[1].clientX - e.touches[0].clientX;
          const dy = e.touches[1].clientY - e.touches[0].clientY;
          lastTouchDist = Math.sqrt(dx * dx + dy * dy);
          // Two-finger also enables tilt via vertical movement of midpoint
          this.isTilting = true;
          this.lastY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          this.lastX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        }
        e.preventDefault();
      },
      { passive: false }
    );

    c.addEventListener(
      'touchmove',
      (e) => {
        if (e.touches.length === 1 && this.isDragging) {
          const dx = e.touches[0].clientX - this.lastX;
          const dy = e.touches[0].clientY - this.lastY;
          this.lastX = e.touches[0].clientX;
          this.lastY = e.touches[0].clientY;
          const sens = this._orbitSensitivity();

          if (this.tilt > 0.05) {
            const cosH = Math.cos(this.heading);
            const sinH = Math.sin(this.heading);
            this.theta += (-dx * cosH - dy * sinH) * sens;
            this.phi += (dx * sinH - dy * cosH) * sens * 0.7;
          } else {
            this.theta -= dx * sens;
            this.phi += dy * sens;
          }
          this.phi = Math.max(-this.maxPhi, Math.min(this.maxPhi, this.phi));
          this.targetTheta = this.theta;
          this.targetPhi = this.phi;
        } else if (e.touches.length === 2) {
          // Pinch zoom
          const dx = e.touches[1].clientX - e.touches[0].clientX;
          const dy = e.touches[1].clientY - e.touches[0].clientY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (lastTouchDist > 0) {
            this.targetDistance *= lastTouchDist / dist;
            this.targetDistance = Math.max(
              this.minDist,
              Math.min(this.maxDist, this.targetDistance)
            );
          }
          lastTouchDist = dist;

          // Two-finger twist = heading orbit
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
          const mdx = midX - this.lastX;
          const mdy = midY - this.lastY;
          this.lastX = midX;
          this.lastY = midY;
          // Vertical = tilt
          this.targetTilt -= mdy * 0.004;
          this.targetTilt = Math.max(0, Math.min(this.maxTilt, this.targetTilt));
        }
        e.preventDefault();
      },
      { passive: false }
    );

    c.addEventListener('touchend', () => {
      this.isDragging = false;
      this.isTilting = false;
      lastTouchDist = 0;
    });

    // --- Double-click to reset tilt ---
    c.addEventListener('dblclick', (e) => {
      if (this.tilt > 0.01) {
        this.targetTilt = 0;
        this.targetHeading = 0;
        e.preventDefault();
      }
    });

    window.addEventListener('resize', () => this._updateProjection());
  }

  _updateProjection() {
    const aspect = this.canvas.clientWidth / this.canvas.clientHeight;
    if (aspect === this._lastProjAspect && Math.abs(this.distance - this._lastProjDist) < 0.00001)
      return;
    this._lastProjAspect = aspect;
    this._lastProjDist = this.distance;
    const alt = Math.max(this.distance - 1.0, 0.00001);
    // Tight near plane: at high altitude, start just before the globe surface
    // to maximize depth buffer precision where it matters (globe at radius 1.0).
    // Falls back to proportional near at close zoom.
    // const near = Math.max(this.distance - 1.5, alt * 0.1, 0.00001);
    // Near plane: proportional to altitude above the TILE shell (r=1.0001), not the
    // bare earth surface, so the near plane never encroaches on the tile geometry.
    // The 0.1 factor keeps depth buffer precision tight while staying safely in front
    // of tiles even with polygonOffset(-1,-8) applied.
    const altAboveTiles = Math.max(this.distance - 1.0001, 0.00001);
    const near = Math.max(altAboveTiles * 0.1, 0.00001);
    const far = this.distance + 2.0;
    // mat4.perspective(this.projMatrix, Math.PI / 4, aspect, near, far);
    const perspectiveFn = this._useZeroToOneZ ? mat4.perspectiveZO : mat4.perspective;
    perspectiveFn(this.projMatrix, Math.PI / 4, aspect, near, far);
  }

  update() {
    // Lerp all parameters for smooth transitions
    const lerp = 0.15;
    this.distance += (this.targetDistance - this.distance) * lerp;
    this.theta += (this.targetTheta - this.theta) * lerp;
    this.phi += (this.targetPhi - this.phi) * lerp;
    this.phi = Math.max(-this.maxPhi, Math.min(this.maxPhi, this.phi));
    this.tilt += (this.targetTilt - this.tilt) * lerp;
    this.heading += (this.targetHeading - this.heading) * lerp;

    // Snap when close
    if (Math.abs(this.distance - this.targetDistance) < 0.0000001)
      this.distance = this.targetDistance;
    if (Math.abs(this.theta - this.targetTheta) < 0.0000001) this.theta = this.targetTheta;
    if (Math.abs(this.phi - this.targetPhi) < 0.0000001) this.phi = this.targetPhi;
    if (Math.abs(this.tilt - this.targetTilt) < 0.001) this.tilt = this.targetTilt;
    if (Math.abs(this.heading - this.targetHeading) < 0.001) this.heading = this.targetHeading;

    this._updateProjection();

    // Inertia (only when not dragging)
    const damping = this._damping();
    if (!this.isDragging) {
      this.targetTheta += this.thetaVel;
      this.targetPhi += this.phiVel;
      this.targetPhi = Math.max(-this.maxPhi, Math.min(this.maxPhi, this.targetPhi));
      this.thetaVel *= damping;
      this.phiVel *= damping;
      if (Math.abs(this.thetaVel) < 0.0001) this.thetaVel = 0;
      if (Math.abs(this.phiVel) < 0.0001) this.phiVel = 0;
    }

    // ─── Orbital camera with tilt and heading ───
    //
    // The look-point is the surface point at (theta, phi).
    // The camera orbits around this point at the given distance,
    // with tilt controlling pitch and heading controlling yaw.
    //
    // When tilt=0: camera is directly above the look-point (top-down).
    // When tilt>0: camera is behind and above the look-point (oblique).

    // Surface look-point in Cartesian
    const cosPhi = Math.cos(this.phi);
    const lookX = cosPhi * Math.sin(this.theta);
    const lookY = Math.sin(this.phi);
    const lookZ = cosPhi * Math.cos(this.theta);

    // Store for external consumers (tile loading, etc.)
    this.lookPoint[0] = lookX;
    this.lookPoint[1] = lookY;
    this.lookPoint[2] = lookZ;

    // Camera offset from look-point, in local tangent frame
    const alt = this.distance - 1.0;

    if (this.tilt < 0.01) {
      // Top-down: classic spherical orbit (no tilt)
      // Reset heading when fully in nadir (not transitioning TO oblique),
      // so re-entering oblique mode starts at north.
      if (this.targetTilt < 0.01) {
        this.heading = 0;
        this.targetHeading = 0;
      }

      const eyeX = this.distance * cosPhi * Math.sin(this.theta);
      const eyeY = this.distance * Math.sin(this.phi);
      const eyeZ = this.distance * cosPhi * Math.cos(this.theta);

      this.cameraPosition[0] = eyeX;
      this.cameraPosition[1] = eyeY;
      this.cameraPosition[2] = eyeZ;

      this._lookAtTarget[0] = 0;
      this._lookAtTarget[1] = 0;
      this._lookAtTarget[2] = 0;
      this._lookAtUp[0] = 0;
      this._lookAtUp[1] = 1;
      this._lookAtUp[2] = 0;
      mat4.lookAt(this.viewMatrix, this.cameraPosition, this._lookAtTarget, this._lookAtUp);
    } else {
      // ─── Oblique view with tilt + heading ───
      // Camera position = look-point + offset rotated by heading around surface normal

      // Surface normal at the look-point (= normalized look-point on unit sphere)
      const nx = lookX,
        ny = lookY,
        nz = lookZ;

      // Tangent vectors at the look-point
      // East direction (tangent along longitude)
      const eastLen = Math.sqrt(lookZ * lookZ + lookX * lookX) || 0.001;
      const eastX = lookZ / eastLen;
      const eastY = 0;
      const eastZ = -lookX / eastLen;

      // North direction (tangent along latitude, = normal × east)
      const northX = ny * eastZ - nz * eastY;
      const northY = nz * eastX - nx * eastZ;
      const northZ = nx * eastY - ny * eastX;

      // Camera offset in local tangent frame:
      //   - behind (negative north) by sin(tilt) * alt
      //   - above (positive normal) by cos(tilt) * alt
      // Rotated by heading angle around the normal
      const cosH = Math.cos(this.heading);
      const sinH = Math.sin(this.heading);

      // Rotate the "behind" direction by heading
      const behindDist = Math.sin(this.tilt) * alt;
      const upDist = Math.cos(this.tilt) * alt;

      // Behind direction rotated by heading: -north*cosH + east*sinH
      const bx = (-northX * cosH + eastX * sinH) * behindDist;
      const by = (-northY * cosH + eastY * sinH) * behindDist;
      const bz = (-northZ * cosH + eastZ * sinH) * behindDist;

      // Up direction along normal
      const ux = nx * upDist;
      const uy = ny * upDist;
      const uz = nz * upDist;

      // Camera position
      const eyeX = lookX + bx + ux;
      const eyeY = lookY + by + uy;
      const eyeZ = lookZ + bz + uz;

      this.cameraPosition[0] = eyeX;
      this.cameraPosition[1] = eyeY;
      this.cameraPosition[2] = eyeZ;

      // Up vector: tilted up = normal direction (keeps horizon level)
      // Use the surface normal as the up vector for natural horizon
      this._lookAtTarget[0] = lookX;
      this._lookAtTarget[1] = lookY;
      this._lookAtTarget[2] = lookZ;
      this._lookAtUp[0] = nx;
      this._lookAtUp[1] = ny;
      this._lookAtUp[2] = nz;
      mat4.lookAt(this.viewMatrix, this.cameraPosition, this._lookAtTarget, this._lookAtUp);
    }

    return {
      view: this.viewMatrix,
      projection: this.projMatrix,
      position: this.cameraPosition,
      lookPoint: this.lookPoint,
      tilt: this.tilt,
    };
  }

  /**
   * Smoothly fly to a lat/lon position at a given zoom distance.
   */
  flyTo(lat, lon, distance = 1.05) {
    const DEG2RAD = Math.PI / 180;
    this.targetTheta = (lon + 180) * DEG2RAD;
    this.targetPhi = lat * DEG2RAD;
    this.targetDistance = Math.max(this.minDist, Math.min(this.maxDist, distance));
    this.thetaVel = 0;
    this.phiVel = 0;
  }

  resize() {
    this._updateProjection();
  }
}
