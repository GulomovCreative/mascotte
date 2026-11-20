import { Camera } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { applyOrbit, orbitFrom, pan, turn, zoom } from '../src/viewport/orbit.ts';

describe('orbit', () => {
  it('starts at the document camera, turns, pans across the view and zooms within bounds', () => {
    const document = new Camera({ zoom: 2, position: { x: 5, y: -10, z: 0 } });
    const start = orbitFrom(document);
    expect(start).toEqual({ yaw: 0, pitch: 0, target: { x: 5, y: -10, z: 0 }, zoom: 2 });
    const turned = turn(start, 100, 50);
    expect(turned.yaw).toBeCloseTo(-1);
    expect(turned.pitch).toBeCloseTo(0.5);
    // The pitch stops short of straight up.
    expect(turn(start, 0, -1e4).pitch).toBeLessThan(Math.PI / 2);
    const camera = new Camera();
    applyOrbit(camera, start, document);
    expect(camera.zoom).toBe(2);
    // Unturned, a drag right moves the target left by the drag over the zoom.
    expect(pan(start, camera, 10, 0).target).toEqual({ x: 0, y: -10, z: 0 });
    // Turned a quarter round, a drag right moves the target against the camera's x axis, now
    // the world's -z.
    const half = { ...start, yaw: Math.PI / 2 };
    applyOrbit(camera, half, document);
    const moved = pan(half, camera, 10, 0).target;
    expect([moved.x, moved.y, moved.z].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([
      5, -10, 5,
    ]);
    // Turning: a drag down tips the top toward the viewer, so the eye rises above the target.
    const tipped = new Camera({ projection: 'perspective', distance: 100 });
    applyOrbit(tipped, turn(start, 0, 50), tipped);
    expect(tipped.getEyePosition({ x: 0, y: 0, z: 0 })?.y ?? 0).toBeLessThan(-10);
    expect(zoom(start, 1e9).zoom).toBe(50);
    expect(zoom(start, 1e-9).zoom).toBe(0.05);
  });
});
