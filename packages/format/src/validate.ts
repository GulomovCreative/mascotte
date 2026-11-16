import {
  BLEND_MODES,
  type BlendMode,
  BOX_FACES,
  Camera,
  CONSTRAINT_KINDS,
  findProperty,
  type Node,
  type Property,
  propertiesOf,
  SLOT_NAME_PATTERN,
} from '@mascotte/engine';
import { ARCHETYPES, type LibraryMotion, MOTIONS, slotsOf, usesSize } from '@mascotte/library';
import { color } from '@mascotte/math';
import {
  FORMAT,
  type Issue,
  type LayerDocument,
  type MascotDocument,
  type NodeDocument,
} from './document.ts';
import { NODE_TYPES, type NodeType } from './nodes.ts';
import { expandDocument } from './prefabs.ts';

/*
 * Structural validation of a document of the current version. Node properties are checked
 * against the engine's property registry (types, ranges, enum values, colors), and names that
 * refer to each other (slot ids, motion names, machine layers, the archetype, library motions)
 * are checked to exist; the rig must bind the slots of the archetype and of every library motion,
 * which must play on its kind of layer. The contents of clips, behaviors, machines, constraints
 * and springs are checked by the engine when the animation is set up (`animateDocument`); its
 * errors carry the path of the entry (a layer, a machine, a constraint, a spring), and a named
 * motion is reported where it is played.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function list(values: Iterable<string>): string {
  return [...values].join(', ');
}

class Checker {
  readonly issues: Issue[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  /** Reports keys of `value` not in `known`. */
  keys(value: Json, known: readonly string[], path: string): void {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        this.fail(join(path, key), `unknown field (expected one of ${list(known)}).`);
      }
    }
  }

  object(value: unknown, path: string, what: string): value is Json {
    if (isObject(value)) return true;
    this.fail(path, `expected ${what}, got ${show(value)}.`);
    return false;
  }

  array(value: unknown, path: string, what: string): value is unknown[] {
    if (Array.isArray(value)) return true;
    this.fail(path, `expected an array of ${what}, got ${show(value)}.`);
    return false;
  }

  string(value: unknown, path: string): value is string {
    if (typeof value === 'string' && value !== '') return true;
    this.fail(path, `expected a non-empty string, got ${show(value)}.`);
    return false;
  }

  number(value: unknown, path: string, min = -Infinity, exclusive = false): value is number {
    const ok =
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (exclusive ? value > min : value >= min);
    if (ok) return true;
    let range = '';
    if (min !== -Infinity) range = exclusive ? ` above ${min}` : ` at least ${min}`;
    this.fail(path, `expected a finite number${range}, got ${show(value)}.`);
    return false;
  }
}

function join(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return path === '' ? key : `${path}.${key}`;
}

/**
 * The fields of a document type, listed once: the compiler checks they are all its fields and
 * none is missing, so the list cannot drift from the type.
 */
function fields<T>() {
  return <const K extends readonly (keyof T & string)[]>(
    keys: K & (Exclude<keyof T, K[number]> extends never ? unknown : never),
  ): K => keys;
}

const NODE_KEYS = fields<NodeDocument>()([
  'type',
  'prefab',
  'params',
  'id',
  'name',
  'props',
  'path',
  'faces',
  'children',
]);
const DOCUMENT_KEYS = fields<MascotDocument>()([
  'format',
  'version',
  'meta',
  'params',
  'prefabs',
  'archetype',
  'view',
  'camera',
  'root',
  'rig',
  'motions',
  'layers',
  'machines',
  'constraints',
  'springs',
]);
const META_KEYS = fields<MascotDocument['meta']>()(['name', 'description']);
const VIEW_KEYS = fields<MascotDocument['view']>()(['width', 'height', 'background']);
const LAYER_KEYS = fields<LayerDocument>()(['name', 'mode', 'weight', 'mask', 'play']);

/** Trees deeper than this are refused, so checking and building them cannot overflow the stack. */
export const MAX_DEPTH = 64;

function checkVector(c: Checker, value: unknown, path: string, axes: readonly string[]): void {
  if (!c.object(value, path, `an object with ${list(axes)}`)) return;
  c.keys(value, axes, path);
  for (const axis of axes) c.number(value[axis], join(path, axis));
}

