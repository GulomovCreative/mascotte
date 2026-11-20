import { type Camera, createProjectedPoint, type Node } from '@mascotte/engine';
import { type Mat3x4, mat3x4, type Quat, quat, type Vec3 } from '@mascotte/math';

/** What the gizmo changes: the position, the rotation or the scale. */
export type GizmoMode = 'move' | 'rotate' | 'scale';
/** The axes the gizmo moves and turns along: the node's own, or the world's (scale is local). */
export type GizmoSpace = 'local' | 'world';
/** A handle: what it changes, along which axis. */
export interface Handle {
  readonly mode: GizmoMode;
  readonly axis: 0 | 1 | 2;
}

/** How long a move or scale handle is on screen, and a rotate ring's radius, in CSS pixels. */
export const HANDLE_LENGTH = 72;
const RING = 56;
/** How close the pointer must come to a handle to take it, in CSS pixels. */
const REACH = 7;
const SEGMENTS = 48;
export const AXIS_COLORS = ['#e5484d', '#30a46c', '#3e63dd'] as const;

/** Snapping steps: scene units for a move, radians for a turn, a factor for a scale. */
export const SNAP = { move: 1, rotate: Math.PI / 12, scale: 0.1 } as const;

/** One axis of the gizmo as the screen shows it. */
interface ScreenAxis {
  /** The axis in the world, of unit length. */
  readonly world: Vec3;
  /** Its direction on screen (unit), and screen pixels per scene unit along it (0 end-on). */
  readonly x: number;
  readonly y: number;
  readonly pixels: number;
  /** Whether it points toward the viewer. */
  readonly toward: boolean;
  /** A rotate ring around it: screen points, closed. */
  readonly ring: readonly { x: number; y: number }[];
}

/** The gizmo of a node as the screen shows it: its center and its three axes. */
export interface GizmoFrame {
  /** The center (the node's pivot), in CSS pixels from the frame's center. */
  readonly x: number;
  readonly y: number;
  readonly axes: readonly [ScreenAxis, ScreenAxis, ScreenAxis];
}

