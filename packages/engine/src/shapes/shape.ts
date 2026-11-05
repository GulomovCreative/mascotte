import type { Vec3 } from '@mascotte/math';
import { ObservedVec3 } from '../scene/observed.ts';
import type { ParamSchema } from './params.ts';
import {
  PathBuilder,
  type PathCommand,
  type PathGeometry,
  PathOp,
  type PathPoint,
} from './path.ts';
import { Styled, type StyledOptions } from './styled.ts';

export interface ShapeOptions extends StyledOptions {
  /** Whether to close the contour. Defaults to the shape class's `defaultClosed`. */
  closed?: boolean;
  /** Front face direction in local coordinates. */
  front?: Readonly<Vec3>;
}

/**
 * Shape: a node with one path and one style. The geometry is built lazily, in local
 * coordinates, and rebuilt only after parameters change. Transform changes
 * do not touch it: projection uses the world matrix.
 *
 * Numeric parameters of primitives are described by the static `params` schema: subclasses
 * declare the schema, override `buildPath` and read and write parameters through
 * `getParam` and `setParam`, whose names the compiler checks.
 */
export abstract class Shape<S extends ParamSchema = ParamSchema> extends Styled<S> {
  /** Whether the contour is closed by default. */
  static readonly defaultClosed: boolean = true;

  /** Front face direction. Changing it changes only the appearance. */
  readonly front: ObservedVec3;

  #closed: boolean;
  readonly #builder = new PathBuilder();
  readonly #view: { -readonly [K in keyof PathGeometry]: PathGeometry[K] } = {
    ops: new Uint8Array(0),
    points: new Float64Array(0),
    opCount: 0,
    pointCount: 0,
    closed: false,
  };
  #geometryDirty = true;
  #geometryVersion = 0;
  readonly #sortPoint: Vec3 = { x: 0, y: 0, z: 0 };
  #sortPointVersion = -1;

  constructor(options: ShapeOptions = {}) {
    super(options);
    const front = options.front ?? { x: 0, y: 0, z: 1 };
    this.front = new ObservedVec3(() => this.markAppearanceChanged(), front.x, front.y, front.z);
    this.#closed = options.closed ?? (this.constructor as typeof Shape).defaultClosed;
  }

  /** Whether to close the contour. Affects the geometry. */
  get closed(): boolean {
    return this.#closed;
  }
  set closed(value: boolean) {
    if (value !== this.#closed) {
      this.#closed = value;
      this.invalidateGeometry();
    }
  }

  /**
   * Path geometry in local coordinates. Rebuilt lazily; the object is always
   * the same one, and its fields are updated on rebuild.
   */
  get geometry(): PathGeometry {
    if (this.#geometryDirty) {
      const builder = this.#builder.reset();
      this.buildPath(builder);
      builder.finish(this.#closed);
      const view = this.#view;
      view.ops = builder.ops;
      view.points = builder.points;
      view.opCount = builder.opCount;
      view.pointCount = builder.pointCount;
      view.closed = builder.closed;
      this.#geometryDirty = false;
      this.#geometryVersion++;
    }
    return this.#view;
  }

  /** Geometry rebuild counter. Reading it first rebuilds stale geometry. */
  get geometryVersion(): number {
    this.geometry;
    return this.#geometryVersion;
  }

  /**
   * The sort point is the mean of the path command end points, as in Zdog. If the path returns
   * to its start point, the repeat is not counted.
   */
  override getSortPoint(out: Vec3): Vec3 {
    const version = this.geometryVersion;
    const point = this.#sortPoint;
    if (version !== this.#sortPointVersion) {
      const { ops, points, opCount } = this.geometry;
      let x = 0;
      let y = 0;
      let z = 0;
      let index = 0;
      let firstX = 0;
      let firstY = 0;
      let firstZ = 0;
      let lastX = 0;
      let lastY = 0;
      let lastZ = 0;
      for (let op = 0; op < opCount; op++) {
        index += ops[op] === PathOp.cubic ? 3 : 1;
        const i = (index - 1) * 3;
        lastX = points[i] ?? 0;
        lastY = points[i + 1] ?? 0;
        lastZ = points[i + 2] ?? 0;
        if (op === 0) {
          firstX = lastX;
          firstY = lastY;
          firstZ = lastZ;
        }
        x += lastX;
        y += lastY;
        z += lastZ;
      }
      let count = opCount;
      if (count > 2 && lastX === firstX && lastY === firstY && lastZ === firstZ) {
        x -= lastX;
        y -= lastY;
        z -= lastZ;
        count--;
      }
      point.x = x / count;
      point.y = y / count;
      point.z = z / count;
      this.#sortPointVersion = version;
    }
    out.x = point.x;
    out.y = point.y;
    out.z = point.z;
    return out;
  }

  /** Builds the path in local coordinates. */
  protected abstract buildPath(builder: PathBuilder): void;

  /** Marks the geometry stale; the frame with this shape is stale too. */
  protected invalidateGeometry(): void {
    this.#geometryDirty = true;
    this.markChanged();
  }

  protected onParamsChanged(): void {
    this.invalidateGeometry();
  }
}

export interface PathShapeOptions extends ShapeOptions {
  /** Path commands. By default a single point at the origin: a round dot. */
  path?: readonly PathCommand[];
}

/**
 * A shape with an arbitrary path. Without a path it is a round dot the size of the stroke;
 * a path of two points is a segment.
 */
export class PathShape extends Shape {
  static override readonly typeName: string = 'PathShape';
  #path: readonly PathCommand[];

  constructor(options: PathShapeOptions = {}) {
    super(options);
    this.#path = freezePath(options.path ?? DOT);
  }

  get path(): readonly PathCommand[] {
    return this.#path;
  }
  /**
   * The new path. Commands and points are copied and frozen, so changing
   * the source objects does not affect the shape: the path can only be changed by assignment.
   */
  set path(value: readonly PathCommand[]) {
    this.#path = freezePath(value);
    this.invalidateGeometry();
  }

  protected buildPath(builder: PathBuilder): void {
    builder.addCommands(this.#path);
  }
}

function freezePoint(point: PathPoint): Required<PathPoint> {
  return Object.freeze({ x: point.x ?? 0, y: point.y ?? 0, z: point.z ?? 0 });
}

function freezeCommand(command: PathCommand): PathCommand {
  switch (command.type) {
    case 'move':
    case 'line':
      return Object.freeze({ type: command.type, point: freezePoint(command.point) });
    case 'bezier':
      return Object.freeze({
        type: 'bezier',
        control1: freezePoint(command.control1),
        control2: freezePoint(command.control2),
        point: freezePoint(command.point),
      });
    case 'arc':
      return Object.freeze({
        type: 'arc',
        corner: freezePoint(command.corner),
        point: freezePoint(command.point),
      });
  }
}

function freezePath(path: readonly PathCommand[]): readonly PathCommand[] {
  if (path.length === 0) throw new RangeError('Path cannot be empty.');
  return Object.freeze(path.map(freezeCommand));
}

const DOT: readonly PathCommand[] = [{ type: 'move', point: {} }];