/** Checks a value against a registry property. */
function checkValue(c: Checker, property: Property, value: unknown, path: string): void {
  switch (property.type) {
    case 'number': {
      if (!c.number(value, path)) return;
      const { min, max, exclusiveMin, integer } = property;
      if (integer && !Number.isInteger(value)) c.fail(path, `expected an integer, got ${value}.`);
      if (min !== undefined && (exclusiveMin ? value <= min : value < min)) {
        c.fail(
          path,
          `expected a number ${exclusiveMin ? 'above' : 'at least'} ${min}, got ${value}.`,
        );
      }
      if (max !== undefined && value > max) c.fail(path, `expected at most ${max}, got ${value}.`);
      return;
    }
    case 'bool':
      if (typeof value !== 'boolean') c.fail(path, `expected true or false, got ${show(value)}.`);
      return;
    case 'enum':
      if (typeof value !== 'string' || !property.values.includes(value)) {
        c.fail(path, `expected one of ${list(property.values)}, got ${show(value)}.`);
      }
      return;
    case 'color':
      if (value === null && property.nullable) return;
      if (typeof value !== 'string' || color.parse(value) === null) {
        const or = property.nullable ? ' or null' : '';
        c.fail(path, `expected a CSS color${or}, got ${show(value)}.`);
      }
      return;
    case 'vec3':
      checkVector(c, value, path, ['x', 'y', 'z']);
      return;
    case 'quat': {
      checkVector(c, value, path, ['x', 'y', 'z', 'w']);
      if (!isObject(value)) return;
      const { x = 0, y = 0, z = 0, w = 0 } = value as Record<string, number>;
      // A longer or shorter quaternion would scale the node as well as turn it.
      const length = Math.hypot(x, y, z, w);
      if (Math.abs(length - 1) > 1e-6) {
        c.fail(path, `expected a unit quaternion, got one of length ${length}.`);
      }
    }
  }
}

function checkProps(
  c: Checker,
  type: NodeType | typeof Camera,
  value: unknown,
  path: string,
): void {
  if (!c.object(value, path, 'an object of properties')) return;
  for (const [name, item] of Object.entries(value)) {
    const property = findProperty(type as unknown as typeof Node, name);
    if (property === null) {
      const known = propertiesOf(type as unknown as typeof Node).map((p) => p.name);
      c.fail(
        join(path, name),
        `${type.typeName} has no property "${name}" (it has ${list(known)}).`,
      );
      continue;
    }
    checkValue(c, property, item, join(path, name));
  }
}

function checkPoint(c: Checker, value: unknown, path: string): void {
  if (!c.object(value, path, 'a point {x, y, z}')) return;
  c.keys(value, ['x', 'y', 'z'], path);
  for (const axis of ['x', 'y', 'z']) {
    if (value[axis] !== undefined) c.number(value[axis], join(path, axis));
  }
}

// A map, so a command type such as "constructor" finds nothing.
const COMMAND_POINTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['move', ['point']],
  ['line', ['point']],
  ['bezier', ['control1', 'control2', 'point']],
  ['arc', ['corner', 'point']],
]);

function checkPath(c: Checker, value: unknown, path: string): void {
  if (!c.array(value, path, 'path commands')) return;
  value.forEach((command, i) => {
    const at = join(path, i);
    if (!c.object(command, at, 'a path command')) return;
    const points = typeof command.type === 'string' ? COMMAND_POINTS.get(command.type) : undefined;
    if (!points) {
      c.fail(
        join(at, 'type'),
        `expected one of ${list(COMMAND_POINTS.keys())}, got ${show(command.type)}.`,
      );
      return;
    }
    c.keys(command, ['type', ...points], at);
    for (const point of points) checkPoint(c, command[point], join(at, point));
  });
}

function checkFaces(c: Checker, value: unknown, path: string): void {
  if (!c.object(value, path, 'an object of box faces')) return;
  c.keys(value, BOX_FACES, path);
  for (const [face, settings] of Object.entries(value)) {
    const at = join(path, face);
    if (!c.object(settings, at, 'face settings {visible, color}')) continue;
    c.keys(settings, ['visible', 'color'], at);
    if (settings.visible !== undefined && typeof settings.visible !== 'boolean') {
      c.fail(join(at, 'visible'), `expected true or false, got ${show(settings.visible)}.`);
    }
    const tint = settings.color;
    if (tint !== undefined && tint !== null && (typeof tint !== 'string' || !color.parse(tint))) {
      c.fail(join(at, 'color'), `expected a CSS color or null, got ${show(tint)}.`);
    }
  }
}