const projected = createProjectedPoint();

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * The gizmo of `node` seen from `camera`, in `space`; `unit` is CSS pixels per frame unit (the
 * document camera's frame is fitted). `null` when its center is behind the eye.
 */
export function gizmoFrame(
  node: Node,
  camera: Camera,
  space: GizmoSpace,
  unit: number,
): GizmoFrame | null {
  const center = node.localToWorld({ x: 0, y: 0, z: 0 }, node.pivot);
  if (!camera.project(projected, center)) return null;
  const cx = projected.x * unit;
  const cy = projected.y * unit;
  const across = projected.scale * unit;
  const m = node.worldMatrix;
  const view = camera.viewMatrix;
  const axes = [0, 1, 2].map((i) => {
    const world =
      space === 'local'
        ? normalize({
            x: m[i * 3] as number,
            y: m[i * 3 + 1] as number,
            z: m[i * 3 + 2] as number,
          })
        : { x: i === 0 ? 1 : 0, y: i === 1 ? 1 : 0, z: i === 2 ? 1 : 0 };
    // Its direction in the camera's space: across the screen and toward the viewer.
    const along = mat3x4.transformDirection({ x: 0, y: 0, z: 0 }, view, world);
    const pixels = Math.hypot(along.x, along.y) * across;
    const length = Math.hypot(along.x, along.y);
    // A ring in the plane across the axis, `RING` pixels round where the plane faces the viewer.
    const u = normalize(
      Math.abs(world.y) < 0.9
        ? { x: world.z, y: 0, z: -world.x }
        : { x: 0, y: -world.z, z: world.y },
    );
    const v = {
      x: world.y * u.z - world.z * u.y,
      y: world.z * u.x - world.x * u.z,
      z: world.x * u.y - world.y * u.x,
    };
    const radius = RING / across;
    const ring: { x: number; y: number }[] = [];
    for (let k = 0; k <= SEGMENTS; k++) {
      const a = (k / SEGMENTS) * Math.PI * 2;
      const c = Math.cos(a) * radius;
      const s = Math.sin(a) * radius;
      const point = {
        x: center.x + u.x * c + v.x * s,
        y: center.y + u.y * c + v.y * s,
        z: center.z + u.z * c + v.z * s,
      };
      if (camera.project(projected, point))
        ring.push({ x: projected.x * unit, y: projected.y * unit });
    }
    return {
      world,
      x: length > 1e-9 ? along.x / length : 0,
      y: length > 1e-9 ? along.y / length : 0,
      pixels,
      toward: along.z > 0,
      ring,
    };
  }) as unknown as GizmoFrame['axes'];
  return { x: cx, y: cy, axes };
}

/** Distance from (`px`, `py`) to the segment from `a` to `b`. */
function toSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** An axis seen nearly end-on has no handle: dragging along it would mean nothing. */
const shown = (axis: ScreenAxis) => axis.pixels > 1e-3 && Math.hypot(axis.x, axis.y) > 0.15;

/** The handle of `mode` at (`x`, `y`), CSS pixels from the frame's center, or `null`. */
export function handleAt(frame: GizmoFrame, mode: GizmoMode, x: number, y: number): Handle | null {
  let best: Handle | null = null;
  let nearest = REACH;
  frame.axes.forEach((axis, i) => {
    let distance = Number.POSITIVE_INFINITY;
    if (mode === 'rotate') {
      for (let k = 1; k < axis.ring.length; k++) {
        const a = axis.ring[k - 1] as { x: number; y: number };
        const b = axis.ring[k] as { x: number; y: number };
        distance = Math.min(distance, toSegment(x, y, a.x, a.y, b.x, b.y));
      }
    } else if (shown(axis)) {
      const ex = frame.x + axis.x * HANDLE_LENGTH;
      const ey = frame.y + axis.y * HANDLE_LENGTH;
      distance =
        mode === 'move'
          ? toSegment(x, y, frame.x, frame.y, ex, ey)
          : Math.max(Math.abs(x - ex), Math.abs(y - ey)) - 3;
    }
    if (distance <= nearest) {
      nearest = distance;
      best = { mode, axis: i as 0 | 1 | 2 };
    }
  });
  return best;
}

/** Draws the gizmo of `mode` on `ctx` (CSS pixels from the frame's center); `active` is lit. */
export function drawGizmo(
  ctx: CanvasRenderingContext2D,
  frame: GizmoFrame,
  mode: GizmoMode,
  active: Handle | null,
): void {
  frame.axes.forEach((axis, i) => {
    const lit = active?.axis === i;
    ctx.strokeStyle = AXIS_COLORS[i] as string;
    ctx.fillStyle = AXIS_COLORS[i] as string;
    ctx.lineWidth = lit ? 4 : 2.5;
    if (mode === 'rotate') {
      ctx.beginPath();
      axis.ring.forEach((point, k) => {
        if (k === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
      return;
    }
    if (!shown(axis)) return;
    const ex = frame.x + axis.x * HANDLE_LENGTH;
    const ey = frame.y + axis.y * HANDLE_LENGTH;
    ctx.beginPath();
    ctx.moveTo(frame.x, frame.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    if (mode === 'move') {
      // An arrow head.
      const size = lit ? 11 : 9;
      ctx.beginPath();
      ctx.moveTo(ex + axis.x * size, ey + axis.y * size);
      ctx.lineTo(ex - axis.y * size * 0.5, ey + axis.x * size * 0.5);
      ctx.lineTo(ex + axis.y * size * 0.5, ey - axis.x * size * 0.5);
      ctx.closePath();
      ctx.fill();
    } else {
      const size = lit ? 6 : 5;
      ctx.fillRect(ex - size, ey - size, size * 2, size * 2);
    }
  });
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(frame.x, frame.y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

/** A node's transform as the document holds it (defaults filled in). */
export interface Transform {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
}

const snapTo = (value: number, step: number) => Math.round(value / step) * step;

/**
 * The property a drag of `handle` from (`fromX`, `fromY`) to (`x`, `y`) (CSS pixels from the
 * frame's center) gives, from the transform `start` the node had then: its name and value.
 * `parent` is the world matrix of the node's parent; `snap`, whether to snap to `SNAP`.
 */
export function dragged(
  handle: Handle,
  frame: GizmoFrame,
  space: GizmoSpace,
  start: Transform,
  parent: Readonly<Mat3x4>,
  from: { x: number; y: number },
  to: { x: number; y: number },
  snap: boolean,
):
  | { name: 'position'; value: Vec3 }
  | { name: 'rotation'; value: Quat }
  | { name: 'scale'; value: Vec3 } {
  const axis = frame.axes[handle.axis];
  const inverse = mat3x4.invert(mat3x4.create(), parent) ?? mat3x4.create();
  if (handle.mode === 'move') {
    // Pixels along the axis on screen, as scene units along it.
    let units = ((to.x - from.x) * axis.x + (to.y - from.y) * axis.y) / axis.pixels;
    if (snap) units = snapTo(units, SNAP.move);
    const delta = mat3x4.transformDirection({ x: 0, y: 0, z: 0 }, inverse, {
      x: axis.world.x * units,
      y: axis.world.y * units,
      z: axis.world.z * units,
    });
    return {
      name: 'position',
      value: {
        x: start.position.x + delta.x,
        y: start.position.y + delta.y,
        z: start.position.z + delta.z,
      },
    };
  }
  if (handle.mode === 'rotate') {
    // The angle swept about the center on screen; clockwise on screen (y down) turns an axis
    // that points at the viewer the positive way.
    let angle =
      Math.atan2(to.y - frame.y, to.x - frame.x) - Math.atan2(from.y - frame.y, from.x - frame.x);
    if (!axis.toward) angle = -angle;
    if (snap) angle = snapTo(angle, SNAP.rotate);
    const turn = quat.create();
    const rotation = quat.create();
    if (space === 'local') {
      const local = {
        x: handle.axis === 0 ? 1 : 0,
        y: handle.axis === 1 ? 1 : 0,
        z: handle.axis === 2 ? 1 : 0,
      };
      quat.setAxisAngle(turn, local, angle);
      quat.multiply(rotation, start.rotation, turn);
    } else {
      const inParent = normalize(
        mat3x4.transformDirection({ x: 0, y: 0, z: 0 }, inverse, axis.world),
      );
      quat.setAxisAngle(turn, inParent, angle);
      quat.multiply(rotation, turn, start.rotation);
    }
    quat.normalize(rotation, rotation);
    return { name: 'rotation', value: rotation };
  }
  // Scale, along the node's own axis: the handle's end follows the pointer.
  const factor = 1 + ((to.x - from.x) * axis.x + (to.y - from.y) * axis.y) / HANDLE_LENGTH;
  const key = (['x', 'y', 'z'] as const)[handle.axis];
  let value = start.scale[key] * factor;
  if (snap) value = snapTo(value, SNAP.scale);
  return { name: 'scale', value: { ...start.scale, [key]: value } };
}
