import { describe, expect, it } from 'vitest';
import {
  Camera,
  CanvasRenderer,
  type CanvasTarget,
  DisplayList,
  Node,
  Scene,
  Sphere,
} from '../src/index.ts';

const camera = new Camera();

/** A body with a belly reaching out of it, a ball inside it, and an eye decal on it. */
function scene(options: { partialOcclusion?: boolean; yaw?: number } = {}) {
  const root = new Node();
  root.setRotationFromEuler({ x: 0, y: options.yaw ?? 0, z: 0, order: 'XYZ' } as never);
  const body = new Sphere({ id: 'body', diameter: 40, style: { stroke: 0 } });
  body.add(
    new Sphere({
      id: 'belly',
      diameter: 30,
      position: { x: 0, y: 0, z: 12 },
      style: { stroke: 0 },
    }),
  );
  body.add(
    new Sphere({ id: 'inside', diameter: 6, position: { x: 0, y: 0, z: 5 }, style: { stroke: 0 } }),
  );
  body.add(
    new Sphere({
      id: 'eye',
      diameter: 8,
      position: { x: 8, y: -6, z: 17 },
      sortMode: 'attached',
      style: { stroke: 0 },
    }),
  );
  root.add(body);
  const world = new Scene(root);
  const list = new DisplayList(
    options.partialOcclusion === undefined ? {} : { partialOcclusion: options.partialOcclusion },
  ).build(world, camera);
  const byId = (id: string) => {
    for (let i = 0; i < list.count; i++) {
      const item = list.item(i);
      if ((item.node as Node).id === id) return item;
    }
    throw new Error(`no ${id}`);
  };
  return { list, byId, world };
}

