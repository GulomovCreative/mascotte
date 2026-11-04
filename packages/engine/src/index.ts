// Сцена, примитивы, сортировка, рендер, анимация и риг. См. docs/PLAN.md, разделы 5.4–5.12.

export { CanvasRenderer, type CanvasTarget, type Viewport } from './render/canvas.ts';
export { DepthSorter, type Drawable, isDrawable } from './render/depth-sort.ts';
export { DisplayItem, DisplayList } from './render/display-list.ts';
export { ScreenOp, ScreenPath } from './render/screen-path.ts';
export {
  Camera,
  type CameraOptions,
  createProjectedPoint,
  type ProjectedPoint,
  type Projection,
} from './scene/camera.ts';
export {
  AUTO_ID_PREFIX,
  getSortSettingsVersion,
  Node,
  type NodeOptions,
  OWNER_SEPARATOR,
  type SortMode,
} from './scene/node.ts';
export { ObservedQuat, ObservedVec3 } from './scene/observed.ts';
export { Scene } from './scene/scene.ts';
export type { ParamSchema, ParamSpec, StyleParamSpec } from './shapes/params.ts';
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
export {
  BOX_FACES,
  Box,
  type BoxFace,
  type BoxFaceSettings,
  type BoxOptions,
  Capsule,
  type CapsuleOptions,
  Cone,
  type ConeOptions,
  ConeSurface,
  Cylinder,
  CylinderBody,
  type CylinderOptions,
  Hemisphere,
  HemisphereDome,
  type HemisphereOptions,
  Solid,
  type SolidOptions,
  Sphere,
  type SphereOptions,
} from './shapes/solids.ts';
export { ShapeStyle, type ShapeStyleValues } from './shapes/style.ts';
export { Styled, type StyledOptions } from './shapes/styled.ts';
export { Surface, type SurfaceOptions, SurfaceOutline } from './shapes/surface.ts';
