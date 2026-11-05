import { mascotEngine } from '../engine/mascot.ts';
import type { ReferenceScene } from '../scene.ts';

/**
 * Простой маскот: голова-сфера с глазами, ушами и ртом. Проверяет порядок отрисовки
 * мелких деталей на поверхности при повороте, где сортировка Zdog по средней глубине ошибается.
 */
export const mascot: ReferenceScene = {
  id: 'mascot',
  title: 'Маскот',
  width: 240,
  height: 240,
  background: '#e8f1f2',
  zoom: 1.5,
  engine: mascotEngine,
};
