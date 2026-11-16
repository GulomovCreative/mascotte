// Mascot document schema, validation, versions and migrations. See docs/PLAN.md, section 7.
export {
  type Animated,
  type AnimationDocument,
  animateDocument,
  type BuiltMascot,
  buildDocument,
  readDocument,
} from './build.ts';
export {
  type BlendDocument,
  type ConstraintDocument,
  DocumentError,
  FORMAT,
  type Issue,
  type LayerDocument,
  type LibraryMotionRef,
  type MachineDocument,
  type MascotDocument,
  type MotionDocument,
  type MotionRef,
  type NodeDocument,
  type PropertyValue,
} from './document.ts';
export { MIGRATIONS, type Migration, migrate, VERSION } from './migrate.ts';
export { NODE_TYPES, type NodeType } from './nodes.ts';
export { MAX_DEPTH, validateDocument } from './validate.ts';
export { writeNode, writeProps } from './write.ts';
