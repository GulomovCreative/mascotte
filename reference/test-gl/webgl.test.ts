import {
  Camera,
  Ellipse,
  Node,
  PathShape,
  Scene,
  Sphere,
  type Viewport,
  WebGLRenderer,
} from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { engineScenes, referenceScenes } from '../src/index.ts';

/* WebGLRenderer frames in the browser: scene snapshots and spot pixel checks. */

const expectedStatuses = ['match', 'written'];

/** Draws a scene on a new canvas and returns the canvas; the renderer is disposed. */
function draw(scene: Scene, camera: Camera, viewport: Viewport): HTMLCanvasElement {
  const ratio = viewport.pixelRatio ?? 1;
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width * ratio;
  canvas.height = viewport.height * ratio;
  const renderer = new WebGLRenderer(canvas);
  try {
    renderer.render(scene, camera, viewport);
    // Copy to 2D right after the frame: the WebGL buffer is not preserved after presenting.
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext('2d');
    if (!ctx) throw new Error('No 2D context.');
    ctx.drawImage(canvas, 0, 0);
    return copy;
  } finally {
    renderer.destroy();
  }
}

async function expectSnapshot(name: string, canvas: HTMLCanvasElement): Promise<void> {
  const result = await commands.matchGLSnapshot(name, canvas.toDataURL('image/png'));
  expect(expectedStatuses, JSON.stringify(result)).toContain(result.status);
}

/** RGBA of canvas pixel (x, y). */
function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context.');
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

const camera = new Camera();
const small = { width: 100, height: 100 } as const;

describe('WebGL snapshots', () => {
  for (const scene of referenceScenes) {
    it(`reference scene ${scene.id}`, async () => {
      const root = scene.engine.build();
      scene.engine.pose(root, 0);
      const canvas = draw(new Scene(root), new Camera({ zoom: scene.zoom }), {
        width: scene.width,
        height: scene.height,
        pixelRatio: 2,
        background: scene.background,
      });
      await expectSnapshot(scene.id, canvas);
    });
  }

  for (const scene of engineScenes) {
    for (const [i, time] of [0, ...(scene.snapshotTimes ?? [])].entries()) {
      const name = i === 0 ? scene.id : `${scene.id}-${i}`;
      it(`scene ${name}`, async () => {
        const { root, camera } = scene.build();
        scene.pose(root, camera, time);
        const canvas = draw(new Scene(root), camera, {
          width: scene.width,
          height: scene.height,
          pixelRatio: 2,
          background: scene.background,
        });
        await expectSnapshot(name, canvas);
      });
    }
  }
});

