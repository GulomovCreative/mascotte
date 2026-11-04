import { Box, Cone, Cylinder, Hemisphere, Node, PathShape } from '@mascotte/engine';
import type { EngineVersion } from '../scene.ts';
import { zdogRotation } from './util.ts';

export const solidPrimitivesEngine: EngineVersion = {
  build() {
    const root = new Node({ rotation: zdogRotation(-0.5, 0.6) });
    root
      .add(
        new Hemisphere({
          diameter: 60,
          position: { x: -90, y: -50, z: 0 },
          style: { stroke: 0, color: '#c25', backfaceColor: '#ea0' },
        }),
      )
      .add(
        new Cylinder({
          diameter: 50,
          length: 50,
          position: { x: 0, y: -50, z: 0 },
          style: { stroke: 0, color: '#3a8', backfaceColor: '#e62' },
        }),
      )
      .add(
        new Cone({
          diameter: 50,
          length: 60,
          position: { x: 90, y: -50, z: 0 },
          style: { stroke: 0, color: '#636', backfaceColor: '#c25' },
        }),
      )
      .add(
        new Box({
          width: 60,
          height: 50,
          depth: 40,
          position: { x: -50, y: 55, z: 0 },
          style: { stroke: 0, color: '#e62' },
          faces: {
            left: { color: '#ea0' },
            right: { color: '#c25' },
            top: { color: '#ed0' },
            bottom: { color: '#636' },
          },
        }),
      )
      .add(
        new PathShape({ position: { x: 60, y: 55, z: 0 }, style: { stroke: 60, color: '#27a' } }),
      );
    return root;
  },
  pose(root, time) {
    root.setRotationFromEuler(zdogRotation(-0.5, 0.6 + time * 0.6));
  },
};
