/**
 * globeGeo.test.mjs — JS twin of the WGSL globe geometry (lat/lon/alt → XYZ),
 * horizon visibility, and world→screen projection. Mirrors gfbpoint.wgsl so
 * CPU picking matches rendered pixels.
 * Run: node --test lib/packages/core/src/math/globeGeo.test.mjs
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import * as mat4 from './mat4.js';
import {
  latLonAltToXYZ,
  FEET_TO_GLOBE,
  isVisibleOverHorizon,
  projectToScreen,
} from './globeGeo.js';

function near(a, b, eps = 1e-5) {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);
}

describe('latLonAltToXYZ (matches WGSL)', () => {
  it('maps lat=0, lon=-180 to the +Z front point (0,0,1)', () => {
    const [x, y, z] = latLonAltToXYZ(0, -180, 0);
    near(x, 0);
    near(y, 0);
    near(z, 1);
  });

  it('maps the north pole (lat=90) to (0,1,0)', () => {
    const [x, y, z] = latLonAltToXYZ(90, -180, 0);
    near(x, 0);
    near(y, 1);
    near(z, 0);
  });

  it('adds altitude in feet scaled by FEET_TO_GLOBE', () => {
    const oneRadiusFeet = 1 / FEET_TO_GLOBE; // + this many feet = +1.0 globe unit
    const [, , z] = latLonAltToXYZ(0, -180, oneRadiusFeet);
    near(z, 2); // radius 1 + 1
  });
});

describe('isVisibleOverHorizon (dot(unitDir, camPos) >= 1)', () => {
  const camPos = [0, 0, 3];
  it('near-side point is visible', () => {
    assert.equal(isVisibleOverHorizon(0, -180, camPos), true); // dir (0,0,1)·(0,0,3)=3
  });
  it('far-side (antipodal) point is not visible', () => {
    assert.equal(isVisibleOverHorizon(0, 0, camPos), false); // dir (0,0,-1)·(0,0,3)=-3
  });
  it('limb point exactly on the horizon is culled (dot=0 < 1)', () => {
    assert.equal(isVisibleOverHorizon(0, -90, camPos), false); // dir (1,0,0)·(0,0,3)=0
  });
});

describe('projectToScreen', () => {
  const width = 800,
    height = 600;
  function camera(eye = [0, 0, 3]) {
    const viewMatrix = mat4.lookAt(mat4.create(), eye, [0, 0, 0], [0, 1, 0]);
    const projMatrix = mat4.perspective(mat4.create(), Math.PI / 4, width / height, 0.1, 100);
    return { viewMatrix, projMatrix, cameraPosition: eye, width, height };
  }

  it('projects the sub-camera point to screen center and marks it visible', () => {
    const r = projectToScreen(0, -180, 0, camera());
    assert.equal(r.visible, true);
    near(r.sx, width / 2, 0.5);
    near(r.sy, height / 2, 0.5);
  });

  it('marks far-side points not visible', () => {
    const r = projectToScreen(0, 0, 0, camera());
    assert.equal(r.visible, false);
  });

  it('projects an off-center visible point to the correct side', () => {
    // lat 0, lon -150 → direction (0.5, 0, 0.866); right of center.
    const r = projectToScreen(0, -150, 0, camera());
    assert.equal(r.visible, true);
    assert.ok(r.sx > width / 2, `expected sx ${r.sx} > ${width / 2}`);
    near(r.sy, height / 2, 0.5);
  });
});