describe('sphere cuts', () => {
  it('cut a sphere by the spheres drawn before it that it reaches into', () => {
    const { byId } = scene();
    const body = byId('body');
    expect(byId('belly').sphereCuts).toEqual([body]);
    // Inside the body: cut by it too (to nothing). A decal is clipped instead.
    expect(byId('inside').sphereCuts).toEqual([body]);
    expect(byId('eye').sphereCuts).toEqual([]);
    expect(body.sphereCuts).toEqual([]);
    // With partial occlusion off, nothing is cut, as before.
    const plain = scene({ partialOcclusion: false });
    expect(plain.byId('belly').sphereCuts).toEqual([]);
  });

  it('clip the belly to where it stands out, and leave out a sphere wholly inside', () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get:
          (_, key: string) =>
          (...args: unknown[]) =>
            calls.push(key === 'clip' ? `clip ${args[0] ?? 'nonzero'}` : key),
        set: () => true,
      },
    ) as CanvasTarget;
    const { world } = scene();
    new CanvasRenderer().render(ctx, world, camera, { width: 80, height: 80 });
    // Body, belly and eye are filled; the ball inside the body is not drawn at all.
    expect(calls.filter((call) => call === 'fill')).toHaveLength(3);
    // Two clips: the eye decal's, and the belly's (seen from the front, only the inside of the
    // circle where it meets the body shows).
    expect(calls.filter((call) => call.startsWith('clip'))).toEqual([
      'clip nonzero',
      'clip nonzero',
    ]);
    expect(calls.filter((call) => call === 'save').length).toBe(
      calls.filter((call) => call === 'restore').length,
    );
  });

  it('clip the belly seen from the side by the front arc of the circle and the silhouette', () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get:
          (_, key: string) =>
          (...args: unknown[]) =>
            calls.push(key === 'clip' ? `clip ${args[0] ?? 'nonzero'}` : key),
        set: () => true,
      },
    ) as CanvasTarget;
    const { world } = scene({ yaw: 1.2 });
    new CanvasRenderer().render(ctx, world, camera, { width: 80, height: 80 });
    expect(calls).toContain('clip evenodd');
  });

  /** The calls a frame of `nodes` makes, clips with their rule. */
  function frame(...nodes: Node[]): string[] {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get:
          (_, key: string) =>
          (...args: unknown[]) =>
            calls.push(key === 'clip' ? `clip ${args[0] ?? 'nonzero'}` : key),
        set: () => true,
      },
    ) as CanvasTarget;
    const root = new Node();
    for (const node of nodes) root.add(node);
    new CanvasRenderer().render(ctx, new Scene(root), camera, { width: 120, height: 120 });
    return calls;
  }

  it('cut out the circle where a small sphere in front sinks into a big one drawn after it', () => {
    // The big ball is drawn last (zBias) and the small one in front reaches into its front.
    const big = new Sphere({ diameter: 40, zBias: 100, style: { stroke: 0 } });
    const small = new Sphere({
      diameter: 12,
      position: { x: 0, y: 0, z: 22 },
      style: { stroke: 0 },
    });
    const calls = frame(small, big);
    const clip = calls.indexOf('clip evenodd');
    expect(clip).toBeGreaterThan(0);
    // The big disk, then the whole circle where they meet (a move and 24 lines), cut out.
    const path = calls.slice(calls.lastIndexOf('beginPath', clip), clip);
    expect(path.filter((call) => call === 'arc')).toHaveLength(1);
    expect(path.filter((call) => call === 'lineTo')).toHaveLength(24);
  });

  it('leave out a sphere whose whole front is inside one drawn before it', () => {
    // Behind the big ball's center, its front all inside the big ball; drawn last all the same.
    const big = new Sphere({ diameter: 40, style: { stroke: 0 } });
    const back = new Sphere({
      diameter: 20,
      position: { x: 0, y: 0, z: -15 },
      zBias: 100,
      style: { stroke: 0 },
    });
    expect(frame(big, back).filter((call) => call === 'fill')).toHaveLength(1);
    // Touching from inside on the same depth, it is all inside: not drawn either.
    const inner = new Sphere({
      diameter: 10,
      position: { x: 5, y: 0, z: 0 },
      zBias: 100,
      style: { stroke: 0 },
    });
    const outer = new Sphere({ diameter: 20, style: { stroke: 0 } });
    expect(frame(outer, inner).filter((call) => call === 'fill')).toHaveLength(1);
  });

  it('keep the outline of a belly seen from the front', () => {
    const body = new Sphere({ diameter: 40, style: { stroke: 0 } });
    body.add(
      new Sphere({
        diameter: 30,
        position: { x: 0, y: 0, z: 12 },
        style: { stroke: 0, outline: 2 },
      }),
    );
    // The disk with the outline, the belly's own disk and the circle, even-odd: the circle's
    // inside and the outline band show.
    const calls = frame(body);
    const clip = calls.indexOf('clip evenodd');
    expect(clip).toBeGreaterThan(0);
    const path = calls.slice(calls.lastIndexOf('beginPath', clip), clip);
    expect(path.filter((call) => call === 'arc')).toHaveLength(2);
  });

  it('cut by every sphere reached, give a decal the cuts of its anchor, and forget them when apart', () => {
    const root = new Node();
    const left = new Sphere({
      id: 'left',
      diameter: 30,
      position: { x: -12, y: 0, z: 0 },
      style: { stroke: 0 },
    });
    const right = new Sphere({
      id: 'right',
      diameter: 30,
      position: { x: 12, y: 0, z: 0 },
      style: { stroke: 0 },
    });
    const middle = new Sphere({
      id: 'middle',
      diameter: 16,
      position: { x: 0, y: 0, z: 10 },
      style: { stroke: 0 },
    });
    middle.add(
      new Sphere({
        id: 'pupil',
        diameter: 4,
        position: { x: 0, y: 0, z: 8 },
        sortMode: 'attached',
        style: { stroke: 0 },
      }),
    );
    root.add(left).add(right).add(middle);
    const world = new Scene(root);
    const list = new DisplayList();
    const item = (id: string) => {
      for (let i = 0; i < list.count; i++) {
        if ((list.item(i).node as Node).id === id) return list.item(i);
      }
      throw new Error(`no ${id}`);
    };
    list.build(world, camera);
    expect(new Set(item('middle').sphereCuts)).toEqual(new Set([item('left'), item('right')]));
    expect(item('pupil').cutBase).toBe(item('middle'));
    expect(new Set(item('pupil').sphereCuts)).toEqual(new Set(item('middle').sphereCuts));
    middle.position.set(0, 80, 10);
    list.build(world, camera);
    expect([item('middle').sphereCuts, item('pupil').sphereCuts]).toEqual([[], []]);
  });
});
