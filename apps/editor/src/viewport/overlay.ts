import {
  type Camera,
  createProjectedPoint,
  DepthSorter,
  decalAnchor,
  type Node,
  type Rig,
  type Scene,
} from '@mascotte/engine';

/** What the debug view shows. */
export interface DebugView {
  /** The selected node's axes and pivot. */
  readonly axes: boolean;
  /** The rig's bones and its slots. */
  readonly bones: boolean;
  /** Each shape's place in sort order, at its sort point. */
  readonly sort: boolean;
  /** A line from each decal to its anchor. */
  readonly anchors: boolean;
  /** The document's frame (when looking through its camera). */
  readonly frame: boolean;
}

/** What the overlay is drawn over: the scene, as drawn, and what it shows. */
export interface OverlayScene {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly rig: Rig;
  /** The built node of the selected document node (an instance's or a solid's own node). */
  readonly selected: Node | null;
  /** CSS pixels per frame unit (1 for the orbit; the document's frame fitted, for its camera). */
  readonly scale: number;
  /** The document's frame, drawn when looking through its camera; else `null`. */
  readonly view: { readonly width: number; readonly height: number } | null;
}

const AXIS_LENGTH = 32;
const AXES = [
  { x: 1, y: 0, z: 0, color: '#e5484d' },
  { x: 0, y: 1, z: 0, color: '#30a46c' },
  { x: 0, y: 0, z: 1, color: '#3e63dd' },
] as const;
const BONE = '#f5a524';
const SORT = '#1c1c1c';
const ANCHOR = '#8e4ec6';
const FRAME = '#1c1c1c';

const sorter = new DepthSorter();
const projected = createProjectedPoint();
const local = { x: 0, y: 0, z: 0 };
const world = { x: 0, y: 0, z: 0 };
// CSS pixels per frame unit of the overlay being drawn: the overlay is drawn in CSS pixels, so
// its lines and labels keep their size whatever the frame's scale.
let unit = 1;

/** The screen point (from the frame's center) of `node`'s local point, or `null` if unseen. */
function screenOf(camera: Camera, node: Node, x: number, y: number, z: number) {
  local.x = x;
  local.y = y;
  local.z = z;
  node.localToWorld(world, local);
  return camera.project(projected, world) ? { x: projected.x * unit, y: projected.y * unit } : null;
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function line(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number) {
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
}

/** A label with a light halo, so it reads over any color. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/**
 * The node's axes, `AXIS_LENGTH` on screen when they lie across the view and shorter as they
 * turn toward it (one seen end-on is a dot), and its pivot.
 */
function drawAxes(ctx: CanvasRenderingContext2D, camera: Camera, node: Node): void {
  const origin = screenOf(camera, node, 0, 0, 0);
  if (!origin) return;
  const scale = projected.scale * unit;
  const base = node.localToWorld({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  ctx.lineWidth = 2;
  for (const axis of AXES) {
    // A small step along the axis gives its direction on screen and its length in the world.
    const step = screenOf(camera, node, axis.x * 1e-3, axis.y * 1e-3, axis.z * 1e-3);
    const full = Math.hypot(world.x - base.x, world.y - base.y, world.z - base.z) * scale;
    if (!step || !(full > 0)) continue;
    const k = AXIS_LENGTH / full;
    ctx.strokeStyle = axis.color;
    line(
      ctx,
      origin.x,
      origin.y,
      origin.x + (step.x - origin.x) * k,
      origin.y + (step.y - origin.y) * k,
    );
  }
  dot(ctx, origin.x, origin.y, 3.5, '#ffffff');
  dot(ctx, origin.x, origin.y, 2.5, '#1c1c1c');
}

/** The bones as lines from each to its nearest bone ancestor, and the slots' names. */
function drawBones(ctx: CanvasRenderingContext2D, camera: Camera, rig: Rig): void {
  ctx.lineWidth = 2;
  ctx.strokeStyle = BONE;
  for (const bone of rig.bones) {
    const at = screenOf(camera, bone, 0, 0, 0);
    if (!at) continue;
    let parent = bone.parent;
    while (parent && !parent.bone) parent = parent.parent;
    const from = parent ? screenOf(camera, parent, 0, 0, 0) : null;
    if (from) line(ctx, from.x, from.y, at.x, at.y);
    dot(ctx, at.x, at.y, 3, BONE);
  }
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const name of rig.slots.keys()) {
    const node = rig.node(name);
    const at = node && screenOf(camera, node, 0, 0, 0);
    if (at) label(ctx, name, at.x + 6, at.y, BONE);
  }
}

/** Each shape's place in sort order at its sort point, and lines from decals to their anchors. */
function drawSort(
  ctx: CanvasRenderingContext2D,
  camera: Camera,
  scene: Scene,
  order: boolean,
  anchors: boolean,
): void {
  const drawables = sorter.sort(scene, camera);
  const point = { x: 0, y: 0, z: 0 };
  const sortPoint = (node: Node) => {
    node.getSortPoint(point);
    return screenOf(camera, node, point.x, point.y, point.z);
  };
  if (anchors) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = ANCHOR;
    ctx.setLineDash([4, 3]);
    for (const drawable of drawables) {
      const anchor = decalAnchor(drawable);
      if (!anchor) continue;
      const from = sortPoint(drawable);
      const to = sortPoint(anchor);
      if (from && to) line(ctx, from.x, from.y, to.x, to.y);
    }
    ctx.setLineDash([]);
  }
  if (order) {
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    drawables.forEach((drawable, index) => {
      const at = sortPoint(drawable);
      if (!at) return;
      dot(ctx, at.x, at.y, 2, SORT);
      label(ctx, String(index + 1), at.x, at.y - 3, SORT);
    });
  }
}

/**
 * Draws the debug view on `ctx`, whose transform puts the frame's center at the origin in CSS
 * pixels.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: OverlayScene,
  view: DebugView,
): void {
  const { camera, scene } = overlay;
  unit = overlay.scale;
  if (view.frame && overlay.view) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = FRAME;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      -overlay.view.width / 2,
      -overlay.view.height / 2,
      overlay.view.width,
      overlay.view.height,
    );
    ctx.setLineDash([]);
  }
  if (view.sort || view.anchors) drawSort(ctx, camera, scene, view.sort, view.anchors);
  if (view.bones) drawBones(ctx, camera, overlay.rig);
  if (view.axes && overlay.selected) drawAxes(ctx, camera, overlay.selected);
}
