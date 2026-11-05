import { quat, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import * as engine from '../src/index.ts';
import {
  Camera,
  Cylinder,
  Ellipse,
  findProperty,
  Node,
  PathShape,
  Polygon,
  PROJECTIONS,
  type Property,
  propertiesOf,
  Rect,
  registerProperties,
  Scene,
  SORT_MODES,
} from '../src/index.ts';

/** Every concrete node class exported by the engine. */
const NODE_CLASSES = Object.entries(engine).filter(
  ([name, value]) =>
    typeof value === 'function' &&
    (value === Node || value.prototype instanceof Node) &&
    !['Shape', 'Styled', 'Surface', 'Solid'].includes(name),
) as [string, new () => Node][];

function read(property: Property, node: Node): unknown {
  switch (property.type) {
    case 'vec3':
      return { ...property.get(node, vec3.create()) };
    case 'quat':
      return { ...property.get(node, quat.create()) };
    default:
      return property.get(node);
  }
}

/** A valid value different from the default. */
function another(property: Property): unknown {
  switch (property.type) {
    case 'number': {
      const max = property.max ?? Number.POSITIVE_INFINITY;
      return property.default + 1 <= max ? property.default + 1 : property.default - 1;
    }
    case 'bool':
      return !property.default;
    case 'enum':
      return property.values.find((value) => value !== property.default);
    case 'color':
      return '#123456';
    case 'vec3':
      return { x: 1, y: 2, z: 3 };
    case 'quat':
      return { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
  }
}

/** Out of range, the node either throws or clamps: it never accepts the value as is. */
function expectRejectedOrClamped(
  property: Extract<Property, { type: 'number' }>,
  node: Node,
  value: number,
  label: string,
): void {
  try {
    property.set(node, value);
  } catch (error) {
    expect(error, label).toBeInstanceOf(RangeError);
    return;
  }
  const stored = property.get(node);
  expect(stored, label).not.toBe(value);
  if (property.min !== undefined) expect(stored, label).toBeGreaterThanOrEqual(property.min);
  if (property.max !== undefined) expect(stored, label).toBeLessThanOrEqual(property.max);
}

function write(property: Property, node: Node, value: unknown): void {
  (property.set as (node: Node, value: unknown) => void)(node, value);
}

describe('property registry', () => {
  it('covers every concrete node class', () => {
    expect(NODE_CLASSES.length).toBeGreaterThan(15);
    for (const [name, type] of NODE_CLASSES) {
      const properties = propertiesOf(type);
      const names = properties.map((property) => property.name);
      expect(new Set(names).size, name).toBe(names.length);
      for (const base of ['position', 'rotation', 'scale', 'visible', 'opacity']) {
        expect(names, name).toContain(base);
      }
      // A node instance and its class give the same cached list.
      expect(propertiesOf(new type())).toBe(properties);
    }
  });

  it('defaults match what a freshly created node actually has', () => {
    for (const [name, type] of NODE_CLASSES) {
      const node = new type();
      for (const property of propertiesOf(type)) {
        expect(read(property, node), `${name}.${property.name}`).toEqual(property.default);
      }
    }
  });

  it('every property round-trips a new value and marks the scene as changed', () => {
    for (const [name, type] of NODE_CLASSES) {
      for (const property of propertiesOf(type)) {
        const node = new type();
        const scene = new Scene();
        scene.root.add(node);
        const version = scene.changeVersion;
        const value = another(property);
        write(property, node, value);
        const label = `${name}.${property.name}`;
        if (property.type === 'quat') {
          const q = read(property, node) as { x: number; y: number; z: number; w: number };
          const expected = value as typeof q;
          for (const axis of ['x', 'y', 'z', 'w'] as const) {
            expect(q[axis], label).toBeCloseTo(expected[axis], 12);
          }
        } else {
          expect(read(property, node), label).toEqual(value);
        }
        expect(scene.changeVersion, label).toBeGreaterThan(version);
      }
    }
  });

  it('shape parameters come from their schemas with types and ranges', () => {
    expect(findProperty(Rect, 'width')).toMatchObject({
      type: 'number',
      default: 1,
      min: 0,
      integer: false,
    });
    expect(findProperty(Ellipse, 'quarters')).toMatchObject({ min: 1, max: 4, integer: true });
    expect(findProperty(Polygon, 'sides')).toMatchObject({ min: 3, integer: true });
    expect(findProperty(Polygon, 'sides')).not.toHaveProperty('max');
    expect(findProperty(Rect, 'quarters')).toBeNull();
    expect(findProperty(new Camera(), 'zoom')).toMatchObject({ min: 0, exclusiveMin: true });
    expect(findProperty(Rect, 'style.backfaceColor')).toMatchObject({
      type: 'color',
      nullable: true,
      default: null,
    });
  });

  it('structural settings are not animatable', () => {
    expect(findProperty(Node, 'sortMode')?.animatable).toBe(false);
    expect(findProperty(Node, 'layer')?.animatable).toBe(false);
    expect(findProperty(Camera, 'projection')?.animatable).toBe(false);
    expect(findProperty(Node, 'opacity')?.animatable).toBe(true);
  });

  it('writes are validated by the node itself', () => {
    const rect = new Rect();
    expect(() => write(findProperty(rect, 'width') as Property, rect, -1)).toThrow(RangeError);
    const polygon = new Polygon();
    expect(() => write(findProperty(polygon, 'sides') as Property, polygon, 2)).toThrow(RangeError);
    const node = new Node();
    expect(() => write(findProperty(node, 'opacity') as Property, node, Number.NaN)).toThrow(
      RangeError,
    );
  });

  it('reading vectors writes into the given object', () => {
    const node = new Node({ position: { x: 4, y: 5, z: 6 } });
    const property = findProperty(node, 'position');
    if (property?.type !== 'vec3') throw new Error('position must be a vec3');
    const out = vec3.create();
    expect(property.get(node, out)).toBe(out);
    expect({ ...out }).toEqual({ x: 4, y: 5, z: 6 });
  });

  it('custom node types register their own properties on top of inherited ones', () => {
    class Antenna extends PathShape {
      wobble = 0;
    }
    registerProperties(Antenna, [
      {
        name: 'wobble',
        type: 'number',
        animatable: true,
        default: 0,
        integer: false,
        get: (node) => node.wobble,
        set: (node, value) => {
          node.wobble = value;
        },
      },
    ]);
    const names = propertiesOf(Antenna).map((property) => property.name);
    expect(names.at(-1)).toBe('wobble');
    expect(names).toContain('style.color');
    expect(() =>
      registerProperties(Antenna, [
        findProperty(Antenna, 'wobble') as Property<Antenna>,
        findProperty(Antenna, 'wobble') as Property<Antenna>,
      ]),
    ).toThrow(/twice/);
  });

  it('enum values are complete, every value round-trips and unknown values are rejected', () => {
    expect(findProperty(Node, 'sortMode')).toMatchObject({
      values: ['auto', 'group', 'attached', 'layer'],
    });
    expect(SORT_MODES).toEqual(['auto', 'group', 'attached', 'layer']);
    expect(findProperty(Camera, 'projection')).toMatchObject({ values: PROJECTIONS });
    for (const [name, type] of NODE_CLASSES) {
      for (const property of propertiesOf(type)) {
        if (property.type !== 'enum') continue;
        const node = new type();
        for (const value of property.values) {
          property.set(node, value);
          expect(property.get(node), `${name}.${property.name}`).toBe(value);
        }
        expect(() => property.set(node, 'bogus'), `${name}.${property.name}`).toThrow(RangeError);
      }
    }
    expect(() => new Node({ sortMode: 'bogus' as never })).toThrow(RangeError);
    expect(() => new Camera({ projection: 'bogus' as never })).toThrow(RangeError);
  });

  it('every vector and quaternion read writes into the given object', () => {
    for (const [name, type] of NODE_CLASSES) {
      const node = new type();
      for (const property of propertiesOf(type)) {
        if (property.type === 'vec3') {
          const out = vec3.create();
          expect(property.get(node, out), `${name}.${property.name}`).toBe(out);
        } else if (property.type === 'quat') {
          const out = quat.create();
          expect(property.get(node, out), `${name}.${property.name}`).toBe(out);
        }
      }
    }
  });

  it('range metadata matches what the node itself accepts', () => {
    for (const [name, type] of NODE_CLASSES) {
      for (const property of propertiesOf(type)) {
        if (property.type !== 'number') continue;
        const node = new type();
        const label = `${name}.${property.name}`;
        if (property.min !== undefined) {
          if (property.exclusiveMin) {
            expect(() => property.set(node, property.min as number), label).toThrow(RangeError);
          } else {
            expect(() => property.set(node, property.min as number), label).not.toThrow();
          }
          expectRejectedOrClamped(property, node, (property.min as number) - 1, label);
        }
        if (property.max !== undefined) {
          expect(() => property.set(node, property.max as number), label).not.toThrow();
          expectRejectedOrClamped(property, node, (property.max as number) + 1, label);
        }
        if (property.integer) {
          expect(() => property.set(node, property.default + 0.5), label).toThrow(RangeError);
        }
      }
    }
  });

  it('parameters follow the schema the subclass actually uses', () => {
    class Big extends Rect {
      static override readonly params = {
        width: { kind: 'length', default: 10 },
        height: { kind: 'length', default: 1 },
      } as const;
    }
    expect(findProperty(Big, 'width')?.default).toBe(10);
    expect(read(findProperty(Big, 'width') as Property, new Big())).toBe(10);
  });

  it('a subclass registration replaces the inherited property in place', () => {
    class Faded extends PathShape {}
    const opacity = findProperty(Node, 'opacity');
    if (opacity?.type !== 'number') throw new Error('opacity must be a number');
    const before = propertiesOf(Faded).map((property) => property.name);
    registerProperties(Faded, [{ ...opacity, max: 0.5 }]);
    const after = propertiesOf(Faded);
    expect(after.map((property) => property.name)).toEqual(before);
    expect(findProperty(Faded, 'opacity')).toMatchObject({ max: 0.5 });
    expect(findProperty(PathShape, 'opacity')).toMatchObject({ max: 1 });
  });

  it('inherited properties come first: node, style, path shape, parameters', () => {
    const names = propertiesOf(Rect).map((property) => property.name);
    const at = (name: string) => names.indexOf(name);
    expect(at('position')).toBeLessThan(at('style.color'));
    expect(at('style.color')).toBeLessThan(at('front'));
    expect(at('front')).toBeLessThan(at('width'));
  });

  it('registering after a read clears the cached list', () => {
    class Tail extends PathShape {
      sway = 0;
    }
    const before = propertiesOf(Tail);
    registerProperties(Tail, [
      {
        name: 'sway',
        type: 'number',
        animatable: true,
        default: 0,
        integer: false,
        get: (node) => node.sway,
        set: (node, value) => {
          node.sway = value;
        },
      },
    ]);
    expect(before.some((property) => property.name === 'sway')).toBe(false);
    expect(propertiesOf(Tail).some((property) => property.name === 'sway')).toBe(true);
  });

  it('nullable colors accept null and mark the scene as changed', () => {
    for (const [type, name] of [
      [Rect, 'style.backfaceColor'],
      [Cylinder, 'frontFaceColor'],
    ] as const) {
      const node = new type();
      const scene = new Scene();
      scene.root.add(node);
      const property = findProperty(node, name) as Property;
      write(property, node, '#123456');
      const version = scene.changeVersion;
      write(property, node, null);
      expect(read(property, node), name).toBeNull();
      expect(scene.changeVersion, name).toBeGreaterThan(version);
    }
  });

  it('a quaternion is stored as given, without normalization', () => {
    const node = new Node();
    const property = findProperty(node, 'rotation') as Property;
    write(property, node, { x: 0, y: 2, z: 0, w: 0 });
    expect(read(property, node)).toEqual({ x: 0, y: 2, z: 0, w: 0 });
  });

  it('style written on a solid reaches its parts', () => {
    const cylinder = new Cylinder();
    write(findProperty(cylinder, 'style.color') as Property, cylinder, '#abcdef');
    expect(cylinder.frontBase.style.color).toBe('#abcdef');
    expect(cylinder.body.style.color).toBe('#abcdef');
  });
});
