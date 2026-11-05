import { Node, PathShape, Rect } from '@mascotte/engine';
import { TAU } from '@mascotte/math';
import type { EngineVersion } from '../scene.ts';
import { zdogRotation } from './util.ts';

export const backfaceGroupsEngine: EngineVersion = {
  build() {
    const root = new Node({ rotation: zdogRotation(0, TAU / 2 + 0.4) });
    root
      .add(
        new Rect({
          width: 60,
          height: 60,
          position: { x: -100, y: 0, z: 0 },
          style: { stroke: 4, fill: true, color: '#27a', backfaceVisible: false },
        }),
      )
      .add(
        new Rect({
          width: 60,
          height: 60,
          style: { stroke: 4, fill: true, color: '#27a', backfaceColor: '#e62' },
        }),
      );
    // Like Zdog.Group with updateSort: the group as a whole, sorted by depth inside.
    const group = new Node({ sortMode: 'group', position: { x: 100, y: 0, z: 0 } });
    group
      .add(
        new PathShape({ position: { x: 0, y: 0, z: -20 }, style: { stroke: 40, color: '#3a8' } }),
      )
      .add(
        new PathShape({ position: { x: 0, y: 0, z: 20 }, style: { stroke: 30, color: '#c25' } }),
      );
    root.add(group);
    return root;
  },
  pose(root, time) {
    root.setRotationFromEuler(zdogRotation(0, TAU / 2 + 0.4 + time * 0.8));
  },
};
