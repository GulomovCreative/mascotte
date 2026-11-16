import {
  type Animator,
  Camera,
  type Constraint,
  findProperty,
  type Motion,
  type Node,
  type Property,
  Rig,
  type StateMachine,
} from '@mascotte/engine';
import { ARCHETYPES, MOTIONS, scaleMotion, usesSize } from '@mascotte/library';
import { type Vec3, vec3 } from '@mascotte/math';
import {
  DocumentError,
  type MascotDocument,
  type MotionDocument,
  type MotionRef,
  type NodeDocument,
  type PropertyValue,
} from './document.ts';
import { migrate } from './migrate.ts';
import { NODE_TYPES } from './nodes.ts';
import { layerKindProblem, validateDocument } from './validate.ts';

/** What a document builds: the tree, camera and rig, and how to animate them. */
export interface BuiltMascot {
  readonly view: MascotDocument['view'];
  readonly root: Node;
  readonly camera: Camera;
  readonly rig: Rig;
  /**
   * Sets up the document's layers, state machines, constraints and springs on `animator`,
   * whose scene holds `root` and whose rig is `rig` (once per animator).
   */
  animate(animator: Animator): Animated;
}

/** What setting up a document's animation gives the page. */
export interface Animated {
  /** The machines, in document order. */
  readonly machines: StateMachine[];
  /** The constraints that have a name (a gaze, say), by name. */
  readonly constraints: ReadonlyMap<string, Constraint>;
}

/** Runs `step`, turning an engine error into a `DocumentError` at `path`. */
function at<T>(path: string, step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DocumentError([{ path, message }], { cause: error });
  }
}

function setProps(
  node: Node,
  props: Readonly<Record<string, PropertyValue>> | undefined,
  path: string,
): void {
  for (const [name, value] of Object.entries(props ?? {})) {
    const property = findProperty(node, name) as Property<Node>;
    at(`${path}.${name}`, () =>
      (property.set as (node: Node, value: unknown) => void)(node, value),
    );
  }
}

function buildNode(document: NodeDocument, path: string): Node {
  const type = NODE_TYPES.get(document.type);
  if (!type) throw new DocumentError([{ path: `${path}.type`, message: 'unknown node type.' }]);
  const node = at(
    path,
    () =>
      new type({
        ...(document.id === undefined ? {} : { id: document.id }),
        ...(document.name === undefined ? {} : { name: document.name }),
        ...(document.path === undefined ? {} : { path: document.path }),
        ...(document.faces === undefined ? {} : { faces: document.faces }),
      }),
  );
  setProps(node, document.props, `${path}.props`);
  document.children?.forEach((child, i) => {
    node.add(buildNode(child, `${path}.children[${i}]`));
  });
  return node;
}

/**
 * Reads a mascot document (a JSON string or a parsed value, which is not changed): migrates it
 * to the current version and validates it. Throws a `DocumentError`: at the first problem with
 * the JSON, format or version, otherwise listing every problem validation finds. Clips,
 * behaviors, machines, constraints and springs are checked by the engine when they are set up
 * (`animateDocument`).
 */
export function readDocument(input: unknown): MascotDocument {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      const message = `not JSON: ${(error as Error).message}`;
      throw new DocumentError([{ path: '', message }], { cause: error });
    }
  }
  const document = migrate(value);
  const issues = validateDocument(document);
  if (issues.length > 0) throw new DocumentError(issues);
  return document as unknown as MascotDocument;
}

/** The part of a document that animates a mascot. */
export type AnimationDocument = Pick<
  MascotDocument,
  'archetype' | 'motions' | 'layers' | 'machines' | 'constraints' | 'springs'
>;

/**
 * The mascot's size by its archetype: the distance between the pivots of the archetype's two
 * size slots, in the space of the root's parent (where library offsets move the root), as the
 * scene holds them now; called before the animator updates, it measures the rest pose.
 */
function sizeOf(archetypeName: string | undefined, animator: Animator): number {
  const archetype = archetypeName === undefined ? undefined : ARCHETYPES.get(archetypeName);
  if (!archetype) throw new Error('library motions that move positions need an archetype.');
  const space = animator.rig?.node('root')?.parent ?? null;
  const [from, to] = archetype.size.map((slot) => {
    const node = animator.rig?.node(slot);
    if (!node) throw new Error(`the rig binds no slot "${slot}" to measure the mascot by.`);
    const world = node.localToWorld(vec3.create(), node.pivot);
    const local = space ? space.worldToLocal(vec3.create(), world) : world;
    if (!local)
      throw new Error("the root's parent is scaled to nothing, so the mascot has no size.");
    return local;
  }) as [Vec3, Vec3];
  const size = vec3.distance(from, to);
  if (!Number.isFinite(size))
    throw new Error(`the mascot's size is not a finite number (${size}).`);
  if (size === 0) {
    throw new Error(
      `the slots ${archetype.size.join(' and ')} are at one point, so the mascot has no size.`,
    );
  }
  return size;
}

