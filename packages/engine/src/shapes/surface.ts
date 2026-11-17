import type { Vec3 } from '@mascotte/math';
import { ScreenPath } from '../render/screen-path.ts';
import type { Camera } from '../scene/camera.ts';
import type { ParamSchema } from './params.ts';
import type { ShapeStyleValues } from './style.ts';
import { Styled, type StyledOptions } from './styled.ts';

/**
 * Outline of a screen surface for drawing: a path in pixels relative to the frame center
 * and brush parameters. The object is reused between frames.
 */
export class SurfaceOutline {
  readonly path = new ScreenPath();
  /** Stroke width in pixels. */
  lineWidth = 0;
  lineCap: 'round' | 'butt' = 'round';
  hasStroke = false;
  hasFill = false;
  color = '#333';

  /**
   * Whether the stroke can be cut by the occluder plane: only strokes without fill
   * whose path points have recorded depth.
   */
  splittable = false;
  /**
   * Occluder for partial occlusion: `sphere` is a circle centered at
   * (`occluderX`, `occluderY`) with radius `occluderRadius`; `capsule` is a segment
   * (`occluderX`, `occluderY`)–(`occluderX2`, `occluderY2`) of thickness 2·`occluderRadius`.
   * Coordinates are in screen space; `occluderDepth` is the depth of the sphere center or of
   * the capsule's cutting plane.
   */
  occluder: 'none' | 'sphere' | 'capsule' = 'none';
  occluderX = 0;
  occluderY = 0;
  occluderX2 = 0;
  occluderY2 = 0;
  occluderRadius = 0;
  occluderDepth = 0;
  /** Pixels per unit of depth for a sphere occluder. */
  occluderScale = 1;

  /**
   * Silhouette clipping: a decal on a sphere is drawn only inside the circle
   * (`clipX`, `clipY`, `clipRadius`) so it does not spill past the edge of a turned head.
   */
  clip: 'none' | 'circle' = 'none';
  clipX = 0;
  clipY = 0;
  clipRadius = 0;

  /**
   * Toon shading (see `render/tone.ts`), set only for a toned style: a `sphere`, the circle
   * (`shadeX`, `shadeY`) of radius `shadeRadius`, or a `capsule`, the segment (`shadeX`,
   * `shadeY`)–(`shadeX2`, `shadeY2`) of that radius, in screen space. The backend draws the
   * item's tones with `shadowColor` and `highlightColor` (`null` for none) besides its color.
   * Kept on the parts of a cut capsule.
   */
  shade: 'none' | 'sphere' | 'capsule' = 'none';
  shadeX = 0;
  shadeY = 0;
  shadeX2 = 0;
  shadeY2 = 0;
  shadeRadius = 0;
  shadowColor: string | null = null;
  highlightColor: string | null = null;

  /** Resets occlusion, clipping and shading data before collection. */
  resetOcclusion(): void {
    this.splittable = false;
    this.occluder = 'none';
    this.clip = 'none';
    this.shade = 'none';
    this.shadowColor = null;
    this.highlightColor = null;
  }

  /** Records the shading of a sphere (center and radius in pixels) if `style` is toned. */
  setSphereShade(style: Readonly<ShapeStyleValues>, x: number, y: number, radius: number): void {
    if (style.shadowColor === null && style.highlightColor === null) return;
    this.shade = 'sphere';
    this.shadeX = x;
    this.shadeY = y;
    this.shadeRadius = radius;
    this.shadowColor = style.shadowColor;
    this.highlightColor = style.highlightColor;
  }

  /** Records the shading of a capsule (axis ends and radius in pixels) if `style` is toned. */
  setCapsuleShade(
    style: Readonly<ShapeStyleValues>,
    x: number,
    y: number,
    x2: number,
    y2: number,
    radius: number,
  ): void {
    if (style.shadowColor === null && style.highlightColor === null) return;
    this.setSphereShade(style, x, y, radius);
    this.shade = 'capsule';
    this.shadeX2 = x2;
    this.shadeY2 = y2;
  }

  /** Records a sphere occluder: center and radius in pixels, center depth, scale. */
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
 * Screen surface: a part of a shape that cannot be described by a 3D path
 * and is built directly in screen coordinates from the camera (sphere, capsule, hemisphere
 * dome, cylinder side, cone surface). The formulas follow Zdog.
 *
 * Drawing calls `buildOutline` every frame. The method creates no objects: the path
 * buffers grow only on the first fill. Perspective is computed from the depth of
 * `perspectiveReference`; the stroke scales together with the node.
 */
export abstract class Surface<S extends ParamSchema = ParamSchema> extends Styled<S> {
  static override readonly defaultStyle = { fill: true };

  /**
   * Builds the outline into `out` for camera `camera`. Returns `false` if there is nothing to draw
   * (the surface is not visible from this side or is behind the camera eye).
   */
  abstract buildOutline(camera: Camera, out: SurfaceOutline): boolean;

  protected onParamsChanged(): void {
    this.markAppearanceChanged();
  }

  /**
   * Perspective and zoom scale from the depth of the reference node, or `null` if the reference
   * node is behind the camera eye.
   */
  protected screenScale(camera: Camera): number | null {
    camera.toView(reference, this.perspectiveReference.getWorldPosition(reference));
    return camera.isInFront(reference.z) ? camera.scaleAt(reference.z) : null;
  }

  /** Converts a local point of the node into camera space. */
  protected toView(camera: Camera, out: Vec3, x: number, y: number, z: number): Vec3 {
    local.x = x;
    local.y = y;
    local.z = z;
    this.localToWorld(out, local);
    return camera.toView(out, out);
  }

  /** Fills the outline brush from the surface style. */
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
