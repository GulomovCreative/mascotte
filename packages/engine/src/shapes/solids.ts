import { TAU, type Vec3 } from '@mascotte/math';
import type { Camera } from '../scene/camera.ts';
import { Node, type NodeOptions } from '../scene/node.ts';
import { type ParamSchema, ParamStore } from './params.ts';
import { Ellipse, Rect } from './primitives.ts';
import { ShapeStyle, type ShapeStyleValues } from './shape.ts';
import { Surface, type SurfaceOptions, type SurfaceOutline } from './surface.ts';

/*
 * Объёмные примитивы. Ось вращения у цилиндра, конуса, полусферы и капсулы — локальная z.
 * Формулы экранных частей повторяют Zdog, поэтому картинка совпадает с ним.
 */

const o: Vec3 = { x: 0, y: 0, z: 0 };
const a: Vec3 = { x: 0, y: 0, z: 0 };
const b: Vec3 = { x: 0, y: 0, z: 0 };

function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

// ----- поверхности ----- //

export interface SphereOptions extends SurfaceOptions {
  diameter?: number;
}

/**
 * Сфера: круг на экране. Масштаб узла считается равномерным (берётся по оси x).
 * Голова маскота, глаз, нос.
 */
export class Sphere extends Surface {
  static override readonly params = {
    diameter: { kind: 'length', default: 1 },
  } as const satisfies ParamSchema;

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
    this.toView(camera, o, 0, 0, 0);
    if (!camera.isInFront(o.z)) return false;
    this.toView(camera, a, 1, 0, 0);
    const s = camera.scaleAt(o.z);
    const k = length3(a.x - o.x, a.y - o.y, a.z - o.z);
    out.path
      .reset()
      .arc(o.x * s, o.y * s, (this.diameter / 2) * k * s, 0, TAU)
      .close();
    this.applyStyle(out, this.style.stroke * s);
    return true;
  }
}

export interface CapsuleOptions extends SurfaceOptions {
  /** Длина оси между центрами полусфер на концах. */
  length?: number;
  diameter?: number;
}

/**
 * Капсула: толстый отрезок со скруглёнными концами вдоль локальной z, как линия Zdog
 * с толщиной во весь диаметр. Тело и конечности маскота.
 */
export class Capsule extends Surface {
  static override readonly params = {
    length: { kind: 'length', default: 1 },
    diameter: { kind: 'length', default: 1 },
  } as const satisfies ParamSchema;

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
    const half = this.length / 2;
    this.toView(camera, o, 0, 0, 0);
    if (!camera.isInFront(o.z)) return false;
    const s = camera.scaleAt(o.z);
    this.toView(camera, a, 0, 0, -half);
    this.toView(camera, b, 1, 0, 0);
    const k = length3(b.x - o.x, b.y - o.y, b.z - o.z);
    this.toView(camera, b, 0, 0, half);
    const width = (this.diameter * k + this.style.stroke) * s;
    const dx = (b.x - a.x) * s;
    const dy = (b.y - a.y) * s;
    if (dx * dx + dy * dy < 1e-18) {
      // Отрезок нулевой длины рисуется не везде, поэтому вместо него — круг.
      out.path
        .reset()
        .arc(o.x * s, o.y * s, width / 2, 0, TAU)
        .close();
      this.applyStyle(out, 0);
      out.stroke = false;
      out.fill = true;
      return true;
    }
    out.path
      .reset()
      .moveTo(a.x * s, a.y * s)
      .lineTo(b.x * s, b.y * s);
    this.applyStyle(out, width);
    out.stroke = true;
    out.fill = false;
    return true;
  }
}

/** Купол полусферы: половина круга со стороны, обратной лицевой стороне основания. */
export class HemisphereDome extends Surface {
  static override readonly params = {
    diameter: { kind: 'length', default: 1 },
  } as const satisfies ParamSchema;

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  buildOutline(camera: Camera, out: SurfaceOutline): boolean {
    this.toView(camera, o, 0, 0, 0);
    if (!camera.isInFront(o.z)) return false;
    this.toView(camera, a, 0, 0, 1);
    const s = camera.scaleAt(o.z);
    // Нормаль как в Zdog: от лицевой точки к центру.
    const nx = o.x - a.x;
    const ny = o.y - a.y;
    const contour = Math.atan2(ny, nx);
    const radius = (this.diameter / 2) * length3(nx, ny, o.z - a.z) * s;
    out.path.reset().arc(o.x * s, o.y * s, radius, contour + TAU / 4, contour - TAU / 4);
    this.applyStyle(out, this.style.stroke * s);
    return true;
  }
}