/**
 * Sets up a document's layers, state machines, constraints and springs on `animator` (see
 * `BuiltMascot.animate`). Every machine's inputs are declared first, so any layer, state or
 * blend can read them. Library motions are scaled to the mascot's size, measured by its
 * `archetype` on the rest pose. Errors come as a `DocumentError` at the entry's path; what was
 * set up before it stays on the animator, so use a fresh one.
 */
export function animateDocument(document: AnimationDocument, animator: Animator): Animated {
  const motions = document.motions ?? {};
  let size: number | undefined;
  // Resolves a name in `motions`, and turns a library motion's positions into scene units (the
  // size is measured once, on first need).
  const named = (ref: MotionRef): MotionDocument => {
    let motion: MotionDocument;
    if (typeof ref !== 'string') motion = ref;
    else if (Object.hasOwn(motions, ref)) motion = motions[ref] as MotionDocument;
    else throw new Error(`no motion "${ref}" in motions.`);
    if (!('library' in motion)) return motion;
    const entry = MOTIONS.get(motion.library);
    if (!entry) throw new Error(`no library motion "${motion.library}".`);
    if (!usesSize(entry.motion)) return entry.motion as MotionDocument;
    size ??= sizeOf(document.archetype, animator);
    return scaleMotion(entry.motion, size) as MotionDocument;
  };
  // Blends do not nest (the engine refuses a blend point that is a blend), so one level.
  const resolve = (ref: MotionRef): Motion => {
    const motion = named(ref);
    if (!('blend' in motion) || !Array.isArray(motion.blend)) return motion as Motion;
    return {
      ...motion,
      blend: motion.blend.map((point) => ({ ...point, motion: named(point.motion) as Motion })),
    };
  };
  document.machines?.forEach((spec, i) => {
    for (const input of spec.inputs ?? []) {
      at(`machines[${i}].inputs`, () => animator.inputs.define(input));
    }
  });
  // A library motion is written for one kind of layer; on the other it fails without a word.
  const checkKind = (ref: MotionRef, name: string) => {
    // A layer that is not there is the engine's to report.
    const layer = document.layers?.find((spec) => spec.name === name);
    if (!layer) return;
    const problem = layerKindProblem(ref, motions, name, layer.mode ?? 'override');
    if (problem) throw new Error(problem);
  };
  document.layers?.forEach((spec, i) => {
    const { play, ...options } = spec;
    const layer = at(`layers[${i}]`, () => animator.addLayer(options));
    if (play !== undefined && play !== null) {
      at(`layers[${i}].play`, () => {
        checkKind(play, spec.name);
        layer.play(resolve(play));
      });
    }
  });
  const machines = (document.machines ?? []).map((spec, i) =>
    at(`machines[${i}]`, () =>
      animator.addStateMachine({
        ...spec,
        states: spec.states.map((state) => {
          if (state.motion === undefined || state.motion === null)
            return { ...state, motion: null };
          checkKind(state.motion, spec.layer);
          return { ...state, motion: resolve(state.motion) };
        }),
      }),
    ),
  );
  const constraints = new Map<string, Constraint>();
  document.constraints?.forEach((entry, i) => {
    const { name, ...spec } = entry;
    const constraint = at(`constraints[${i}]`, () => animator.addConstraint(spec));
    if (name !== undefined) constraints.set(name, constraint);
  });
  document.springs?.forEach((spec, i) => {
    at(`springs[${i}]`, () => animator.addSpring(spec));
  });
  return { machines, constraints };
}

/**
 * Builds a document of the current version into engine objects; it is validated first. Errors
 * come as a `DocumentError` with a path: from here for the tree, camera and rig, from
 * `animate` for clips, machines, constraints and springs.
 */
export function buildDocument(document: MascotDocument): BuiltMascot {
  const issues = validateDocument(document);
  if (issues.length > 0) throw new DocumentError(issues);
  const root = buildNode(document.root, 'root');
  const camera = new Camera();
  setProps(camera, document.camera?.props, 'camera.props');
  const rig = at('rig.slots', () => new Rig(root, document.rig?.slots ?? {}));
  return {
    view: document.view,
    root,
    camera,
    rig,
    animate: (animator) => animateDocument(document, animator),
  };
}
