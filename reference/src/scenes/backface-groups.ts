import Zdog from '@mascotte/zdog-reference';
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
  build() {
    const root = new Zdog.Anchor({ rotate: { y: Zdog.TAU / 2 + 0.4 } });
    new Zdog.Rect({
      addTo: root,
      width: 60,
      height: 60,
      translate: { x: -100 },
      stroke: 4,
      fill: true,
      color: '#27a',
      backface: false,
    });
    new Zdog.Rect({
      addTo: root,
      width: 60,
      height: 60,
      stroke: 4,
      fill: true,
      color: '#27a',
      backface: '#e62',
    });
    const group = new Zdog.Group({ addTo: root, translate: { x: 100 }, updateSort: true });
    new Zdog.Shape({ addTo: group, translate: { z: -20 }, stroke: 40, color: '#3a8' });
    new Zdog.Shape({ addTo: group, translate: { z: 20 }, stroke: 30, color: '#c25' });
    return root;
  },
  pose(root, time) {
    root.rotate.y = Zdog.TAU / 2 + 0.4 + time * 0.8;
  },
  engine: backfaceGroupsEngine,
};