/** Боковая поверхность цилиндра: отрезок между центрами оснований толщиной в диаметр. */
export class CylinderBody extends Surface {
  static override readonly params = {
    diameter: { kind: 'length', default: 1 },
    length: { kind: 'length', default: 1 },
  } as const satisfies ParamSchema;

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
    const half = this.length / 2;
    this.toView(camera, o, 0, 0, 0);
    if (!camera.isInFront(o.z)) return false;
    const s = camera.scaleAt(o.z);
    this.toView(camera, a, 0, 0, 1);
    const k = length3(a.x - o.x, a.y - o.y, a.z - o.z);
    this.toView(camera, a, 0, 0, half);
    this.toView(camera, b, 0, 0, -half);
    out.path
      .reset()
      .moveTo(a.x * s, a.y * s)
      .lineTo(b.x * s, b.y * s);
    this.applyStyle(out, (this.diameter * k + this.style.stroke) * s);
    out.lineCap = 'butt';
    out.stroke = true;
    out.fill = false;
    return true;
  }
}

/**
 * Боковая поверхность конуса: две касательные от вершины к эллипсу основания.
 * Не рисуется, если вершина видна внутри основания.
 */
export class ConeSurface extends Surface {
  static override readonly params = {
    diameter: { kind: 'length', default: 1 },
    length: { kind: 'length', default: 1 },
  } as const satisfies ParamSchema;

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
    this.toView(camera, o, 0, 0, 0);
    if (!camera.isInFront(o.z)) return false;
    const s = camera.scaleAt(o.z);
    this.toView(camera, a, 0, 0, 1);
    const nx = o.x - a.x;
    const ny = o.y - a.y;
    const scale = length3(nx, ny, o.z - a.z);
    this.toView(camera, b, 0, 0, this.length);
    const apexDistance = Math.hypot(b.x - o.x, b.y - o.y);
    const normalDistance = Math.hypot(nx, ny);
    const eccen = Math.sin(Math.acos(Math.min(1, normalDistance / scale)));
    const radius = (this.diameter / 2) * scale;
    if (!(radius * eccen < apexDistance)) return false;
    const apexAngle = Math.atan2(ny, nx) + TAU / 2;
    const projectAngle = Math.acos(radius / (apexDistance / eccen));
    const tx = Math.cos(projectAngle) * radius * eccen;
    const ty = Math.sin(projectAngle) * radius;
    const cos = Math.cos(apexAngle);
    const sin = Math.sin(apexAngle);
    // Касательные точки: (tx, ±ty), повёрнутые на apexAngle и сдвинутые в центр основания.
    const ax = o.x + tx * cos - ty * sin;
    const ay = o.y + ty * cos + tx * sin;
    const bx = o.x + tx * cos + ty * sin;
    const by = o.y - ty * cos + tx * sin;
    out.path
      .reset()
      .moveTo(ax * s, ay * s)
      .lineTo(b.x * s, b.y * s)
      .lineTo(bx * s, by * s);
    this.applyStyle(out, this.style.stroke * s);
    return true;
  }
}

// ----- составные фигуры ----- //

export interface SolidOptions extends NodeOptions {
  style?: Partial<ShapeStyleValues>;
}

/**
 * Составная объёмная фигура: узел, который владеет дочерними фигурами и поверхностями
 * и передаёт им свой стиль и параметры. Дети создаются самой фигурой; менять их
 * напрямую не нужно — изменения перезапишутся при следующей синхронизации.
 */
export abstract class Solid extends Node {
  static readonly params: ParamSchema = {};

  readonly style: ShapeStyle;
  readonly #params: ParamStore;

  constructor(options: SolidOptions = {}) {
    super(options);
    this.style = new ShapeStyle(
      () => {
        this.markAppearanceChanged();
        this.sync();
      },
      { fill: true, ...options.style },
    );
    this.#params = new ParamStore((this.constructor as typeof Solid).params, options, () =>
      this.sync(),
    );
  }

  /** Передаёт стиль и параметры дочерним фигурам. */
  protected abstract sync(): void;

  protected getParam(name: string): number {
    return this.#params.get(name);
  }

  protected setParam(name: string, value: number): void {
    this.#params.set(name, value);
  }
}

function copyStyle(target: ShapeStyle, source: ShapeStyle, color = source.color): void {
  target.stroke = source.stroke;
  target.fill = source.fill;
  target.color = color;
  target.backfaceVisible = source.backfaceVisible;
  target.backfaceColor = source.backfaceColor;
}

export interface HemisphereOptions extends SolidOptions {
  diameter?: number;
}

/** Полусфера: основание-эллипс и купол в сторону +z. */
export class Hemisphere extends Solid {
  static override readonly params = {
    diameter: { kind: 'length', default: 1 },
  } as const satisfies ParamSchema;

  readonly base: Ellipse;
  readonly dome: HemisphereDome;

  constructor(options: HemisphereOptions = {}) {
    super(options);
    this.dome = new HemisphereDome();
    this.base = new Ellipse();
    this.add(this.dome).add(this.base);
    this.sync();
  }

