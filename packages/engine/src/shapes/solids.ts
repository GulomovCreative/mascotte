import { TAU, type Vec3 } from '@mascotte/math';
import type { Camera } from '../scene/camera.ts';
import type { ParamSchema } from './params.ts';
import { Ellipse, Rect } from './primitives.ts';
import type { ShapeStyle } from './style.ts';
import { Styled, type StyledOptions } from './styled.ts';
import { Surface, type SurfaceOptions, type SurfaceOutline } from './surface.ts';

/*
 * Объёмные примитивы. Ось у цилиндра, конуса, полусферы и капсулы — локальная z.
 * Формулы экранных частей повторяют Zdog, поэтому при масштабе 1 картинка совпадает
 * с ним. В отличие от Zdog, обводка масштабируется вместе с узлом.
 */

const o: Vec3 = { x: 0, y: 0, z: 0 };
const a: Vec3 = { x: 0, y: 0, z: 0 };
const b: Vec3 = { x: 0, y: 0, z: 0 };

function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

// ----- поверхности ----- //

const SPHERE_PARAMS = { diameter: { kind: 'length', default: 1 } } as const satisfies ParamSchema;

export interface SphereOptions extends SurfaceOptions {
  diameter?: number;
}

/**
 * Сфера: круг на экране. Масштаб узла считается равномерным: радиус и обводка берут
 * масштаб по локальной оси x. Голова маскота, глаз, нос.
 */
export class Sphere extends Surface<typeof SPHERE_PARAMS> {
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
    out.path
      .reset()
      .arc(o.x * s, o.y * s, (this.diameter / 2) * k * s, 0, TAU)
      .close();
    this.applyStyle(out, this.style.stroke * k * s);
    return true;
  }
}

const CAPSULE_PARAMS = {
  length: { kind: 'length', default: 1 },
  diameter: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

export interface CapsuleOptions extends SurfaceOptions {
  /** Длина оси между центрами полусфер на концах. */
  length?: number;
  diameter?: number;
}

/**
 * Капсула: толстый отрезок со скруглёнными концами вдоль локальной z, как линия Zdog
 * толщиной в диаметр плюс обводка стиля. Толщина берёт масштаб по локальной оси x.
 * Тело и конечности маскота.
 */
export class Capsule extends Surface<typeof CAPSULE_PARAMS> {
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
      // Отрезок нулевой длины рисуется не везде, поэтому вместо него — круг.
      out.path
        .reset()
        .arc(o.x * s, o.y * s, width / 2, 0, TAU)
        .close();
      this.applyStyle(out, 0);
      out.hasStroke = false;
      out.hasFill = true;
      return true;
    }
    out.path
      .reset()
      .moveTo(a.x * s, a.y * s)
      .lineTo(b.x * s, b.y * s);
    this.applyStyle(out, width);
    out.hasStroke = true;
    out.hasFill = false;
    return true;
  }
}

const DOME_PARAMS = { diameter: { kind: 'length', default: 1 } } as const satisfies ParamSchema;

/**
 * Купол полусферы: половина круга со стороны вершины купола (проекции точки +z);
 * граница проходит через центр перпендикулярно проекции оси.
 */
export class HemisphereDome extends Surface<typeof DOME_PARAMS> {
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
    // Нормаль как в Zdog: от точки +z к центру; её длина — масштаб узла по оси.
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
 * Боковая поверхность цилиндра: отрезок между центрами оснований толщиной в диаметр
 * плюс обводка стиля, с плоскими концами.
 */
export class CylinderBody extends Surface<typeof CYLINDER_BODY_PARAMS> {
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
 * Боковая поверхность конуса: две касательные от вершины к эллипсу основания.
 * Не рисуется, если вершина видна внутри основания или на его краю.
 */
export class ConeSurface extends Surface<typeof CONE_SURFACE_PARAMS> {
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
    // При вырожденном масштабе здесь NaN, и сравнение тоже даёт отказ.
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
    this.applyStyle(out, this.style.stroke * scale * s);
    return true;
  }
}

// ----- составные фигуры ----- //

export type SolidOptions = StyledOptions;

/**
 * Составная объёмная фигура: узел, который создаёт дочерние фигуры и поверхности
 * (их `owner` — эта фигура, `id` — `«id фигуры»/«ключ»`) и передаёт им свой стиль
 * и параметры. При каждой синхронизации у детей перезаписываются стиль, размеры
 * и положение, поэтому менять их напрямую не нужно. Перспектива всех частей считается
 * по глубине начала самой фигуры, чтобы части не расходились.
 *
 * Фигура всегда сортируется как группа, её `sortMode` задаёт только место группы.
 * Боковые части (купол, бок цилиндра, поверхность конуса) имеют `zBias = -Infinity`
 * и внутри группы рисуются первыми, как в Zdog; основания цилиндра и грани коробки —
 * по глубине. К составной фигуре можно прикреплять декали.
 */
export abstract class Solid<S extends ParamSchema = ParamSchema> extends Styled<S> {
  static override readonly defaultStyle = { fill: true };
  /** Составная фигура всегда сортируется как одно целое, части — внутри неё. */
  static override readonly sortsAsGroup = true;

