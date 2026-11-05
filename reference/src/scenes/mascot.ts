import { mascotEngine } from '../engine/mascot.ts';
import type { ReferenceScene } from '../scene.ts';

/**
 * A simple mascot: a sphere head with eyes, ears and a mouth. Checks the draw order of small
 * surface details under rotation, where Zdog's mean-depth sorting gets it wrong.
 */
export const mascot: ReferenceScene = {
  id: 'mascot',
  title: 'Mascot',
  width: 240,
  height: 240,
  background: '#e8f1f2',
  zoom: 1.5,
  engine: mascotEngine,
};
