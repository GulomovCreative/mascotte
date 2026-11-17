import type { Vec3 } from '@mascotte/math';
import type { ShapeStyleValues } from '../shapes/style.ts';

/*
 * Toon shading: a point of a shape takes one of three colors by n·l, the cosine between its
 * normal and the light direction (both in camera space): the shadow color where the point is
 * turned away from the light, the highlight color where it faces it squarely, the base color
 * between. Both backends use these thresholds, so they shade alike: WebGL per pixel, Canvas 2D
 * with outlines of the shaded parts.
 */

/** n·l below this is in shadow: the light's terminator. */
export const SHADOW_BELOW = 0;
/** n·l above this is highlighted: a spot about 26° across around the lit point. */
export const HIGHLIGHT_ABOVE = 0.9;

/**
 * The color of a flat face of `style` with normal `(nx, ny, nz)` in camera space (any length,
 * toward the side drawn), lit from `light` (normalized): `base` unless the style has a shadow
 * or highlight color that the face's tone calls for.
 */
export function faceColor(
  style: Readonly<ShapeStyleValues>,
  base: string,
  nx: number,
  ny: number,
  nz: number,
  light: Readonly<Vec3>,
): string {
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(length > 0)) return base;
  const dot = (nx * light.x + ny * light.y + nz * light.z) / length;
  if (dot < SHADOW_BELOW) return style.shadowColor ?? base;
  if (dot > HIGHLIGHT_ABOVE) return style.highlightColor ?? base;
  return base;
}
