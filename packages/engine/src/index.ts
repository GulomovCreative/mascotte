// Сцена, примитивы, сортировка, рендер, анимация и риг. См. docs/PLAN.md, разделы 5.4–5.12.
export {
  Camera,
  type CameraOptions,
  createProjectedPoint,
  type ProjectedPoint,
  type Projection,
} from './scene/camera.ts';
export { AUTO_ID_PREFIX, Node, type NodeOptions } from './scene/node.ts';
export { ObservedQuat, ObservedVec3 } from './scene/observed.ts';
export { Scene } from './scene/scene.ts';
export {
  ARC_HANDLE,
  PathBuilder,
  type PathCommand,
  type PathGeometry,
  PathOp,
  type PathPoint,
} from './shapes/path.ts';
export {
  Ellipse,
  type EllipseOptions,
  Polygon,
  type PolygonOptions,
  Rect,
  type RectOptions,
  RoundedRect,
  type RoundedRectOptions,
} from './shapes/primitives.ts';
export { PathShape, type PathShapeOptions, Shape, type ShapeOptions } from './shapes/shape.ts';
