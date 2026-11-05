import { backfaceGroupsEngine } from '../engine/backface-groups.ts';
import type { ReferenceScene } from '../scene.ts';

/** Скрытие и подмена цвета обратных граней, а также сортировка внутри групп. */
export const backfaceGroups: ReferenceScene = {
  id: 'backface-groups',
  title: 'Обратные грани и группы',
  width: 320,
  height: 200,
  background: '#ffffff',
  zoom: 1,
  engine: backfaceGroupsEngine,
};
