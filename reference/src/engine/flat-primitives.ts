import { Ellipse, Node, PathShape, Polygon, Rect, RoundedRect } from '@mascotte/engine';
import type { EngineVersion } from '../scene.ts';
import { zdogRotation } from './util.ts';

export const flatPrimitivesEngine: EngineVersion = {
  build() {
    const root = new Node({ rotation: zdogRotation(-0.35, 0.5) });
    root
      .add(
        new Rect({
          width: 60,
          height: 40,
          position: { x: -100, y: -60, z: 0 },
          style: { stroke: 6, color: '#e62' },
        }),
      )
      .add(
        new RoundedRect({
          width: 60,
          height: 40,
          cornerRadius: 12,
          position: { x: 0, y: -60, z: 0 },
          style: { stroke: 4, fill: true, color: '#c25' },
        }),
      )
      .add(
        new Ellipse({
          diameter: 50,
          position: { x: 100, y: -60, z: 0 },
          style: { stroke: 8, color: '#636' },
        }),
      )
      .add(
        new Ellipse({
          width: 60,
          height: 36,
          quarters: 2,
          position: { x: -100, y: 40, z: 0 },
          style: { stroke: 6, color: '#ea0' },
        }),
      )
      .add(
        new Polygon({
          radius: 30,
          sides: 5,
          position: { x: 0, y: 40, z: 0 },
          style: { stroke: 4, fill: true, color: '#3a8' },
        }),
      )
      .add(
        new PathShape({
          path: [
            { type: 'move', point: { x: -20, y: -20 } },
            { type: 'arc', corner: { x: 20, y: -20 }, point: { x: 20, y: 20 } },
            {
              type: 'bezier',
              control1: { x: 0, y: 0 },
              control2: { x: 0, y: 40 },
              point: { x: -20, y: 20 },
            },
          ],
          closed: false,
          position: { x: 100, y: 40, z: 0 },
          style: { stroke: 5, color: '#27a' },
        }),
      )
      .add(
        new PathShape({ position: { x: -40, y: 100, z: 0 }, style: { stroke: 20, color: '#333' } }),
      )
      .add(
        new PathShape({
          path: [
            { type: 'move', point: { x: -30 } },
            { type: 'line', point: { x: 30 } },
          ],
          position: { x: 40, y: 100, z: 0 },
          style: { stroke: 6, color: '#333' },
        }),
      );
    return root;
  },
  pose(root, time) {
    root.setRotationFromEuler(zdogRotation(-0.35, 0.5 + time * 0.6));
  },
};
