import { TAU, type Vec3 } from '@mascotte/math';
import type { Camera } from '../scene/camera.ts';
import type { ParamSchema } from './params.ts';
import { Ellipse, Rect } from './primitives.ts';
import type { ShapeStyle } from './style.ts';
import { Styled, type StyledOptions } from './styled.ts';
import { Surface, type SurfaceOptions, type SurfaceOutline } from './surface.ts';

/*
 * Solid primitives. The axis of the cylinder, cone, hemisphere and capsule is local z.
 * The formulas of the screen parts follow Zdog, so at scale 1 the image matches
 * it. Unlike Zdog, the stroke scales together with the node.
 */

const o: Vec3 = { x: 0, y: 0, z: 0 };
const a: Vec3 = { x: 0, y: 0, z: 0 };
const b: Vec3 = { x: 0, y: 0, z: 0 };

function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

// ----- surfaces ----- //

const SPHERE_PARAMS = { diameter: { kind: 'length', default: 1 } } as const satisfies ParamSchema;

export interface SphereOptions extends SurfaceOptions {
  diameter?: number;
}

/**
 * Sphere: a circle on screen. The node's scale is assumed uniform: the radius and stroke take
 * the scale along the local x axis. The mascot's head, eye, nose.
 */
export class Sphere extends Surface<typeof SPHERE_PARAMS> {
  static override readonly typeName: string = 'Sphere';
  static override readonly params = SPHERE_PARAMS;

  constructor(options: SphereOptions = {}) {
    super(options);
  }

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  buildOutline(camera: Camera, out: SurfaceOutline): boolean {
    const s = this.screenScale(camera);
    if (s === null) return false;
    this.toView(camera, o, 0, 0, 0);
    this.toView(camera, a, 1, 0, 0);
    const k = length3(a.x - o.x, a.y - o.y, a.z - o.z);
    const radius = (this.diameter / 2) * k * s;
    out.path
      .reset()
      .arc(o.x * s, o.y * s, radius, 0, TAU)
      .close();
    this.applyStyle(out, this.style.stroke * k * s);
    out.setSphereOccluder(o.x * s, o.y * s, radius + out.lineWidth / 2, o.z, s);
    return true;
  }
}

