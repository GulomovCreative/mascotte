import { backfaceGroupsEngine } from '../engine/backface-groups.ts';
import type { ReferenceScene } from '../scene.ts';

/** Hiding and recoloring back faces, and sorting inside groups. */
export const backfaceGroups: ReferenceScene = {
  id: 'backface-groups',
  title: 'Back faces and groups',
  width: 320,
  height: 200,
  background: '#ffffff',
  zoom: 1,
  engine: backfaceGroupsEngine,
};
