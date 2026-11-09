import type { Quat, Vec3 } from '@mascotte/math';
import { Camera, PROJECTIONS } from '../scene/camera.ts';
import { Node, SORT_MODES } from '../scene/node.ts';
import type { ParamSchema, StyleParamSpec } from '../shapes/params.ts';
import { Shape } from '../shapes/shape.ts';
import { Cylinder } from '../shapes/solids.ts';
import { ShapeStyle, type ShapeStyleValues } from '../shapes/style.ts';
import { Styled } from '../shapes/styled.ts';

/*
 * Property registry: every node type publishes its properties with a type, a default value
 * and a range. Animation clips and the editor inspector read and write nodes through it, so
 * neither needs to know concrete node classes.
 *
 * Values are read and written without allocations: vectors and quaternions are read into
 * an `out` object and copied on write. Writes go through the node's own setters, so they
 * are validated the same way as in code and bump `Scene.changeVersion`.
 */

/** Value types of properties. */
export type PropertyType = 'number' | 'vec3' | 'quat' | 'color' | 'bool' | 'enum';

interface BaseProperty {
  /** Name, a path for nested values: `position`, `style.color`, `width`. */
  readonly name: string;
  readonly type: PropertyType;
  /**
   * Whether animation may change it every frame. Structural settings (`sortMode`, `layer`,
   * `bone`, camera `projection`) are edited only in the inspector, because changing them is
   * expensive (a sort rebuild or a projection switch) or because they describe the rig, not
   * a pose.
   */
  readonly animatable: boolean;
}

export interface NumberProperty<N extends Node = Node> extends BaseProperty {
  readonly type: 'number';
  readonly default: number;
  /** Smallest allowed value, inclusive unless `exclusiveMin`; absent means unbounded. */
  readonly min?: number;
  /** Whether `min` itself is excluded (the value must be strictly greater). */
  readonly exclusiveMin?: boolean;
  /** Largest allowed value, inclusive; absent means unbounded. */
  readonly max?: number;
  /** Whether only integers are allowed. */
  readonly integer: boolean;
  get(node: N): number;
  set(node: N, value: number): void;
}

export interface BoolProperty<N extends Node = Node> extends BaseProperty {
  readonly type: 'bool';
  readonly default: boolean;
  get(node: N): boolean;
  set(node: N, value: boolean): void;
}

export interface EnumProperty<N extends Node = Node> extends BaseProperty {
  readonly type: 'enum';
  readonly default: string;
  readonly values: readonly string[];
  get(node: N): string;
  set(node: N, value: string): void;
}

export interface ColorProperty<N extends Node = Node> extends BaseProperty {
  readonly type: 'color';
  /** CSS color; `null` for optional colors that fall back to another one. */
  readonly default: string | null;
  /** Whether `null` is allowed (for example, a back face color equal to the front). */
  readonly nullable: boolean;
  get(node: N): string | null;
  set(node: N, value: string | null): void;
}

export interface Vec3Property<N extends Node = Node> extends BaseProperty {
  readonly type: 'vec3';
  readonly default: Readonly<Vec3>;
  /** Reads the value into `out` and returns it. */
  get(node: N, out: Vec3): Vec3;
  set(node: N, value: Readonly<Vec3>): void;
}

export interface QuatProperty<N extends Node = Node> extends BaseProperty {
  readonly type: 'quat';
  readonly default: Readonly<Quat>;
  /** Reads the value into `out` and returns it. */
  get(node: N, out: Quat): Quat;
  set(node: N, value: Readonly<Quat>): void;
}

/** Description of one property of a node type. */
export type Property<N extends Node = Node> =
  | NumberProperty<N>
  | BoolProperty<N>
  | EnumProperty<N>
  | ColorProperty<N>
  | Vec3Property<N>
  | QuatProperty<N>;

// biome-ignore lint/suspicious/noExplicitAny: node classes have different constructor signatures.
type NodeClass<N extends Node = Node> = abstract new (...args: any[]) => N;

const own = new Map<NodeClass, readonly Property[]>();
const cache = new Map<NodeClass, readonly Property[]>();

/**
 * Registers the properties a node class adds on top of its parent classes. Use it for
 * custom node types; the engine's own types are registered here. Numeric shape parameters
 * from `static params` are added automatically and need no registration.
 */
