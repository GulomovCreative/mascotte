// Vectors, matrices, quaternions, color, easing functions and deterministic randomness. See docs/PLAN.md, section 5.3.
export type { Color, Oklab } from './color.ts';
export * as color from './color.ts';
export { approxEqual, clamp, EPSILON, lerp, TAU } from './common.ts';
export type { Easing, EasingName, EasingSpec, StepPosition } from './easing.ts';
export * as easing from './easing.ts';
export type { Euler, EulerOrder } from './euler.ts';
export * as euler from './euler.ts';
export type { Mat3x4 } from './mat3x4.ts';
export * as mat3x4 from './mat3x4.ts';
export type { Quat } from './quat.ts';
export * as quat from './quat.ts';
export * as random from './random.ts';
export type { Vec2 } from './vec2.ts';
export * as vec2 from './vec2.ts';
export type { Vec3 } from './vec3.ts';
export * as vec3 from './vec3.ts';
