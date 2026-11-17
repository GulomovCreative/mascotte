import { describe, expect, it } from 'vitest';
import { Camera, type Node, PathShape, Scene, Sphere, SvgRenderer } from '../src/index.ts';

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

const camera = new Camera();

describe('SvgRenderer', () => {
  it('writes a sized document with the background and the frame center', () => {
    const svg = new SvgRenderer().render(sceneWith(), camera, {
      width: 100,
      height: 50,
      pixelRatio: 2,
      background: '#fff',
    });
    expect(
      svg.startsWith(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
      ),
    ).toBe(true);
    expect(svg).toContain('<rect x="0" y="0" width="200" height="100" fill="#fff"/>');
    expect(svg).toContain('<g transform="matrix(2 0 0 2 100 50)">');
    expect(svg.endsWith('</g></svg>')).toBe(true);
  });

  it('draws a circle in two half arcs and a stroke with its brush and opacity', () => {
    const sphere = new Sphere({ diameter: 20, style: { color: '#123456', stroke: 0 } });
    const line = new PathShape({
      path: [
        { type: 'move', point: { x: 0, y: 0, z: 0 } },
        { type: 'line', point: { x: 10, y: 0, z: 0 } },
      ],
      closed: false,
      opacity: 0.5,
      style: { color: 'rgb(1, 2, 3)', stroke: 4 },
    });
    const svg = new SvgRenderer().render(sceneWith(sphere, line), camera, {
      width: 40,
      height: 40,
    });
    expect(svg).toContain('<path d="M10 0A10 10 0 0 1 -10 0A10 10 0 0 1 10 0Z" fill="#123456"/>');
    expect(svg).toContain(
      '<path d="M0 0L10 0" fill="none" stroke="rgb(1, 2, 3)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>',
    );
  });

  it('clips a decal in a group it closes, and escapes colors', () => {
    const head = new Sphere({ diameter: 40, style: { color: '#808080', stroke: 0 } });
    head.add(
      new Sphere({
        diameter: 10,
        position: { x: 0, y: 0, z: 20 },
        sortMode: 'attached',
        style: { color: 'a"b', stroke: 0 },
      }),
    );
    const svg = new SvgRenderer().render(sceneWith(head), camera, { width: 80, height: 80 });
    expect(svg).toContain('<clipPath id="c0">');
    expect(svg).toContain('<g clip-path="url(#c0)">');
    expect(svg).toContain('fill="a&quot;b"');
    expect(svg.split('<g').length).toBe(svg.split('</g>').length);
  });
});