export function registerProperties<N extends Node>(
  type: NodeClass<N>,
  properties: readonly Property<N>[],
): void {
  const names = new Set<string>();
  for (const property of properties) {
    if (names.has(property.name)) {
      throw new Error(`Property "${property.name}" is listed twice for ${type.name}.`);
    }
    names.add(property.name);
  }
  own.set(type as NodeClass, properties as readonly Property[]);
  cache.clear();
}

/**
 * All properties of a node or node class: inherited ones first, in registration order.
 * The list is cached per class and frozen; its entries are shared and must not be modified.
 */
export function propertiesOf(target: Node | NodeClass): readonly Property[] {
  const type = (target instanceof Node ? target.constructor : target) as NodeClass;
  let list = cache.get(type);
  if (!list) {
    list = collect(type);
    cache.set(type, list);
  }
  return list;
}

/** Property `name` of a node or node class, or `null` if there is none. */
export function findProperty(target: Node | NodeClass, name: string): Property | null {
  for (const property of propertiesOf(target)) if (property.name === name) return property;
  return null;
}

function collect(type: NodeClass): readonly Property[] {
  // Classes from Node down to `type`.
  const chain: NodeClass[] = [];
  for (let c: unknown = type; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
    chain.unshift(c as NodeClass);
    if (c === Node) break;
  }
  const result: Property[] = [];
  const index = new Map<string, number>();
  // A subclass that registers a name again replaces the inherited entry in place.
  const add = (property: Property) => {
    const at = index.get(property.name);
    if (at === undefined) {
      index.set(property.name, result.length);
      result.push(property);
    } else result[at] = property;
  };
  for (const c of chain) for (const property of own.get(c) ?? []) add(property);
  // Numeric parameters come from the schema the node actually uses, the class's own
  // `params` (static, so inherited unless the class declares its own).
  if (type.prototype instanceof Styled) {
    const schema = (type as unknown as typeof Styled).params;
    for (const [name, spec] of Object.entries(schema)) add(paramProperty(name, spec));
  }
  // Style defaults depend on the class too: solids and surfaces are filled.
  if (type.prototype instanceof Styled) {
    const defaults = (type as unknown as typeof Styled).defaultStyle as Record<string, unknown>;
    for (let i = 0; i < result.length; i++) {
      const property = result[i] as Property;
      const field = property.name.startsWith('style.') ? property.name.slice(6) : null;
      if (field !== null && field in defaults) {
        result[i] = { ...property, default: defaults[field] } as Property;
      }
    }
  }
  // Whether a path is closed by default depends on the class (an ellipse is open).
  if (type.prototype instanceof Shape || (type as unknown) === Shape) {
    const index = result.findIndex((property) => property.name === 'closed');
    const closed = result[index];
    if (closed?.type === 'bool') {
      result[index] = { ...closed, default: (type as unknown as typeof Shape).defaultClosed };
    }
  }
  return Object.freeze(result);
}

/** A numeric shape parameter: read and written through the shape's accessor of the same name. */
function paramProperty(name: string, spec: ParamSchema[string]): NumberProperty {
  const access = (node: Node) => node as unknown as Record<string, number>;
  return {
    name,
    type: 'number',
    animatable: true,
    default: spec.default,
    min: spec.kind === 'length' ? 0 : spec.min,
    ...(spec.kind === 'integer' && spec.max !== undefined ? { max: spec.max } : {}),
    integer: spec.kind === 'integer',
    get: (node) => access(node)[name] as number,
    set: (node, value) => {
      access(node)[name] = value;
    },
  };
}

function vec3Property(
  name: 'position' | 'scale' | 'pivot',
  fallback: Readonly<Vec3>,
): Vec3Property {
  return {
    name,
    type: 'vec3',
    animatable: true,
    default: fallback,
    get(node, out) {
      const v = node[name];
      out.x = v.x;
      out.y = v.y;
      out.z = v.z;
      return out;
    },
    set(node, value) {
      node[name].copy(value);
    },
  };
}

