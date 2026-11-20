import type { Camera } from '@mascotte/engine';

/**
 * The viewport's own camera, apart from the document's: it turns about `target` (yaw about the
 * world's y axis, then pitch), pans the target across the view and zooms. The camera node stands
 * at the target, so a perspective eye orbits it from `distance` away.
 */
export interface Orbit {
  readonly yaw: number;
  readonly pitch: number;
  readonly target: { readonly x: number; readonly y: number; readonly z: number };
  readonly zoom: number;
}

/** Radians per pixel dragged. */
const TURN = 0.01;
/** The pitch stops short of looking straight down or up. */
const PITCH = Math.PI / 2 - 0.01;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 50;

/** An orbit that starts where the document's camera looks from, unturned. */
export function orbitFrom(camera: Camera): Orbit {
  const world = camera.worldMatrix;
  return {
    yaw: 0,
    pitch: 0,
    target: { x: world[9] as number, y: world[10] as number, z: world[11] as number },
    zoom: camera.zoom,
  };
}

/** Puts `camera` where `orbit` says, with the projection of `like` (the document's camera). */
export function applyOrbit(camera: Camera, orbit: Orbit, like: Camera): void {
  camera.projection = like.projection;
  camera.distance = like.distance;
  camera.light = like.light;
  camera.zoom = orbit.zoom;
  camera.position.set(orbit.target.x, orbit.target.y, orbit.target.z);
  camera.setRotationFromEuler({ x: orbit.pitch, y: orbit.yaw, z: 0, order: 'YXZ' });
}

/** Turned by a drag of `dx`, `dy` pixels: right turns the mascot right, down tips it toward you. */
export function turn(orbit: Orbit, dx: number, dy: number): Orbit {
  const pitch = Math.max(-PITCH, Math.min(PITCH, orbit.pitch - dy * TURN));
  return { ...orbit, yaw: orbit.yaw - dx * TURN, pitch };
}

/**
 * Panned by a drag of `dx`, `dy` pixels: the target moves the other way across the view, so the
 * scene follows the pointer. `camera` is where the orbit puts it (its axes say which way is
 * across).
 */
export function pan(orbit: Orbit, camera: Camera, dx: number, dy: number): Orbit {
  const m = camera.worldMatrix;
  const k = 1 / orbit.zoom;
  const { x, y, z } = orbit.target;
  return {
    ...orbit,
    target: {
      x: x - ((m[0] as number) * dx + (m[3] as number) * dy) * k,
      y: y - ((m[1] as number) * dx + (m[4] as number) * dy) * k,
      z: z - ((m[2] as number) * dx + (m[5] as number) * dy) * k,
    },
  };
}

/** Zoomed in by `factor` (out for less than 1), within bounds. */
export function zoom(orbit: Orbit, factor: number): Orbit {
  return { ...orbit, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, orbit.zoom * factor)) };
}
