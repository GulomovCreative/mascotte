import { createProjectedPoint, type Node } from '@mascotte/engine';
import { render } from 'preact';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { App } from '../src/app.tsx';
import { newDocument } from '../src/files/documents.ts';
import { nodeAt, pathString } from '../src/model/paths.ts';
import { editor, openDocument, state } from '../src/store.ts';
import { gizmoFrame } from '../src/viewport/gizmo.ts';
import { debugView, gizmoMode, orbit, viewCamera } from '../src/viewport/viewport.tsx';

let host: HTMLDivElement | null = null;

beforeAll(async () => {
  await page.viewport(1280, 800);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/apps/editor/src/style.css';
  const loaded = new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = reject;
  });
  document.head.append(link);
  await loaded;
});

afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
    host = null;
  }
  viewCamera.value = 'orbit';
  gizmoMode.value = 'move';
  debugView.value = { axes: true, bones: false, sort: false, anchors: false, frame: true };
  openDocument(newDocument('blob'), null);
});

async function mount(name: string): Promise<HTMLCanvasElement> {
  host = document.createElement('div');
  document.body.append(host);
  render(<App />, host);
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Reference"]');
  if (!select) throw new Error('no menu');
  select.value = name;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await expect.poll(() => state.value.document.meta.name).toBe(name);
  const canvas = host.querySelector<HTMLCanvasElement>('canvas.viewport');
  if (!canvas) throw new Error('no viewport');
  // The viewport's effect runs after the first paint: once the canvas is fitted, it listens.
  await expect.poll(() => canvas.width).not.toBe(300);
  return canvas;
}

const mountPip = () => mount('Pip');

function pointer(
  canvas: HTMLCanvasElement,
  type: string,
  x: number,
  y: number,
  buttons = 1,
  shiftKey = false,
) {
  const rect = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
      button: 0,
      buttons,
      shiftKey,
      clientX: rect.left + x,
      clientY: rect.top + y,
    }),
  );
}

/** How many pixels of the overlay are drawn on. */
function overlayInk(): number {
  const overlay = host?.querySelector<HTMLCanvasElement>('canvas.viewport-overlay');
  const ctx = overlay?.getContext('2d');
  if (!overlay || !ctx) throw new Error('no overlay');
  const { data } = ctx.getImageData(0, 0, overlay.width, overlay.height);
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) ink++;
  return ink;
}

/** The built node with `id` in the open scene. */
function built(id: string): Node {
  let found: Node | null = null;
  state.value.scene?.scene.root.traverse((node) => {
    if (node.id === id) found = node;
  });
  if (!found) throw new Error(`no ${id}`);
  return found;
}

/**
 * Where `node`'s origin is on the canvas, through the document's camera, with the frame `scale`
 * CSS pixels a unit (the orbit starts there, unturned, at 1).
 */
