// Scene, primitives, sorting, rendering, animation and rig. See docs/PLAN.md, sections 5.4–5.12.

export {
  type BoolProperty,
  type ColorProperty,
  type EnumProperty,
  findProperty,
  type NumberProperty,
  type Property,
  type PropertyType,
  propertiesOf,
  type QuatProperty,
  registerProperties,
  type Vec3Property,
} from './animation/properties.ts';
export {
  defaultScheduler,
  type FrameScheduler,
  type TickCallback,
  Ticker,
  type TickerOptions,
  type TickSubscription,
} from './animation/ticker.ts';
export { CanvasRenderer, type CanvasTarget, type Viewport } from './render/canvas.ts';
export { DepthSorter, type Drawable, isDrawable } from './render/depth-sort.ts';
export { DisplayItem, DisplayList, type DisplayListOptions } from './render/display-list.ts';
export { IndexBuffer } from './render/gl/buffer.ts';
export {
  Bucket,
  decalAnchor,
  GLCollector,
  type GLFrame,
  type GLLayer,
  MAX_ANCHORS,
  PRIMITIVE_KINDS,
  type PrimitiveKind,
  STRIDE,
} from './render/gl/collect.ts';
export { triangulate } from './render/gl/triangulate.ts';
export {
  PIXEL_BUDGET,
  supersampleFor,
  WebGLRenderer,
  type WebGLRendererOptions,
} from './render/gl/webgl.ts';
export { type Hit, HitTester, type HitViewport } from './render/hit-test.ts';
export { type Cutter, cutValue, type SplitTarget, splitPath } from './render/occlusion.ts';
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
