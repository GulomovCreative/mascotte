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
import {
  DocumentError,
  type MascotDocument,
  type MotionRef,
  type NodeDocument,
  type PropertyValue,
} from './document.ts';
import { migrate } from './migrate.ts';
import { NODE_TYPES } from './nodes.ts';
import { validateDocument } from './validate.ts';

/** What a document builds: the tree, camera and rig, and how to animate them. */
export interface BuiltMascot {
  readonly view: MascotDocument['view'];
  readonly root: Node;
  readonly camera: Camera;
  readonly rig: Rig;
  /**
   * Sets up the document's layers, state machines, constraints and springs on `animator`,
   * whose scene holds `root` and whose rig is `rig`. Returns the machines in document order
   * and the named constraints.
   */
  animate(animator: Animator): {
    machines: StateMachine[];
    constraints: Record<string, Constraint>;
  };
}

/** Runs `step`, turning an engine error into a `DocumentError` at `path`. */
function at<T>(path: string, step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new DocumentError([{ path, message }]);
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
 * Reads a mascot document (a JSON string or a parsed value): migrates it to the current
 * version and validates it. Throws a `DocumentError` listing every problem.
 */
export function readDocument(input: unknown): MascotDocument {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new DocumentError([{ path: '', message: `not JSON: ${(error as Error).message}` }]);
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
  'motions' | 'layers' | 'machines' | 'constraints' | 'springs'
>;

/**
 * Sets up a document's layers, state machines, constraints and springs on `animator` (see
 * `BuiltMascot.animate`); errors come as a `DocumentError` at the entry's path.
 */
export function animateDocument(
  document: AnimationDocument,
  animator: Animator,
): { machines: StateMachine[]; constraints: Record<string, Constraint> } {
  const motions = document.motions ?? {};
  const resolve = (ref: MotionRef): Motion => {
    const motion = typeof ref === 'string' ? motions[ref] : ref;
    if (motion === undefined) throw new Error(`no motion "${String(ref)}" in motions.`);
    if ('blend' in motion) {
      return {
        ...motion,
        blend: motion.blend.map((point) => ({ ...point, motion: resolve(point.motion) })),
      } as Motion;
    }
    return motion;
  };
  document.layers?.forEach((spec, i) => {
    const { play, ...options } = spec;
    const layer = at(`layers[${i}]`, () => animator.addLayer(options));
    if (play !== undefined && play !== null) {
      at(`layers[${i}].play`, () => layer.play(resolve(play)));
    }
  });
  const machines = (document.machines ?? []).map((spec, i) =>
    at(`machines[${i}]`, () =>
      animator.addStateMachine({
        ...spec,
        states: spec.states.map((state) => ({
          ...state,
          motion:
            state.motion === undefined || state.motion === null ? null : resolve(state.motion),
        })),
      }),
    ),
  );
  const constraints: Record<string, Constraint> = {};
  document.constraints?.forEach((entry, i) => {
    const { name, ...spec } = entry;
    const constraint = at(`constraints[${i}]`, () => animator.addConstraint(spec));
    if (name !== undefined) constraints[name] = constraint;
  });
  document.springs?.forEach((spec, i) => {
    at(`springs[${i}]`, () => animator.addSpring(spec));
  });
  return { machines, constraints };
}

/**
 * Builds a document (as `readDocument` returns it) into engine objects. Errors the engine
 * finds (a bad clip, a target that does not resolve) come as a `DocumentError` with the path
 * of the entry that caused them.
 */
export function buildDocument(document: MascotDocument): BuiltMascot {
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
