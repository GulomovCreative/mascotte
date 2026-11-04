import type { Vec3 } from '@mascotte/math';
import { ScreenPath } from '../render/screen-path.ts';
import type { Camera } from '../scene/camera.ts';
import { Node, type NodeOptions } from '../scene/node.ts';
import { type ParamSchema, ParamStore } from './params.ts';
import { ShapeStyle, type ShapeStyleValues } from './shape.ts';

/**
 * Контур экранной поверхности для отрисовки: путь в пикселях относительно центра кадра
 * и параметры кисти. Объект переиспользуется между кадрами.
 */
export class SurfaceOutline {
  readonly path = new ScreenPath();
  /** Толщина обводки в пикселях. */
  lineWidth = 0;
  lineCap: 'round' | 'butt' = 'round';
  stroke = false;
  fill = false;
  color = '#333';
}

export interface SurfaceOptions extends NodeOptions {
  style?: Partial<ShapeStyleValues>;
}

/**
 * Экранная поверхность: часть фигуры, которую нельзя описать трёхмерным путём
 * и которая строится сразу в экранных координатах по камере (сфера, купол полусферы,
 * бок цилиндра, поверхность конуса, капсула). Формулы повторяют Zdog.
 *
 * Отрисовка вызывает `buildOutline` в каждом кадре; метод не создаёт объектов.
 */
export abstract class Surface extends Node {
  static readonly params: ParamSchema = {};

  readonly style: ShapeStyle;
  readonly #params: ParamStore;

  constructor(options: SurfaceOptions = {}) {
    super(options);
    this.style = new ShapeStyle(() => this.markAppearanceChanged(), {
      fill: true,
      ...options.style,
    });
    this.#params = new ParamStore((this.constructor as typeof Surface).params, options, () =>
      this.markAppearanceChanged(),
    );
  }

  /**
   * Строит контур в `out` для камеры `camera`. Возвращает `false`, если рисовать нечего
   * (поверхность не видна с этой стороны или находится за глазом камеры).
   */
  abstract buildOutline(camera: Camera, out: SurfaceOutline): boolean;

  protected getParam(name: string): number {
    return this.#params.get(name);
  }

  protected setParam(name: string, value: number): void {
    this.#params.set(name, value);
  }

  /** Переводит локальную точку узла в пространство камеры. */
  protected toView(camera: Camera, out: Vec3, x: number, y: number, z: number): Vec3 {
    local.x = x;
    local.y = y;
    local.z = z;
    this.localToWorld(out, local);
    return camera.toView(out, out);
  }

  /** Заполняет стиль контура из стиля поверхности. */
  protected applyStyle(out: SurfaceOutline, lineWidth: number): void {
    const style = this.style;
    out.stroke = style.stroke > 0;
    out.fill = style.fill;
    out.color = style.color;
    out.lineWidth = lineWidth;
    out.lineCap = 'round';
  }
}

const local: Vec3 = { x: 0, y: 0, z: 0 };