function checkNode(
  c: Checker,
  value: unknown,
  path: string,
  ids: Set<string>,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    c.fail(path, `the tree is nested deeper than ${MAX_DEPTH} levels.`);
    return;
  }
  if (!c.object(value, path, 'a node')) return;
  c.keys(value, NODE_KEYS, path);
  const type = typeof value.type === 'string' ? NODE_TYPES.get(value.type) : undefined;
  if (!type) {
    c.fail(
      join(path, 'type'),
      `expected one of ${list(NODE_TYPES.keys())}, got ${show(value.type)}.`,
    );
  }
  if (value.id !== undefined && c.string(value.id, join(path, 'id'))) {
    const id = value.id;
    if (id.startsWith('~') || id.includes('/')) {
      c.fail(join(path, 'id'), `an id cannot start with "~" or contain "/", got ${show(id)}.`);
    } else if (ids.has(id)) {
      c.fail(join(path, 'id'), `the id "${id}" is used twice.`);
    }
    ids.add(id);
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    c.fail(join(path, 'name'), `expected a string, got ${show(value.name)}.`);
  }
  if (type && value.props !== undefined) checkProps(c, type, value.props, join(path, 'props'));
  if (value.path !== undefined) {
    if (value.type === 'PathShape') checkPath(c, value.path, join(path, 'path'));
    else c.fail(join(path, 'path'), 'only a PathShape has a path.');
  }
  if (value.faces !== undefined) {
    if (value.type === 'Box') checkFaces(c, value.faces, join(path, 'faces'));
    else c.fail(join(path, 'faces'), 'only a Box has faces.');
  }
  if (value.children !== undefined && c.array(value.children, join(path, 'children'), 'nodes')) {
    value.children.forEach((child, i) => {
      checkNode(c, child, join(join(path, 'children'), i), ids, depth + 1);
    });
  }
}

function isBlend(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.blend);
}

const MOTION_KINDS =
  'a clip {tracks}, behaviors {behaviors}, blend {input, blend} or library motion {library}';
const NESTED_BLEND = 'a blend point cannot be a blend: blends do not nest.';

/** What motion checks need: the named motions, the rig's slots and whether a size is known. */
interface MotionContext {
  readonly motions: Json;
  readonly slots: ReadonlySet<string>;
  readonly archetype: boolean;
}

/**
 * The library motions a motion reference plays: itself (by name or inline), or its blend's
 * points. Unknown names find nothing (they are reported elsewhere).
 */
function librariesIn(
  ref: unknown,
  motions: Readonly<Record<string, unknown>>,
  inBlend = false,
): LibraryMotion[] {
  const value =
    typeof ref === 'string' ? (Object.hasOwn(motions, ref) ? motions[ref] : undefined) : ref;
  if (!isObject(value)) return [];
  if (typeof value.library === 'string') {
    const entry = MOTIONS.get(value.library);
    return entry ? [entry] : [];
  }
  if (inBlend || !isBlend(value)) return [];
  return (value.blend as unknown[]).flatMap((point) =>
    isObject(point) ? librariesIn(point.motion, motions, true) : [],
  );
}

/** The problem with playing `ref` on a layer of blend mode `mode`, if a library motion is for the other kind. */
export function layerKindProblem(
  ref: unknown,
  motions: Readonly<Record<string, unknown>>,
  layer: string,
  mode: BlendMode,
): string | null {
  const entry = librariesIn(ref, motions).find((library) => library.layer !== mode);
  if (!entry) return null;
  return `the library motion "${entry.name}" is written for an ${entry.layer} layer, but layer "${layer}" is ${mode}.`;
}

/** Checks a library motion: it exists, the rig binds its slots, and it has a size if it needs one. */
function checkLibrary(c: Checker, name: unknown, path: string, context: MotionContext): void {
  const motion = typeof name === 'string' ? MOTIONS.get(name) : undefined;
  if (!motion) {
    c.fail(path, `expected a library motion (${list(MOTIONS.keys())}), got ${show(name)}.`);
    return;
  }
  const missing = slotsOf(motion.motion).filter((slot) => !context.slots.has(slot));
  if (missing.length > 0) {
    c.fail(
      path,
      `the library motion "${motion.name}" needs the slots ${list(missing)}, which the rig does not bind.`,
    );
  }
  if (!context.archetype && usesSize(motion.motion)) {
    c.fail(
      path,
      `the library motion "${motion.name}" moves positions in sizes of the mascot: set an archetype to measure it.`,
    );
  }
}

/**
 * Checks a motion reference: a name in `motions`, or an inline motion. Inside a blend
 * (`inBlend`) it must not be a blend, as in the engine, so a document cannot nest them deeply
 * or blend a motion back into itself.
 */