describe('WebGL pixels', () => {
  it('without a background alpha equals coverage: opaque 255, translucent ~128, empty 0', () => {
    const canvas = draw(
      sceneWith(
        new Sphere({ diameter: 30, position: { x: -20, y: 0, z: 0 }, style: { color: '#f00' } }),
        new Sphere({
          diameter: 30,
          opacity: 0.5,
          position: { x: 20, y: 0, z: 0 },
          style: { color: '#00f' },
        }),
      ),
      camera,
      small,
    );
    expect(pixel(canvas, 30, 50)).toEqual([255, 0, 0, 255]);
    const half = pixel(canvas, 70, 50);
    expect(half.slice(0, 3)).toEqual([0, 0, 255]);
    expect(Math.abs((half[3] ?? 0) - 128)).toBeLessThanOrEqual(1);
    expect(pixel(canvas, 5, 5)).toEqual([0, 0, 0, 0]);
    // The sphere edge has partial coverage.
    const edge = pixel(canvas, 14, 50)[3] ?? 0;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it('a translucent stroke has one tone along its length: capsule joints are not darker', () => {
    const canvas = draw(
      sceneWith(new Ellipse({ diameter: 120, opacity: 0.5, style: { stroke: 12, color: '#000' } })),
      camera,
      { width: 200, height: 200, background: '#fff' },
    );
    const tones = new Set<number>();
    for (let degrees = 0; degrees < 360; degrees += 3) {
      const a = (degrees * Math.PI) / 180;
      tones.add(
        pixel(canvas, Math.round(100 + 60 * Math.cos(a)), Math.round(100 + 60 * Math.sin(a)))[0] ??
          0,
      );
    }
    // One tone on the whole ring; at joints with double blending it would drop to about 64.
    for (const tone of tones) expect(Math.abs(tone - 128)).toBeLessThanOrEqual(1);
  });

  it('per-pixel intersection: each of two spheres is closer on its own half', () => {
    const canvas = draw(
      sceneWith(
        new Sphere({ diameter: 40, position: { x: -6, y: 0, z: 0 }, style: { color: '#f00' } }),
        new Sphere({ diameter: 40, position: { x: 6, y: 0, z: 0 }, style: { color: '#00f' } }),
      ),
      camera,
      { ...small, background: '#fff' },
    );
    expect(pixel(canvas, 46, 50).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixel(canvas, 54, 50).slice(0, 3)).toEqual([0, 0, 255]);
  });

  it('layer −1 is below the content even if closer; layer +1 is above it even if farther', () => {
    const canvas = draw(
      sceneWith(
        new Sphere({ diameter: 40, style: { color: '#f00' } }),
        new PathShape({
          sortMode: 'layer',
          layer: -1,
          position: { x: -10, y: 0, z: 50 },
          style: { stroke: 8, color: '#0f0' },
        }),
        new PathShape({
          sortMode: 'layer',
          layer: 1,
          position: { x: 10, y: 0, z: -50 },
          style: { stroke: 8, color: '#00f' },
        }),
      ),
      camera,
      { ...small, background: '#fff' },
    );
    expect(pixel(canvas, 40, 50).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixel(canvas, 60, 50).slice(0, 3)).toEqual([0, 0, 255]);
  });

  it('a decal is visible only inside the anchor silhouette and is not hidden by it, though slightly deeper', () => {
    const head = new Sphere({ diameter: 40, style: { color: '#f00', stroke: 0 } });
    // A point at the head edge and slightly inside it: not visible outside the silhouette.
    head.add(
      new PathShape({
        sortMode: 'attached',
        position: { x: 20, y: 0, z: -2 },
        style: { stroke: 10, color: '#00f' },
      }),
    );
    const canvas = draw(sceneWith(head), camera, { ...small, background: '#fff' });
    expect(pixel(canvas, 67, 50).slice(0, 3)).toEqual([0, 0, 255]);
    expect(pixel(canvas, 73, 50).slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('a translucent shape in front of a decal blends with the decal, not with the anchor', () => {
    const head = new Sphere({ diameter: 60, style: { color: '#f00', stroke: 0 } });
    head.add(
      new PathShape({
        sortMode: 'attached',
        position: { x: 0, y: 0, z: 28 },
        style: { stroke: 16, color: '#00f' },
      }),
    );
    const veil = new PathShape({
      opacity: 0.5,
      position: { x: 0, y: 0, z: 60 },
      style: { stroke: 40, color: '#fff' },
    });
    const canvas = draw(sceneWith(head, veil), camera, { ...small, background: '#000' });
    const [r = 0, g = 0, b = 0] = pixel(canvas, 50, 50);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(1);
    expect(b).toBe(255);
  });
  it('a translucent decal on an opaque anchor blends with it', () => {
    const head = new Sphere({ diameter: 60, style: { color: '#f00', stroke: 0 } });
    head.add(
      new PathShape({
        sortMode: 'attached',
        opacity: 0.3,
        position: { x: 0, y: 0, z: 28 },
        style: { stroke: 16, color: '#00f' },
      }),
    );
    const canvas = draw(sceneWith(head), camera, { ...small, background: '#000' });
    // Blending: 0.7 red and 0.3 blue. Without it alpha-to-coverage would cover only a
    // multiple of a quarter of the samples, about (192, 0, 64).
    const [r = 0, g = 0, b = 0, a = 0] = pixel(canvas, 50, 50);
    expect(Math.abs(r - 178.5)).toBeLessThanOrEqual(1);
    expect(g).toBe(0);
    expect(Math.abs(b - 76.5)).toBeLessThanOrEqual(1);
    expect(a).toBe(255);
  });

  it('anchor numbers do not carry over to the next layer', () => {
    // Both anchors get number 1 in their layers. The right anchor's decal extends over the left
    // one: it must not appear there, otherwise the left anchor's number stayed in the stencil.
    const left = new Sphere({
      diameter: 30,
      position: { x: -15, y: 0, z: 0 },
      style: { color: '#f00', stroke: 0 },
    });
    left.add(new PathShape({ sortMode: 'attached', position: { x: 0, y: 12, z: 14 } }));
    const right = new Sphere({
      sortMode: 'layer',
      layer: 1,
      diameter: 30,
      position: { x: 15, y: 0, z: 0 },
      style: { color: '#0f0', stroke: 0 },
    });
    right.add(
      new PathShape({
        sortMode: 'attached',
        position: { x: -30, y: 0, z: 0 },
        style: { stroke: 20, color: '#00f' },
      }),
    );
    const canvas = draw(sceneWith(left, right), camera, { ...small, background: '#fff' });
    expect(pixel(canvas, 35, 50).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it('after 127 translucent shapes stencil numbers restart without gaps', () => {
    // 128 points do not overlap; the 129th lies over the first and must blend with it.
    const dots: Node[] = [];
    const dot = (x: number, y: number) =>
      new PathShape({
        opacity: 0.5,
        position: { x, y, z: 0 },
        style: { stroke: 4, color: '#000' },
      });
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 16; i++) dots.push(dot(-45 + 6 * i, -21 + 6 * j));
    }
    dots.push(dot(-45, -21));
    const canvas = draw(sceneWith(...dots), camera, { width: 100, height: 60, background: '#fff' });
    // One point gives 128, two on top of each other give 64.
    expect(Math.abs((pixel(canvas, 5, 9)[0] ?? 0) - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs((pixel(canvas, 11, 9)[0] ?? 0) - 128)).toBeLessThanOrEqual(1);
  });
});

describe('WebGLRenderer lifecycle', () => {
  it('skips frames on context loss and recovers', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 50;
    const renderer = new WebGLRenderer(canvas);
    const scene = sceneWith(new Sphere({ diameter: 20 }));
    const viewport = { width: 50, height: 50, background: '#fff' };
    renderer.render(scene, camera, viewport);
    const lose = renderer.gl.getExtension('WEBGL_lose_context');
    expect(lose).not.toBeNull();
    const event = (name: string) =>
      new Promise((resolve) => canvas.addEventListener(name, resolve, { once: true }));
    const lost = event('webglcontextlost');
    lose?.loseContext();
    expect(renderer.contextLost).toBe(true);
    expect(() => renderer.render(scene, camera, viewport)).not.toThrow();
    // The loss event arrives asynchronously. Restoring is possible only after it and not in the
    // same task as the handler: Chrome ignores such a restoreContext call.
    await lost;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const restored = event('webglcontextrestored');
    lose?.restoreContext();
    await restored;
    expect(renderer.contextLost).toBe(false);
    renderer.render(scene, camera, viewport);
    expect(renderer.gl.getError()).toBe(renderer.gl.NO_ERROR);
    renderer.destroy();
    expect(() => renderer.render(scene, camera, viewport)).toThrow('destroyed');
  });

  it('the supersampling factor defaults to 2 and is not reduced on a small canvas', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const renderer = new WebGLRenderer(canvas);
    renderer.render(new Scene(), camera, { width: 64, height: 64 });
    expect(renderer.supersample).toBe(2);
    renderer.destroy();
  });

  it('a non-drawing node in attached mode also anchors its decals', () => {
    const head = new Sphere({ diameter: 40, style: { color: '#f00', stroke: 0 } });
    const eye = new Node({ sortMode: 'attached', position: { x: 0, y: 0, z: 19 } });
    eye.add(new PathShape({ style: { stroke: 10, color: '#00f' } }));
    head.add(eye);
    const canvas = draw(sceneWith(head), camera, { ...small, background: '#fff' });
    expect(pixel(canvas, 50, 50).slice(0, 3)).toEqual([0, 0, 255]);
  });
});

describe('skipping an unchanged frame', () => {
  it('every input change redraws the frame, and the canvas shows the new state', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    const renderer = new WebGLRenderer(canvas);
    const ball = new Sphere({ diameter: 40, style: { stroke: 0, color: '#f00' } });
    const scene = sceneWith(ball);
    const view = new Camera();
    let viewport: Viewport = { width: 100, height: 100, background: '#fff', pixelRatio: 1 };
    const render = () => renderer.render(scene, view, viewport);
    expect(render()).toBe(true);
    expect(render()).toBe(false);
    const redraws = (name: string, change: () => void) => {
      change();
      expect(render(), name).toBe(true);
      expect(render(), name).toBe(false);
    };
    redraws('camera zoom', () => {
      view.zoom = 2;
    });
    redraws('camera position', () => {
      view.position.x = 3;
    });
    redraws('background', () => {
      viewport = { ...viewport, background: '#000' };
    });
    redraws('pixel ratio', () => {
      viewport = { ...viewport, pixelRatio: 2 };
    });
    redraws('frame width', () => {
      viewport = { ...viewport, width: 90 };
    });
    redraws('canvas size', () => {
      canvas.width = 120;
    });
    redraws('another scene', () => {
      scene.root.add(new Sphere({ diameter: 4, position: { x: 30, y: 30, z: 0 } }));
    });
    // Assigning the same size to the canvas clears it, but the inputs are the same: invalidate() is
    // needed.
    canvas.width = 120;
    expect(render()).toBe(false);
    renderer.invalidate();
    expect(render()).toBe(true);

    // The redrawn frame shows the new state, not the previous one.
    view.zoom = 1;
    view.position.x = 0;
    canvas.width = 100;
    viewport = { width: 100, height: 100, background: '#fff', pixelRatio: 1 };
    ball.style.color = '#00f';
    expect(render()).toBe(true);
    const copy = document.createElement('canvas');
    copy.width = 100;
    copy.height = 100;
    const ctx = copy.getContext('2d');
    if (!ctx) throw new Error('No 2D context.');
    ctx.drawImage(canvas, 0, 0);
    expect(Array.from(ctx.getImageData(50, 50, 1, 1).data).slice(0, 3)).toEqual([0, 0, 255]);
    renderer.destroy();
  });
});
