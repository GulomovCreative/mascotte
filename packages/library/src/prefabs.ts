/*
 * Standard part prefabs: subtrees in the document's node form (see `NodeDocument` and
 * `PrefabDocument` in `@mascotte/format`, which expands them; a test checks each one), whose values may be
 * `{ param, times, plus }` references to their parameters. A reference is a whole value, a
 * vector one with vector `times`: never a coordinate inside `{x, y, z}` (see `ParamRef`). The
 * library holds data only, so the shapes are typed loosely here.
 */

/** A parameter of a prefab: its default and range. */
export interface PrefabParam {
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly description?: string;
}

/** A standard prefab: its parameters and its subtree, as document JSON. */
export interface Prefab {
  readonly name: string;
  readonly description: string;
  readonly params: Readonly<Record<string, PrefabParam>>;
  readonly root: Readonly<Record<string, unknown>>;
}

/** A reference to parameter `name`: its value times `times`. */
function of(name: string, times: number | { x: number; y: number; z: number } = 1) {
  return { param: name, times };
}

/** A vector `(x, y, z)` times parameter `name`. */
function along(name: string, x: number, y: number, z: number) {
  return of(name, { x, y, z });
}

const eye: Prefab = {
  name: 'eye',
  description: 'An eye: a white, a pupil looking forward (+z) and a highlight.',
  params: {
    size: { default: 14, min: 2, description: 'The diameter of the white; the pupil is half.' },
  },
  root: {
    type: 'Node',
    children: [
      {
        type: 'Sphere',
        id: 'white',
        props: { diameter: of('size'), 'style.color': '#ffffff', 'style.stroke': 0 },
      },
      {
        type: 'Node',
        id: 'iris',
        props: { position: along('size', 0, 0, 0.3) },
        children: [
          {
            type: 'Sphere',
            id: 'pupil',
            props: { diameter: of('size', 0.5), 'style.color': '#2b1d0e', 'style.stroke': 0 },
          },
          {
            type: 'Sphere',
            id: 'highlight',
            props: {
              diameter: of('size', 0.15),
              position: along('size', -0.1, -0.1, 0.25),
              'style.color': '#ffffff',
              'style.stroke': 0,
            },
          },
        ],
      },
    ],
  },
};

const mouth: Prefab = {
  name: 'mouth',
  description: 'A smiling mouth: a curve as wide as `width` that dips `depth` in the middle.',
  params: {
    width: { default: 16, min: 1 },
    depth: { default: 5, description: 'How far the middle dips; below 0 it frowns.' },
    stroke: { default: 3, min: 0.5 },
  },
  root: {
    type: 'PathShape',
    props: { closed: false, 'style.stroke': of('stroke'), 'style.color': '#5a2a0c' },
    path: [
      { type: 'move', point: along('width', -0.5, 0, 0) },
      {
        type: 'bezier',
        // The controls depend on both: across by the width, down by the depth.
        control1: { ...along('width', -0.25, 0, 0), plus: along('depth', 0, 4 / 3, 0) },
        control2: { ...along('width', 0.25, 0, 0), plus: along('depth', 0, 4 / 3, 0) },
        point: along('width', 0.5, 0, 0),
      },
    ],
  },
};

const ear: Prefab = {
  name: 'ear',
  description: 'An ear: a rounded stroke from its base up `length`, `width` thick.',
  params: {
    length: { default: 14, min: 0 },
    width: { default: 10, min: 1 },
  },
  root: {
    type: 'PathShape',
    props: { closed: false, 'style.stroke': of('width'), 'style.color': '#e0861a' },
    path: [
      { type: 'move', point: { x: 0, y: 0, z: 0 } },
      { type: 'line', point: along('length', 0, -1, 0) },
    ],
  },
};

const paw: Prefab = {
  name: 'paw',
  description: 'A paw: a round pad `size` across.',
  params: { size: { default: 10, min: 1 } },
  root: {
    type: 'Sphere',
    props: { diameter: of('size'), 'style.color': '#e0861a', 'style.stroke': 0 },
  },
};

/** The standard prefabs, by name. */
export const PREFABS: ReadonlyMap<string, Prefab> = new Map(
  [eye, mouth, ear, paw].map((prefab) => [prefab.name, prefab]),
);