function checkMotionRef(
  c: Checker,
  value: unknown,
  path: string,
  context: MotionContext,
  inBlend: boolean,
): void {
  if (typeof value !== 'string') {
    checkMotion(c, value, path, context, inBlend);
    return;
  }
  const { motions } = context;
  if (!Object.hasOwn(motions, value)) {
    const names = list(Object.keys(motions)) || 'none';
    c.fail(path, `no motion "${value}" in motions (there are ${names}).`);
  } else if (inBlend && isBlend(motions[value])) {
    c.fail(path, NESTED_BLEND);
  }
}

function checkMotion(
  c: Checker,
  value: unknown,
  path: string,
  context: MotionContext,
  inBlend: boolean,
): void {
  if (!c.object(value, path, MOTION_KINDS)) {
    return;
  }
  if (value.library !== undefined) {
    c.keys(value, ['library'], path);
    checkLibrary(c, value.library, join(path, 'library'), context);
  } else if (isBlend(value)) {
    if (inBlend) {
      c.fail(path, NESTED_BLEND);
      return;
    }
    c.string(value.input, join(path, 'input'));
    (value.blend as unknown[]).forEach((point, i) => {
      const at = join(join(path, 'blend'), i);
      if (c.object(point, at, 'a blend point {at, motion}')) {
        c.number(point.at, join(at, 'at'));
        checkMotionRef(c, point.motion, join(at, 'motion'), context, true);
      }
    });
  } else if (!Array.isArray(value.tracks) && !Array.isArray(value.behaviors)) {
    c.fail(path, `expected ${MOTION_KINDS}.`);
  }
}

/** Checks a list of named entries: each an object, names unique when given (or required). */
function checkNamed(
  c: Checker,
  value: unknown,
  path: string,
  what: string,
  required: boolean,
  each: (item: Json, at: string) => void,
): Set<string> {
  const names = new Set<string>();
  if (value === undefined || !c.array(value, path, what)) return names;
  value.forEach((item, i) => {
    const at = join(path, i);
    if (!c.object(item, at, what)) return;
    // A machine's name may be null, as in the engine's spec.
    if (required || (item.name !== undefined && item.name !== null)) {
      if (c.string(item.name, join(at, 'name'))) {
        if (names.has(item.name))
          c.fail(join(at, 'name'), `the name "${item.name}" is used twice.`);
        names.add(item.name);
      }
    }
    each(item, at);
  });
  return names;
}

/**
 * Checks a document, assumed to be of the current version (after `migrate`), and returns every
 * problem found; an empty list means it can be built. The tree is checked as `buildDocument`
 * builds it with these `params`: references computed, prefabs expanded. A problem inside an
 * expanded prefab is reported at its place in the expanded tree (an instance's own children
 * keep their paths), one inside a prefab's definition at `prefabs.<name>`.
 */
