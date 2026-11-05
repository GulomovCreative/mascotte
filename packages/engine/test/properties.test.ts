import { quat, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import * as engine from '../src/index.ts';
import {
  Camera,
  Ellipse,
  findProperty,
  Node,
  PathShape,
  Polygon,
  type Property,
  propertiesOf,
  Rect,
  registerProperties,
  Scene,
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
});