/** A style field: read and written through `node.style`. */
function styleProperty(name: keyof ShapeStyleValues, spec: StyleParamSpec): Property<Styled> {
  const style = (node: Styled) => node.style as unknown as Record<string, unknown>;
  const full = `style.${name}`;
  switch (spec.kind) {
    case 'length':
      return {
        name: full,
        type: 'number',
        animatable: true,
        default: spec.default,
        min: 0,
        integer: false,
        get: (node) => style(node)[name] as number,
        set: (node, value) => {
          style(node)[name] = value;
        },
      };
    case 'boolean':
      return {
        name: full,
        type: 'bool',
        animatable: true,
        default: spec.default,
        get: (node) => style(node)[name] as boolean,
        set: (node, value) => {
          style(node)[name] = value;
        },
      };
    case 'color':
    case 'optionalColor':
      return {
        name: full,
        type: 'color',
        animatable: true,
        default: spec.default,
        nullable: spec.kind === 'optionalColor',
        get: (node) => style(node)[name] as string | null,
        set: (node, value) => {
          style(node)[name] = value;
        },
      };
  }
}

registerProperties(Node, [
  vec3Property('position', { x: 0, y: 0, z: 0 }),
  {
    name: 'rotation',
    type: 'quat',
    animatable: true,
    default: { x: 0, y: 0, z: 0, w: 1 },
    get(node, out) {
      const q = node.rotation;
      out.x = q.x;
      out.y = q.y;
      out.z = q.z;
      out.w = q.w;
      return out;
    },
    set(node, value) {
      node.rotation.copy(value);
    },
  },
  vec3Property('scale', { x: 1, y: 1, z: 1 }),
  vec3Property('pivot', { x: 0, y: 0, z: 0 }),
  {
    name: 'visible',
    type: 'bool',
    animatable: true,
    default: true,
    get: (node) => node.visible,
    set: (node, value) => {
      node.visible = value;
    },
  },
  {
    name: 'opacity',
    type: 'number',
    animatable: true,
    default: 1,
    min: 0,
    max: 1,
    integer: false,
    get: (node) => node.opacity,
    set: (node, value) => {
      node.opacity = value;
    },
  },
  {
    name: 'zBias',
    type: 'number',
    animatable: true,
    default: 0,
    integer: false,
    get: (node) => node.zBias,
    set: (node, value) => {
      node.zBias = value;
    },
  },
  {
    name: 'sortMode',
    type: 'enum',
    animatable: false,
    default: 'auto',
    values: SORT_MODES,
    get: (node) => node.sortMode,
    set: (node, value) => {
      node.sortMode = value as Node['sortMode'];
    },
  },
  {
    name: 'layer',
    type: 'number',
    animatable: false,
    default: 0,
    integer: true,
    get: (node) => node.layer,
    set: (node, value) => {
      node.layer = value;
    },
  },
  {
    name: 'bone',
    type: 'bool',
    animatable: false,
    default: false,
    get: (node) => node.bone,
    set: (node, value) => {
      node.bone = value;
    },
  },
]);

registerProperties(
  Styled,
  Object.entries(ShapeStyle.params).map(([name, spec]) =>
    styleProperty(name as keyof ShapeStyleValues, spec),
  ),
);

registerProperties(Shape, [
  {
    name: 'front',
    type: 'vec3',
    animatable: true,
    default: { x: 0, y: 0, z: 1 },
    get(node, out) {
      out.x = node.front.x;
      out.y = node.front.y;
      out.z = node.front.z;
      return out;
    },
    set(node, value) {
      node.front.copy(value);
    },
  },
  {
    name: 'closed',
    type: 'bool',
    animatable: true,
    // Replaced by the class's `defaultClosed` in `propertiesOf`.
    default: false,
    get: (node) => node.closed,
    set: (node, value) => {
      node.closed = value;
    },
  },
]);

registerProperties(Cylinder, [
  {
    name: 'frontFaceColor',
    type: 'color',
    animatable: true,
    default: null,
    nullable: true,
    get: (node) => node.frontFaceColor,
    set: (node, value) => {
      node.frontFaceColor = value;
    },
  },
]);

registerProperties(Camera, [
  {
    name: 'projection',
    type: 'enum',
    animatable: false,
    default: 'orthographic',
    values: PROJECTIONS,
    get: (node) => node.projection,
    set: (node, value) => {
      node.projection = value as Camera['projection'];
    },
  },
  {
    name: 'zoom',
    type: 'number',
    animatable: true,
    default: 1,
    min: 0,
    exclusiveMin: true,
    integer: false,
    get: (node) => node.zoom,
    set: (node, value) => {
      node.zoom = value;
    },
  },
  {
    name: 'distance',
    type: 'number',
    animatable: true,
    default: 1000,
    min: 0,
    exclusiveMin: true,
    integer: false,
    get: (node) => node.distance,
    set: (node, value) => {
      node.distance = value;
    },
  },
]);