function onCanvas(canvas: HTMLCanvasElement, node: Node, scale: number): { x: number; y: number } {
  const camera = state.value.scene?.built.camera;
  const point = createProjectedPoint();
  const world = node.localToWorld({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  if (!camera?.project(point, world)) throw new Error('not in view');
  const { width, height } = canvas.getBoundingClientRect();
  return { x: width / 2 + point.x * scale, y: height / 2 + point.y * scale };
}

/** The narrower of a ring's width and height on screen: an edge-on ring has almost none. */
function spread(ring: readonly { x: number; y: number }[]): number {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

function click(canvas: HTMLCanvasElement, at: { x: number; y: number }) {
  pointer(canvas, 'pointerdown', at.x, at.y);
  pointer(canvas, 'pointerup', at.x, at.y, 0);
}

describe('viewport', () => {
  it("picks a prefab's node as its instance, also through the document camera's fitted frame", async () => {
    const canvas = await mount('Gloop');
    const instance = (id: string) => pathString(state.value.scene?.sources.get(built(id)) ?? []);
    click(canvas, onCanvas(canvas, built('eye-left-pupil'), 1));
    await expect.poll(() => pathString(state.value.selection ?? [])).toBe(instance('eye-left'));
    // Through the document's camera: its frame fitted into the panel, the other eye.
    viewCamera.value = 'document';
    const view = state.value.scene?.built.view ?? { width: 1, height: 1 };
    const { width, height } = canvas.getBoundingClientRect();
    const scale = Math.min(width / view.width, height / view.height);
    click(canvas, onCanvas(canvas, built('eye-right-pupil'), scale));
    await expect.poll(() => pathString(state.value.selection ?? [])).toBe(instance('eye-right'));
    // A drag there leaves the orbit as it is.
    const before = orbit.value;
    pointer(canvas, 'pointerdown', 100, 100);
    pointer(canvas, 'pointermove', 200, 100);
    pointer(canvas, 'pointerup', 200, 100, 0);
    expect(orbit.value).toBe(before);
  });

  it("poses Pip's wing with the rotate gizmo in one step, and undoes it", async () => {
    const canvas = await mountPip();
    viewCamera.value = 'document';
    gizmoMode.value = 'rotate';
    const scene = state.value.scene;
    const path = scene?.sources.get(built('wing-left'));
    if (!scene || !path) throw new Error('no wing');
    editor.value.select(path);
    const before = state.value.document;
    const view = scene.built.view;
    const { width, height } = canvas.getBoundingClientRect();
    const scale = Math.min(width / view.width, height / view.height);
    const frame = gizmoFrame(built('wing-left'), scene.built.camera, 'local', scale);
    // The ring that faces the viewer most: its points spread furthest on screen.
    const ring = [...(frame?.axes ?? [])]
      .map((axis) => axis.ring)
      .sort((a, b) => spread(b) - spread(a))[0];
    if (!ring || ring.length < 13) throw new Error('no ring');
    const at = (point: { x: number; y: number }) => ({
      x: width / 2 + point.x,
      y: height / 2 + point.y,
    });
    // Round the ring a quarter, in steps: one step to undo all the same.
    const drag = (end: 'pointerup' | 'pointercancel') => {
      const from = at(ring[0] as { x: number; y: number });
      pointer(canvas, 'pointerdown', from.x, from.y);
      for (const k of [4, 8, 12]) {
        const to = at(ring[k] as { x: number; y: number });
        pointer(canvas, 'pointermove', to.x, to.y);
      }
      const last = at(ring[12] as { x: number; y: number });
      pointer(canvas, end, last.x, last.y, 0);
    };
    const rotation = () => nodeAt(state.value.document, path)?.props?.rotation;
    drag('pointerup');
    const posed = state.value.document;
    expect(rotation()).not.toEqual(nodeAt(before, path)?.props?.rotation);
    // Not a click: the selection stays.
    expect(state.value.selection).toEqual(path);
    // A second drag is a second step.
    drag('pointerup');
    expect(state.value.document).not.toBe(posed);
    editor.value.undo();
    expect(state.value.document).toBe(posed);
    editor.value.undo();
    expect(state.value.document).toBe(before);
    // A drag the browser takes away is put back.
    drag('pointercancel');
    expect(rotation()).toEqual(nodeAt(before, path)?.props?.rotation);
  });

  it('pans the orbit by a shift-drag, without turning it', async () => {
    const canvas = await mountPip();
    pointer(canvas, 'pointerdown', 300, 300, 1, true);
    pointer(canvas, 'pointermove', 360, 300, 1, true);
    pointer(canvas, 'pointerup', 360, 300, 0, true);
    await expect.poll(() => orbit.value).not.toBeNull();
    expect(orbit.value?.yaw).toBe(0);
    // Dragged right, the scene follows: the target, at the document camera at first, moves left.
    const start = state.value.scene?.built.camera.worldMatrix[9] ?? 0;
    expect(orbit.value?.target.x).toBeLessThan(start);
  });

  it("picks Pip's nodes, shows the selection's axes, the bones and the sort order", async () => {
    const canvas = await mountPip();
    const { width, height } = canvas.getBoundingClientRect();
    // A click in the middle of the frame: Pip's body or something on it.
    pointer(canvas, 'pointerdown', width / 2, height / 2);
    pointer(canvas, 'pointerup', width / 2, height / 2, 0);
    await expect.poll(() => state.value.selection).not.toBeNull();
    expect(pathString(state.value.selection ?? [])).toMatch(/^root/);
    const axes = overlayInk();
    expect(axes).toBeGreaterThan(0);
    debugView.value = { ...debugView.value, bones: true, sort: true, anchors: true };
    await expect.poll(overlayInk).toBeGreaterThan(axes);
    // A click on the empty corner selects nothing.
    pointer(canvas, 'pointerdown', 3, 3);
    pointer(canvas, 'pointerup', 3, 3, 0);
    await expect.poll(() => state.value.selection).toBeNull();
  });

  it('turns the orbit by a drag and zooms by the wheel; looks through the document camera too', async () => {
    const canvas = await mountPip();
    pointer(canvas, 'pointerdown', 300, 300);
    pointer(canvas, 'pointermove', 360, 300);
    pointer(canvas, 'pointerup', 360, 300, 0);
    await expect.poll(() => orbit.value?.yaw ?? 0).toBeLessThan(0);
    // A drag selects nothing.
    expect(state.value.selection).toBeNull();
    const before = orbit.value?.zoom ?? 0;
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }),
    );
    expect(orbit.value?.zoom ?? 0).toBeGreaterThan(before);
    viewCamera.value = 'document';
    // The document's frame is drawn as a dashed rectangle.
    await expect.poll(overlayInk).toBeGreaterThan(0);
  });
});
