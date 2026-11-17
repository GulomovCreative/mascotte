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
});
