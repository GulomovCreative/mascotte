import type { Vec3 } from '@mascotte/math';
import { ScreenPath } from '../render/screen-path.ts';
import type { Camera } from '../scene/camera.ts';
import type { ParamSchema } from './params.ts';
import { Styled, type StyledOptions } from './styled.ts';

/**
 * Контур экранной поверхности для отрисовки: путь в пикселях относительно центра кадра
 * и параметры кисти. Объект переиспользуется между кадрами.
 */
export class SurfaceOutline {
  readonly path = new ScreenPath();
  /** Толщина обводки в пикселях. */
  lineWidth = 0;
  lineCap: 'round' | 'butt' = 'round';
  hasStroke = false;
  hasFill = false;
  color = '#333';

  /**
   * Можно ли резать обводку плоскостью перекрывателя: только обводки без заливки,
   * у точек пути которых записана глубина.
   */
  splittable = false;
  /**
   * Перекрыватель для частичного перекрытия: `sphere` — круг с центром
   * (`occluderX`, `occluderY`) и радиусом `occluderRadius`; `capsule` — отрезок
   * (`occluderX`, `occluderY`)–(`occluderX2`, `occluderY2`) толщиной 2·`occluderRadius`.
   * Координаты экранные, `occluderDepth` — глубина центра сферы или плоскости разреза
   * капсулы.
   */
  occluder: 'none' | 'sphere' | 'capsule' = 'none';
  occluderX = 0;
  occluderY = 0;
  occluderX2 = 0;
  occluderY2 = 0;
  occluderRadius = 0;
  occluderDepth = 0;
  /** Пикселей на единицу глубины у перекрывателя-сферы. */
  occluderScale = 1;

  /**
   * Обрезка по силуэту: декаль на сфере рисуется только внутри круга
   * (`clipX`, `clipY`, `clipRadius`), чтобы не выходить за край повёрнутой головы.
   */
  clip: 'none' | 'circle' = 'none';
  clipX = 0;
  clipY = 0;
  clipRadius = 0;

  /** Сбрасывает данные перекрытия и обрезки перед сборкой. */
  resetOcclusion(): void {
    this.splittable = false;
    this.occluder = 'none';
    this.clip = 'none';
  }

  /** Записывает перекрыватель-сферу: центр и радиус в пикселях, глубина центра, масштаб. */
  setSphereOccluder(x: number, y: number, radius: number, depth: number, scale: number): void {
    this.occluder = 'sphere';
    this.occluderX = x;
    this.occluderY = y;
    this.occluderRadius = radius;
    this.occluderDepth = depth;
    this.occluderScale = scale;
  }
}

export type SurfaceOptions = StyledOptions;

/**
 * Экранная поверхность: часть фигуры, которую нельзя описать трёхмерным путём
 * и которая строится сразу в экранных координатах по камере (сфера, капсула, купол
 * полусферы, бок цилиндра, поверхность конуса). Формулы повторяют Zdog.
 *
 * Отрисовка вызывает `buildOutline` в каждом кадре. Метод не создаёт объектов: буферы
 * пути растут только при первом заполнении. Перспектива считается по глубине
 * `perspectiveReference`, обводка масштабируется вместе с узлом.
 */
export abstract class Surface<S extends ParamSchema = ParamSchema> extends Styled<S> {
  static override readonly defaultStyle = { fill: true };

  /**
   * Строит контур в `out` для камеры `camera`. Возвращает `false`, если рисовать нечего
   * (поверхность не видна с этой стороны или находится за глазом камеры).
   */
  abstract buildOutline(camera: Camera, out: SurfaceOutline): boolean;

  protected onParamsChanged(): void {
    this.markAppearanceChanged();
  }

  /**
   * Масштаб перспективы и увеличения по глубине опорного узла или `null`, если опорный
   * узел за глазом камеры.
   */
  protected screenScale(camera: Camera): number | null {
    camera.toView(reference, this.perspectiveReference.getWorldPosition(reference));
    return camera.isInFront(reference.z) ? camera.scaleAt(reference.z) : null;
  }

  /** Переводит локальную точку узла в пространство камеры. */
  protected toView(camera: Camera, out: Vec3, x: number, y: number, z: number): Vec3 {
    local.x = x;
    local.y = y;
    local.z = z;
    this.localToWorld(out, local);
    return camera.toView(out, out);
  }

  /** Заполняет кисть контура из стиля поверхности. */
  protected applyStyle(out: SurfaceOutline, lineWidth: number): void {
    const style = this.style;
    out.hasStroke = style.stroke > 0;
    out.hasFill = style.fill;
    out.color = style.color;
    out.lineWidth = lineWidth;
    out.lineCap = 'round';
  }
}

const local: Vec3 = { x: 0, y: 0, z: 0 };
const reference: Vec3 = { x: 0, y: 0, z: 0 };
