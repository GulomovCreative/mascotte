import type { Node } from '@mascotte/engine';

/** Версия эталонной сцены на новом ядре. Повороты Zdog {x, y, z} переводятся в {x, -y, z}. */
export interface EngineVersion {
  /** Строит корень сцены. */
  build(): Node;
  /** Положение сцены в момент `time` (секунды). */
  pose(root: Node, time: number): void;
}

/**
 * Эталонная сцена: перенос сцены Zdog на новое ядро. Её кадры сравниваются со снимками,
 * которые нарисовала копия Zdog, пока она была в репозитории (`reference/snapshots/zdog/`).
 */
export interface ReferenceScene {
  readonly id: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  /** Цвет фона кадра. */
  readonly background: string;
  /** Масштаб сцены, как `zoom` в Zdog. */
  readonly zoom: number;
  readonly engine: EngineVersion;
}

export interface RenderOptions {
  pixelRatio?: number;
  time?: number;
}