const CAPSULE_PARAMS = {
  length: { kind: 'length', default: 1 },
  diameter: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

export interface CapsuleOptions extends SurfaceOptions {
  /** Axis length between the centers of the end hemispheres. */
  length?: number;
  diameter?: number;
}

/**
 * Capsule: a thick segment with rounded ends along local z, like a Zdog line
 * as thick as the diameter plus the style's stroke. The thickness takes the scale along the local x axis.
 * The mascot's body and limbs.
 */
export class Capsule extends Surface<typeof CAPSULE_PARAMS> {
  static override readonly typeName: string = 'Capsule';
  static override readonly params = CAPSULE_PARAMS;

  constructor(options: CapsuleOptions = {}) {
    super(options);
  }

  get length(): number {
    return this.getParam('length');
  }
  set length(value: number) {
    this.setParam('length', value);
  }

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  buildOutline(camera: Camera, out: SurfaceOutline): boolean {
    const s = this.screenScale(camera);
    if (s === null) return false;
    const half = this.length / 2;
    this.toView(camera, o, 0, 0, 0);
    this.toView(camera, b, 1, 0, 0);
    const k = length3(b.x - o.x, b.y - o.y, b.z - o.z);
    this.toView(camera, a, 0, 0, -half);
    this.toView(camera, b, 0, 0, half);
    const width = (this.diameter + this.style.stroke) * k * s;
    const dx = (b.x - a.x) * s;
    const dy = (b.y - a.y) * s;
    if (dx * dx + dy * dy < 1e-18) {
      // A zero-length segment is not drawn everywhere, so a circle is used instead.
      out.path
        .reset()
        .arc(o.x * s, o.y * s, width / 2, 0, TAU)
        .close();
      this.applyStyle(out, 0);
      out.hasStroke = false;
      out.hasFill = true;
      out.setSphereOccluder(o.x * s, o.y * s, width / 2, o.z, s);
      return true;
    }
    out.path
      .reset()
      .moveTo(a.x * s, a.y * s, a.z)
      .lineTo(b.x * s, b.y * s, b.z);
    this.applyStyle(out, width);
    out.hasStroke = true;
    out.hasFill = false;
    // A capsule is both cut by occluders and occludes itself: the plane goes through the middle of the axis.
    out.splittable = true;
    out.occluder = 'capsule';
    out.occluderX = a.x * s;
    out.occluderY = a.y * s;
    out.occluderX2 = b.x * s;
    out.occluderY2 = b.y * s;
    out.occluderRadius = width / 2;
    out.occluderDepth = o.z;
    return true;
  }
}

const DOME_PARAMS = { diameter: { kind: 'length', default: 1 } } as const satisfies ParamSchema;

/**
 * Hemisphere dome: half a circle on the side of the dome apex (the projection of point +z);
 * the boundary passes through the center perpendicular to the axis projection.
 */
export class HemisphereDome extends Surface<typeof DOME_PARAMS> {
  static override readonly typeName: string = 'HemisphereDome';
  static override readonly params = DOME_PARAMS;

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  buildOutline(camera: Camera, out: SurfaceOutline): boolean {
    const s = this.screenScale(camera);
    if (s === null) return false;
    this.toView(camera, o, 0, 0, 0);
    this.toView(camera, a, 0, 0, 1);
    // Normal as in Zdog: from point +z to the center; its length is the node's scale along the axis.
    const nx = o.x - a.x;
    const ny = o.y - a.y;
    const k = length3(nx, ny, o.z - a.z);
    const contour = Math.atan2(ny, nx);
    out.path
      .reset()
      .arc(o.x * s, o.y * s, (this.diameter / 2) * k * s, contour + TAU / 4, contour - TAU / 4);
    this.applyStyle(out, this.style.stroke * k * s);
    return true;
  }
}

const CYLINDER_BODY_PARAMS = {
  diameter: { kind: 'length', default: 1 },
  length: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

/**
 * Cylinder side surface: a segment between the base centers as thick as the diameter
 * plus the style's stroke, with flat ends.
 */
export class CylinderBody extends Surface<typeof CYLINDER_BODY_PARAMS> {
  static override readonly typeName: string = 'CylinderBody';
  static override readonly params = CYLINDER_BODY_PARAMS;

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  get length(): number {
    return this.getParam('length');
  }
  set length(value: number) {
    this.setParam('length', value);
  }

  buildOutline(camera: Camera, out: SurfaceOutline): boolean {
    const s = this.screenScale(camera);
    if (s === null) return false;
    const half = this.length / 2;
    this.toView(camera, o, 0, 0, 0);
    this.toView(camera, a, 0, 0, 1);
    const k = length3(a.x - o.x, a.y - o.y, a.z - o.z);
    this.toView(camera, a, 0, 0, half);
    this.toView(camera, b, 0, 0, -half);
    out.path
      .reset()
      .moveTo(a.x * s, a.y * s)
      .lineTo(b.x * s, b.y * s);
    this.applyStyle(out, (this.diameter + this.style.stroke) * k * s);
    out.lineCap = 'butt';
    out.hasStroke = true;
    out.hasFill = false;
    return true;
  }
}

const CONE_SURFACE_PARAMS = {
  diameter: { kind: 'length', default: 1 },
  length: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

/**
 * Cone side surface: two tangents from the apex to the base ellipse.
 * Not drawn if the apex is visible inside the base or on its edge.
 */
export class ConeSurface extends Surface<typeof CONE_SURFACE_PARAMS> {
  static override readonly typeName: string = 'ConeSurface';
  static override readonly params = CONE_SURFACE_PARAMS;

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  get length(): number {
    return this.getParam('length');
  }
  set length(value: number) {
    this.setParam('length', value);
  }

  buildOutline(camera: Camera, out: SurfaceOutline): boolean {
    const s = this.screenScale(camera);
    if (s === null) return false;
    this.toView(camera, o, 0, 0, 0);
    this.toView(camera, a, 0, 0, 1);
    const nx = o.x - a.x;
    const ny = o.y - a.y;
    const scale = length3(nx, ny, o.z - a.z);
    this.toView(camera, b, 0, 0, this.length);
    const apexDistance = Math.hypot(b.x - o.x, b.y - o.y);
    const normalDistance = Math.hypot(nx, ny);
    const eccen = Math.sin(Math.acos(Math.min(1, normalDistance / scale)));
    const radius = (this.diameter / 2) * scale;
    // With a degenerate scale this is NaN, and the comparison fails too.
    if (!(radius * eccen < apexDistance)) return false;
    const apexAngle = Math.atan2(ny, nx) + TAU / 2;
    const projectAngle = Math.acos(radius / (apexDistance / eccen));
    const tx = Math.cos(projectAngle) * radius * eccen;
    const ty = Math.sin(projectAngle) * radius;
    const cos = Math.cos(apexAngle);
    const sin = Math.sin(apexAngle);
    // Tangent points: (tx, ±ty), rotated by apexAngle and moved to the base center.
    const ax = o.x + tx * cos - ty * sin;
    const ay = o.y + ty * cos + tx * sin;
    const bx = o.x + tx * cos + ty * sin;
    const by = o.y - ty * cos + tx * sin;
    out.path
      .reset()
      .moveTo(ax * s, ay * s)
      .lineTo(b.x * s, b.y * s)
      .lineTo(bx * s, by * s);
    this.applyStyle(out, this.style.stroke * scale * s);
    return true;
  }
}

// ----- solids ----- //

export type SolidOptions = StyledOptions;

/**
 * Solid: a node that creates child shapes and surfaces
 * (their `owner` is this solid, `id` is `<solid id>/<key>`) and passes them its style
 * and parameters. On every sync the children's style, sizes
 * and position are overwritten, so there is no need to change them directly. The perspective of all parts is computed
 * from the depth of the solid's own origin so the parts do not drift apart.
 *
 * A solid is always sorted as a group; its `sortMode` only sets where the group goes.
 * The side parts (dome, cylinder side, cone surface) have `zBias = -Infinity`
 * and are drawn first within the group, as in Zdog; the cylinder bases and box faces
 * by depth. Decals can be attached to a solid.
 */
export abstract class Solid<S extends ParamSchema = ParamSchema> extends Styled<S> {
  static override readonly defaultStyle = { fill: true };
  /** A solid is always sorted as a whole, with its parts inside it. */
  static override readonly sortsAsGroup = true;

  protected override onStyleChanged(): void {
    this.markAppearanceChanged();
    this.sync();
  }

  protected onParamsChanged(): void {
    this.sync();
  }

  /** Passes style and parameters to the child shapes. Called at the end of the subclass constructor. */
  protected abstract sync(): void;
}

function copyStyle(target: ShapeStyle, source: ShapeStyle, color = source.color): void {
  target.stroke = source.stroke;
  target.fill = source.fill;
  target.color = color;
  target.backfaceVisible = source.backfaceVisible;
  target.backfaceColor = source.backfaceColor;
}

const HEMISPHERE_PARAMS = {
  diameter: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

export interface HemisphereOptions extends SolidOptions {
  diameter?: number;
}

/** Hemisphere: an ellipse base and a dome toward +z. */
export class Hemisphere extends Solid<typeof HEMISPHERE_PARAMS> {
  static override readonly typeName: string = 'Hemisphere';
  static override readonly params = HEMISPHERE_PARAMS;

  readonly base: Ellipse;
  readonly dome: HemisphereDome;

  constructor(options: HemisphereOptions = {}) {
    super(options);
    this.dome = new HemisphereDome({ owner: this, id: 'dome', zBias: Number.NEGATIVE_INFINITY });
    this.base = new Ellipse({ owner: this, id: 'base' });
    this.add(this.dome).add(this.base);
    this.sync();
  }

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  /** Hemisphere centroid: 3/8 of the radius from the base toward the apex, as in Zdog. */
  override getSortPoint(out: Vec3): Vec3 {
    out.x = 0;
    out.y = 0;
    out.z = (this.diameter / 2) * (3 / 8);
    return out;
  }

  protected sync(): void {
    // Style and parameter changes are possible only after the constructor, but the guard
    // is kept in case of a call before the children are created.
    if (!this.base) return;
    copyStyle(this.base.style, this.style);
    copyStyle(this.dome.style, this.style);
    this.base.diameter = this.diameter;
    this.dome.diameter = this.diameter;
  }
}

const CYLINDER_PARAMS = {
  diameter: { kind: 'length', default: 1 },
  length: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

export interface CylinderOptions extends SolidOptions {
  diameter?: number;
  length?: number;
  /** Color of the base visible from the +z side; `null` means the cylinder's `style.backfaceColor`. */
  frontFaceColor?: string | null;
}

/** Cylinder along local z: two bases and a side surface. */
export class Cylinder extends Solid<typeof CYLINDER_PARAMS> {
  static override readonly typeName: string = 'Cylinder';
  static override readonly params = CYLINDER_PARAMS;

  readonly body: CylinderBody;
  readonly frontBase: Ellipse;
  readonly rearBase: Ellipse;
  #frontFaceColor: string | null;

  constructor(options: CylinderOptions = {}) {
    super(options);
    this.#frontFaceColor = options.frontFaceColor ?? null;
    this.body = new CylinderBody({ owner: this, id: 'body', zBias: Number.NEGATIVE_INFINITY });
    // As in Zdog: the front base is turned with its front face inward.
    this.frontBase = new Ellipse({
      owner: this,
      id: 'front',
      rotation: { x: 0, y: Math.PI, z: 0, order: 'XYZ' },
    });
    this.rearBase = new Ellipse({ owner: this, id: 'rear' });
    this.add(this.body).add(this.frontBase).add(this.rearBase);
    this.sync();
  }

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  get length(): number {
    return this.getParam('length');
  }
  set length(value: number) {
    this.setParam('length', value);
  }

  /** Color of the base visible from the +z side; `null` means the cylinder's `style.backfaceColor`. */
  get frontFaceColor(): string | null {
    return this.#frontFaceColor;
  }
  set frontFaceColor(value: string | null) {
    if (value !== this.#frontFaceColor) {
      this.#frontFaceColor = value;
      this.markAppearanceChanged();
      this.sync();
    }
  }

  protected sync(): void {
    if (!this.rearBase) return;
    const { style, diameter, length } = this;
    copyStyle(this.body.style, style);
    for (const base of [this.frontBase, this.rearBase]) {
      copyStyle(base.style, style);
      // The bases are visible from both sides: from outside, their back faces are seen.
      base.style.backfaceVisible = true;
      base.diameter = diameter;
    }
    this.frontBase.style.backfaceColor = this.#frontFaceColor ?? style.backfaceColor;
    this.frontBase.position.z = length / 2;
    this.rearBase.position.z = -length / 2;
    this.body.diameter = diameter;
    this.body.length = length;
  }
}

const CONE_PARAMS = {
  diameter: { kind: 'length', default: 1 },
  length: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

export interface ConeOptions extends SolidOptions {
  diameter?: number;
  /** Height: the distance from the base to the apex along +z. */
  length?: number;
}

/** Cone: an ellipse base and an apex at `length` along +z. */
export class Cone extends Solid<typeof CONE_PARAMS> {
  static override readonly typeName: string = 'Cone';
  static override readonly params = CONE_PARAMS;

  readonly surface: ConeSurface;
  readonly base: Ellipse;

  constructor(options: ConeOptions = {}) {
    super(options);
    this.surface = new ConeSurface({
      owner: this,
      id: 'surface',
      zBias: Number.NEGATIVE_INFINITY,
    });
    this.base = new Ellipse({ owner: this, id: 'base' });
    this.add(this.surface).add(this.base);
    this.sync();
  }

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  get length(): number {
    return this.getParam('length');
  }
  set length(value: number) {
    this.setParam('length', value);
  }

  /** Cone centroid: a third of the height from the base, as in Zdog. */
  override getSortPoint(out: Vec3): Vec3 {
    out.x = 0;
    out.y = 0;
    out.z = this.length / 3;
    return out;
  }

  protected sync(): void {
    if (!this.base) return;
    copyStyle(this.base.style, this.style);
    copyStyle(this.surface.style, this.style);
    this.base.diameter = this.diameter;
    this.surface.diameter = this.diameter;
    this.surface.length = this.length;
  }
}

export const BOX_FACES = ['front', 'rear', 'left', 'right', 'top', 'bottom'] as const;
export type BoxFace = (typeof BOX_FACES)[number];

/** Box face settings. */
export interface BoxFaceSettings {
  visible: boolean;
  /** Custom face color; `null` means the box color. */
  color: string | null;
}

const BOX_PARAMS = {
  width: { kind: 'length', default: 1 },
  height: { kind: 'length', default: 1 },
  depth: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

export interface BoxOptions extends SolidOptions {
  width?: number;
  height?: number;
  depth?: number;
  faces?: Partial<Record<BoxFace, Partial<BoxFaceSettings>>>;
}

/** Box face rotations (Euler angles 'XYZ'); Zdog has the opposite sign of rotation around Y. */
const FACE_ROTATION: Record<BoxFace, { x: number; y: number }> = {
  front: { x: 0, y: 0 },
  rear: { x: 0, y: Math.PI },
  left: { x: 0, y: TAU / 4 },
  right: { x: 0, y: -TAU / 4 },
  top: { x: -TAU / 4, y: 0 },
  bottom: { x: TAU / 4, y: 0 },
};

/** A box of six rectangular faces. Each face can be hidden or recolored. */
export class Box extends Solid<typeof BOX_PARAMS> {
  static override readonly typeName: string = 'Box';
  static override readonly params = BOX_PARAMS;

  readonly faces: Readonly<Record<BoxFace, Rect>>;
  readonly #settings: Record<BoxFace, Readonly<BoxFaceSettings>>;

  constructor(options: BoxOptions = {}) {
    super(options);
    const settings = {} as Record<BoxFace, Readonly<BoxFaceSettings>>;
    const faces = {} as Record<BoxFace, Rect>;
    for (const face of BOX_FACES) {
      const given = options.faces?.[face];
      settings[face] = Object.freeze({
        visible: given?.visible ?? true,
        color: given?.color ?? null,
      });
      const { x, y } = FACE_ROTATION[face];
      faces[face] = new Rect({ owner: this, id: face, rotation: { x, y, z: 0, order: 'XYZ' } });
      this.add(faces[face]);
    }
    this.#settings = settings;
    this.faces = Object.freeze(faces);
    this.sync();
  }

  get width(): number {
    return this.getParam('width');
  }
  set width(value: number) {
    this.setParam('width', value);
  }

  get height(): number {
    return this.getParam('height');
  }
  set height(value: number) {
    this.setParam('height', value);
  }

  get depth(): number {
    return this.getParam('depth');
  }
  set depth(value: number) {
    this.setParam('depth', value);
  }

  getFace(face: BoxFace): Readonly<BoxFaceSettings> {
    return this.#settings[face];
  }

  /** Changes face settings; omitted fields keep their values. */
  setFace(face: BoxFace, settings: Partial<BoxFaceSettings>): void {
    const current = this.#settings[face];
    const visible = settings.visible ?? current.visible;
    const color = settings.color === undefined ? current.color : settings.color;
    if (visible === current.visible && color === current.color) return;
    this.#settings[face] = Object.freeze({ visible, color });
    this.markAppearanceChanged();
    this.sync();
  }

  protected sync(): void {
    if (!this.faces) return;
    const { width, height, depth, style } = this;
    for (const face of BOX_FACES) {
      const rect = this.faces[face];
      const settings = this.#settings[face];
      rect.visible = settings.visible;
      copyStyle(rect.style, style, settings.color ?? style.color);
      const sideways = face === 'left' || face === 'right';
      const flat = face === 'top' || face === 'bottom';
      rect.width = sideways ? depth : width;
      rect.height = flat ? depth : height;
      rect.position.set(
        face === 'left' ? -width / 2 : face === 'right' ? width / 2 : 0,
        face === 'top' ? -height / 2 : face === 'bottom' ? height / 2 : 0,
        face === 'front' ? depth / 2 : face === 'rear' ? -depth / 2 : 0,
      );
    }
  }
}