  protected override onStyleChanged(): void {
    this.markAppearanceChanged();
    this.sync();
  }

  protected onParamsChanged(): void {
    this.sync();
  }

  /** Передаёт стиль и параметры дочерним фигурам. Вызывается в конце конструктора подкласса. */
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

/** Полусфера: основание-эллипс и купол в сторону +z. */
export class Hemisphere extends Solid<typeof HEMISPHERE_PARAMS> {
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

  /** Центроид полусферы: 3/8 радиуса от основания к вершине, как в Zdog. */
  override getSortPoint(out: Vec3): Vec3 {
    out.x = 0;
    out.y = 0;
    out.z = (this.diameter / 2) * (3 / 8);
    return out;
  }

  protected sync(): void {
    // Изменения стиля и параметров возможны только после конструктора, но защита
    // оставлена на случай вызова до создания детей.
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
  /** Цвет основания, видимого со стороны +z; `null` — `style.backfaceColor` цилиндра. */
  frontFaceColor?: string | null;
}

/** Цилиндр вдоль локальной z: два основания и боковая поверхность. */
export class Cylinder extends Solid<typeof CYLINDER_PARAMS> {
  static override readonly params = CYLINDER_PARAMS;

  readonly body: CylinderBody;
  readonly frontBase: Ellipse;
  readonly rearBase: Ellipse;
  #frontFaceColor: string | null;

  constructor(options: CylinderOptions = {}) {
    super(options);
    this.#frontFaceColor = options.frontFaceColor ?? null;
    this.body = new CylinderBody({ owner: this, id: 'body', zBias: Number.NEGATIVE_INFINITY });
    // Как в Zdog: переднее основание развёрнуто лицевой стороной внутрь.
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

  /** Цвет основания, видимого со стороны +z; `null` — `style.backfaceColor` цилиндра. */
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

const CONE_PARAMS = {
  diameter: { kind: 'length', default: 1 },
  length: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

export interface ConeOptions extends SolidOptions {
  diameter?: number;
  /** Высота: расстояние от основания до вершины вдоль +z. */
  length?: number;
}

/** Конус: основание-эллипс и вершина на `length` по +z. */
export class Cone extends Solid<typeof CONE_PARAMS> {
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

  /** Центроид конуса: треть высоты от основания, как в Zdog. */
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

/** Настройки грани коробки. */
export interface BoxFaceSettings {
  visible: boolean;
  /** Свой цвет грани; `null` — цвет коробки. */
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

/** Повороты граней коробки (углы Эйлера 'XYZ'); у Zdog знак поворота вокруг Y обратный. */
const FACE_ROTATION: Record<BoxFace, { x: number; y: number }> = {
  front: { x: 0, y: 0 },
  rear: { x: 0, y: Math.PI },
  left: { x: 0, y: TAU / 4 },
  right: { x: 0, y: -TAU / 4 },
  top: { x: -TAU / 4, y: 0 },
  bottom: { x: TAU / 4, y: 0 },
};

/** Коробка из шести граней-прямоугольников. Каждую грань можно скрыть или перекрасить. */
export class Box extends Solid<typeof BOX_PARAMS> {
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

  /** Меняет настройки грани; пропущенные поля остаются прежними. */
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
