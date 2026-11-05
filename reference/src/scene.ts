import type { Node } from '@mascotte/engine';

/** The new-engine version of a reference scene. Zdog rotations {x, y, z} map to {x, -y, z}. */
export interface EngineVersion {
  /** Builds the scene root. */
  build(): Node;
  /** The scene pose at `time` (seconds). */
  pose(root: Node, time: number): void;
}

/**
 * A reference scene: a Zdog scene ported to the new engine. Its frames are compared with the
 * snapshots drawn by the Zdog copy while it was in the repository (`reference/snapshots/zdog/`).
 */
export interface ReferenceScene {
  readonly id: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  /** Frame background color. */
  readonly background: string;
  /** Scene scale, like `zoom` in Zdog. */
  readonly zoom: number;
  readonly engine: EngineVersion;
}

export interface RenderOptions {
  pixelRatio?: number;
  time?: number;
}