  get diameter(): number {
    return this.getParam('diameter');
  }
  set diameter(value: number) {
    this.setParam('diameter', value);
  }

  protected sync(): void {
    if (!this.base) return;
    copyStyle(this.base.style, this.style);
    copyStyle(this.dome.style, this.style);
    this.base.diameter = this.diameter;
    this.dome.diameter = this.diameter;
  }
}

export interface CylinderOptions extends SolidOptions {
  diameter?: number;
  length?: number;
  /** Цвет основания со стороны +z; `null` — как у обратной стороны. */
  frontFaceColor?: string | null;
}

/** Цилиндр вдоль локальной z: два основания и боковая поверхность. */
export class Cylinder extends Solid {
  static override readonly params = {
    diameter: { kind: 'length', default: 1 },
    length: { kind: 'length', default: 1 },
  } as const satisfies ParamSchema;

  readonly body: CylinderBody;
  readonly frontBase: Ellipse;
  readonly rearBase: Ellipse;
  #frontFaceColor: string | null;

  constructor(options: CylinderOptions = {}) {
    super(options);
    this.#frontFaceColor = options.frontFaceColor ?? null;
    this.body = new CylinderBody();
    // Как в Zdog: переднее основание развёрнуто лицевой стороной внутрь.
    this.frontBase = new Ellipse({ rotation: { x: 0, y: Math.PI, z: 0, order: 'XYZ' } });
    this.rearBase = new Ellipse();
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
    if (!this.body) return;
    const { style, diameter, length } = this;
    copyStyle(this.body.style, style);
    for (const base of [this.frontBase, this.rearBase]) {
      copyStyle(base.style, style);
      // Основания видны с обеих сторон: снаружи смотрят их обратные стороны.
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

export interface ConeOptions extends SolidOptions {
  diameter?: number;
  /** Высота: расстояние от основания до вершины вдоль +z. */
  length?: number;
}

/** Конус: основание-эллипс и вершина на `length` по +z. */
export class Cone extends Solid {
  static override readonly params = {
    diameter: { kind: 'length', default: 1 },
    length: { kind: 'length', default: 1 },
  } as const satisfies ParamSchema;

  readonly surface: ConeSurface;
  readonly base: Ellipse;

  constructor(options: ConeOptions = {}) {
    super(options);
    this.surface = new ConeSurface();
    this.base = new Ellipse();
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

/** Грань коробки: `true` — цвет коробки, `false` — грани нет, строка — свой цвет. */
export type BoxFaceValue = boolean | string;

export interface BoxOptions extends SolidOptions {
  width?: number;
  height?: number;
  depth?: number;
  faces?: Partial<Record<BoxFace, BoxFaceValue>>;
}

/** Повороты граней коробки (углы Эйлера 'XYZ'); у Zdog знак поворота вокруг Y обратный. */
const FACE_ROTATION: Record<BoxFace, { x: number; y: number }> = {
  front: { x: 0, y: 0 },
  rear: { x: 0, y: Math.PI },
  left: { x: 0, y: TAU / 4 },
  right: { x: 0, y: -TAU / 4 },
  top: { x: -TAU / 4, y: 0 },
  bottom: { x: TAU / 4, y: 0 },
};

/** Коробка из шести граней-прямоугольников. Каждую грань можно убрать или перекрасить. */
export class Box extends Solid {
  static override readonly params = {
    width: { kind: 'length', default: 1 },
    height: { kind: 'length', default: 1 },
    depth: { kind: 'length', default: 1 },
  } as const satisfies ParamSchema;

  readonly faces: Readonly<Record<BoxFace, Rect>>;
  readonly #faceValues: Record<BoxFace, BoxFaceValue>;

  constructor(options: BoxOptions = {}) {
    super(options);
    const values = {} as Record<BoxFace, BoxFaceValue>;
    const faces = {} as Record<BoxFace, Rect>;
    for (const face of BOX_FACES) {
      values[face] = options.faces?.[face] ?? true;
      const { x, y } = FACE_ROTATION[face];
      faces[face] = new Rect({ rotation: { x, y, z: 0, order: 'XYZ' } });
      this.add(faces[face]);
    }
    this.#faceValues = values;
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

  getFace(face: BoxFace): BoxFaceValue {
    return this.#faceValues[face];
  }

  setFace(face: BoxFace, value: BoxFaceValue): void {
    if (value !== this.#faceValues[face]) {
      this.#faceValues[face] = value;
      this.markAppearanceChanged();
      this.sync();
    }
  }

  protected sync(): void {
    if (!this.faces) return;
    const { width, height, depth, style } = this;
    for (const face of BOX_FACES) {
      const rect = this.faces[face];
      const value = this.#faceValues[face];
      rect.visible = value !== false;
      copyStyle(rect.style, style, typeof value === 'string' ? value : style.color);
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