export function validateDocument(
  value: unknown,
  params: Readonly<Record<string, number>> = {},
): Issue[] {
  const c = new Checker();
  if (!c.object(value, '', 'a document object')) return c.issues;
  // The tree is checked as it will be built: parameters set, prefabs in place.
  const expanded = expandDocument(value, params);
  c.issues.push(...expanded.issues);
  const tree = isObject(expanded.document) ? expanded.document.root : value.root;
  c.keys(value, DOCUMENT_KEYS, '');
  if (value.format !== FORMAT) c.fail('format', `expected "${FORMAT}", got ${show(value.format)}.`);
  if (c.object(value.meta, 'meta', 'an object {name, description}')) {
    c.keys(value.meta, META_KEYS, 'meta');
    c.string(value.meta.name, 'meta.name');
    const { description } = value.meta;
    if (description !== undefined && typeof description !== 'string') {
      c.fail('meta.description', `expected a string, got ${show(description)}.`);
    }
  }
  if (c.object(value.view, 'view', 'an object {width, height, background}')) {
    c.keys(value.view, VIEW_KEYS, 'view');
    c.number(value.view.width, 'view.width', 0, true);
    c.number(value.view.height, 'view.height', 0, true);
    const { background } = value.view;
    if (background !== undefined && (typeof background !== 'string' || !color.parse(background))) {
      c.fail('view.background', `expected a CSS color, got ${show(background)}.`);
    }
  }
  if (value.camera !== undefined && c.object(value.camera, 'camera', 'an object {props}')) {
    c.keys(value.camera, ['props'], 'camera');
    if (value.camera.props !== undefined) checkProps(c, Camera, value.camera.props, 'camera.props');
  }
  const ids = new Set<string>();
  checkNode(c, tree, 'root', ids, 0);
  const slots = new Set<string>();
  if (value.rig !== undefined && c.object(value.rig, 'rig', 'an object {slots}')) {
    c.keys(value.rig, ['slots'], 'rig');
    const given = value.rig.slots;
    if (given !== undefined && c.object(given, 'rig.slots', 'an object of slot ids')) {
      for (const [slot, id] of Object.entries(given)) {
        const at = join('rig.slots', slot);
        if (!SLOT_NAME_PATTERN.test(slot)) c.fail(at, `"${slot}" is not a slot name.`);
        if (c.string(id, at) && !ids.has(id)) c.fail(at, `no node with id "${id}".`);
        slots.add(slot);
      }
    }
  }
  const archetype =
    typeof value.archetype === 'string' ? ARCHETYPES.get(value.archetype) : undefined;
  if (value.archetype !== undefined) {
    if (!archetype) {
      c.fail(
        'archetype',
        `expected one of ${list(ARCHETYPES.keys())}, got ${show(value.archetype)}.`,
      );
    } else {
      const missing = archetype.slots.filter((slot) => !slots.has(slot));
      if (missing.length > 0) {
        c.fail(
          'archetype',
          `a ${archetype.name} binds the slots ${list(missing)}, which the rig does not.`,
        );
      }
    }
  }
  let motions: Json = {};
  if (value.motions !== undefined && c.object(value.motions, 'motions', 'an object of motions')) {
    motions = value.motions;
  }
  // An unknown archetype is reported once, above; motions needing a size do not repeat it.
  const context: MotionContext = { motions, slots, archetype: value.archetype !== undefined };
  for (const [name, motion] of Object.entries(motions)) {
    checkMotion(c, motion, join('motions', name), context, false);
  }
  const modes = new Map<string, BlendMode>();
  const layers = checkNamed(c, value.layers, 'layers', 'layers', true, (layer, at) => {
    c.keys(layer, LAYER_KEYS, at);
    const { mode } = layer;
    if (mode !== undefined && !(BLEND_MODES as readonly unknown[]).includes(mode)) {
      c.fail(join(at, 'mode'), `expected one of ${list(BLEND_MODES)}, got ${show(mode)}.`);
    }
    if (layer.weight !== undefined) c.number(layer.weight, join(at, 'weight'), 0);
    // A bad mode is reported above; the kind of its motions is not checked against it.
    const kind =
      mode === undefined
        ? 'override'
        : (BLEND_MODES as readonly unknown[]).includes(mode)
          ? (mode as BlendMode)
          : null;
    if (kind && typeof layer.name === 'string') modes.set(layer.name, kind);
    if (layer.play !== undefined && layer.play !== null) {
      checkMotionRef(c, layer.play, join(at, 'play'), context, false);
      const problem = kind && layerKindProblem(layer.play, motions, String(layer.name), kind);
      if (problem) c.fail(join(at, 'play'), problem);
    }
  });
  checkNamed(c, value.machines, 'machines', 'state machines', false, (machine, at) => {
    if (c.string(machine.layer, join(at, 'layer')) && !layers.has(machine.layer)) {
      c.fail(join(at, 'layer'), `no layer "${machine.layer}" in layers.`);
    }
    if (c.array(machine.states, join(at, 'states'), 'states')) {
      machine.states.forEach((state, i) => {
        const where = join(join(at, 'states'), i);
        if (!c.object(state, where, 'a state {name, motion}')) return;
        if (state.motion !== undefined && state.motion !== null) {
          checkMotionRef(c, state.motion, join(where, 'motion'), context, false);
          const kind = modes.get(String(machine.layer));
          const problem =
            kind && layerKindProblem(state.motion, motions, String(machine.layer), kind);
          if (problem) c.fail(join(where, 'motion'), problem);
        }
      });
    }
  });
  checkNamed(c, value.constraints, 'constraints', 'constraints', false, (constraint, at) => {
    if (!(CONSTRAINT_KINDS as readonly unknown[]).includes(constraint.kind)) {
      c.fail(
        join(at, 'kind'),
        `expected one of ${list(CONSTRAINT_KINDS)}, got ${show(constraint.kind)}.`,
      );
    }
  });
  if (value.springs !== undefined && c.array(value.springs, 'springs', 'springs')) {
    value.springs.forEach((spring, i) => {
      c.object(spring, join('springs', i), 'a spring {target, tip, …}');
    });
  }
  return c.issues;
}
