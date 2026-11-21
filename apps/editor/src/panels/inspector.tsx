import {
  BOX_FACES,
  type BoxFace,
  Node,
  type PathCommand,
  type Property,
  propertiesOf,
} from '@mascotte/engine';
import {
  type ColorRef,
  isColorRef,
  type MascotDocument,
  NODE_TYPES,
  type NodeDocument,
  type Num,
  type ParamRef,
  type PathCommandDocument,
  type PropertyValue,
  type ScalarRef,
  type VectorRef,
} from '@mascotte/format';
import { color, euler, type Quat, quat, type Vec3 } from '@mascotte/math';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { type Command, extractPrefab, setName, setNodeField, setProp } from '../model/commands.ts';
import { type DocPath, nodeAt, pathString } from '../model/paths.ts';
import { prefabDefinition } from '../model/prefabs.ts';
import { attempt, editor, prefabMode, problem, state } from '../store.ts';
import { numberOf } from './document-panel.tsx';
import { autoKey, keyNode, liveNode, liveValue, openClip } from './timeline.tsx';

type Faces = NonNullable<NodeDocument['faces']>;
type FaceSettings = NonNullable<Faces[BoxFace]>;
/** A path command as the editor handles it: its type and its points by name. */
type LooseCommand = { readonly type: string } & Readonly<Record<string, unknown>>;

const AXES = ['x', 'y', 'z'] as const;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const ONE: Vec3 = { x: 1, y: 1, z: 1 };
const TRANSFORM = new Set(['position', 'rotation', 'scale', 'pivot']);
const NODE_PROPERTIES = new Set(propertiesOf(Node).map((property) => property.name));
/** The point names of each path command type, as the engine's `PathCommand` has them. */
type CommandPoints = {
  readonly [T in PathCommand['type']]: readonly Exclude<
    keyof Extract<PathCommand, { type: T }>,
    'type'
  >[];
};
// In the format's order (`COMMAND_POINTS` in packages/format/src/validate.ts). A map, so a
// command type such as "constructor" finds nothing.
const COMMAND_POINTS: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    move: ['point'],
    line: ['point'],
    bezier: ['control1', 'control2', 'point'],
    arc: ['corner', 'point'],
  } satisfies CommandPoints),
);

/** What the editors need: the document, its parameters' names and its palette roles. */
interface Context {
  readonly document: MascotDocument;
  readonly params: readonly string[];
  readonly roles: readonly string[];
}

/** Runs `command` as a step of its own: an edit in the inspector is not a gesture. */
function run(command: Command): void {
  attempt(`Could not ${command.label.toLowerCase()}`, () => {
    const current = editor.value;
    current.execute(command);
    current.commit();
  });
}

function isRef(value: unknown): value is ParamRef {
  return typeof value === 'object' && value !== null && 'param' in value;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVec3(value: unknown): value is Vec3 {
  return isObject(value) && AXES.every((axis) => Number.isFinite(value[axis]));
}

/** A rotation the editor can turn into angles: four finite numbers, not all zero. */
function isQuat(value: unknown): value is Quat {
  return (
    isVec3(value) && Number.isFinite((value as Partial<Quat>).w) && quat.length(value as Quat) > 0
  );
}

/** The finite coordinates of a stored vector (a partial one keeps what it has), or none. */
function coordinates(value: unknown): Partial<Vec3> | undefined {
  if (!isObject(value)) return undefined;
  return Object.fromEntries(
    AXES.filter((axis) => Number.isFinite(value[axis])).map((axis) => [axis, value[axis]]),
  );
}

/** `object` with `key` set to `value`, or without it for `undefined`. */
function withKey<T extends object, K extends keyof T>(
  object: T,
  key: K,
  value: T[K] | undefined,
): T {
  const { [key]: _, ...rest } = object;
  return (value === undefined ? rest : { ...rest, [key]: value }) as T;
}

/** The parameters' values at their defaults, by name (one with no number for a default is left out). */
function defaultsOf(params: unknown): Record<string, number> {
  if (!isObject(params)) return {};
  return Object.fromEntries(
    Object.entries(params).flatMap(([name, spec]) =>
      isObject(spec) && typeof spec.default === 'number' ? [[name, spec.default]] : [],
    ),
  );
}

/**
 * What a reference comes to with the parameters' `values`; `null` when it names a parameter they
 * do not have or does not come to finite numbers.
 */
function resolve(ref: ParamRef, values: Readonly<Record<string, number>>): number | Vec3 | null {
  const value = Object.hasOwn(values, ref.param) ? values[ref.param] : undefined;
  if (typeof value !== 'number') return null;
  const plus = isRef(ref.plus) ? resolve(ref.plus, values) : ref.plus;
  if (plus === null) return null;
  const times: unknown = ref.times;
  if (isObject(times)) {
    if (!isVec3(times)) return null;
    const add = plus ?? ZERO;
    if (!isVec3(add)) return null;
    const result = {
      x: value * times.x + add.x,
      y: value * times.y + add.y,
      z: value * times.z + add.z,
    };
    return isVec3(result) ? result : null;
  }
  const add = plus ?? 0;
  if (typeof add !== 'number' || (times !== undefined && typeof times !== 'number')) return null;
  const result = value * (times ?? 1) + add;
  return Number.isFinite(result) ? result : null;
}

/**
 * What a reference comes to with the document's parameters at their defaults (see `resolve`), or
 * `null` after saying why it cannot be unbound.
 */
function unbound(label: string, ref: ParamRef, document: MascotDocument): number | Vec3 | null {
  const value = resolve(ref, defaultsOf(document.params));
  if (value === null) {
    problem.value = `Could not unbind ${label}: its parameters do not come to a value (see its issues).`;
  }
  return value;
}

/** The palette roles, the base palette's first. */
function rolesOf(document: MascotDocument): string[] {
  return [...new Set(palettesOf(document).flatMap(Object.keys))];
}

/** The document's palettes in order, those that are objects (the format reports the others). */
function palettesOf(document: MascotDocument): Readonly<Record<string, unknown>>[] {
  return isObject(document.palettes) ? Object.values(document.palettes).filter(isObject) : [];
}

/** The color of `role`: the base palette's, or the first palette naming it. */
function colorOf(document: MascotDocument, role: string): string | undefined {
  for (const palette of palettesOf(document)) {
    if (Object.hasOwn(palette, role)) {
      const value = palette[role];
      return typeof value === 'string' ? value : undefined;
    }
  }
  return undefined;
}

/**
 * A node's type, the props it starts from (a prefab root's, for an instance, as its parameters
 * make them), its prefab's parameters, and why it has no type.
 */
interface NodeKind {
  readonly type: string | undefined;
  readonly inherited: Readonly<Record<string, unknown>>;
  readonly params: Readonly<Record<string, unknown>>;
  readonly problem: string | null;
}

/** The node type of a node: its own, or its prefab's root's for an instance. */
function kindOf(document: MascotDocument, node: NodeDocument): NodeKind {
  if (node.prefab === undefined) {
    const problem =
      node.type === undefined
        ? 'The node has no type.'
        : `Unknown type ${JSON.stringify(node.type)}.`;
    return { type: node.type, inherited: {}, params: {}, problem };
  }
  const prefab = prefabDefinition(document, node.prefab);
  const root: unknown = prefab?.root;
  if (!prefab || !isObject(root)) {
    return { type: undefined, inherited: {}, params: {}, problem: `No prefab "${node.prefab}".` };
  }
  // The prefab's parameters as this instance sets them, as the format takes them: a number, or
  // the document's parameters (at their defaults) through a reference, in the parameter's range;
  // the prefab's default otherwise.
  const specs: Readonly<Record<string, unknown>> = isObject(prefab.params) ? prefab.params : {};
  const documentValues = defaultsOf(document.params);
  const values = defaultsOf(specs);
  for (const [name, value] of Object.entries(isObject(node.params) ? node.params : {})) {
    const set = isRef(value) ? resolve(value, documentValues) : value;
    const spec = specs[name];
    const { min, max } = isObject(spec) ? spec : {};
    const allowed =
      typeof set === 'number' &&
      Number.isFinite(set) &&
      !(typeof min === 'number' && set < min) &&
      !(typeof max === 'number' && set > max);
    if (allowed && Object.hasOwn(values, name)) values[name] = set;
  }
  // The root's values as the instance has them (colors in the base palette, not the viewport's);
  // one that does not come to a value is left out, and shows the registry's default.
  const inherited = Object.fromEntries(
    Object.entries(isObject(root.props) ? root.props : {}).flatMap(([name, value]) => {
      const plain = isRef(value)
        ? resolve(value, values)
        : isColorRef(value)
          ? colorOf(document, value.color)
          : value;
      return plain === null || plain === undefined ? [] : [[name, plain]];
    }),
  );
  return {
    type: typeof root.type === 'string' ? root.type : undefined,
    inherited,
    params: specs,
    problem: `The prefab "${node.prefab}" has a root of unknown type.`,
  };
}

/**
 * A number input. Emptied, it gives `undefined` if `optional`; text that is not a number, or an
 * emptied field that is not optional, changes nothing and shows `value` again.
 */
function NumberInput(props: {
  label: string;
  value: number | undefined;
  placeholder?: string;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  optional?: boolean | undefined;
  onValue(next: number | undefined): void;
}) {
  return (
    <input
      type="number"
      aria-label={props.label}
      min={props.min}
      max={props.max}
      step={props.step ?? 'any'}
      value={props.value ?? ''}
      placeholder={props.placeholder}
      onChange={(event) => {
        const input = event.currentTarget as HTMLInputElement;
        const next = numberOf(input);
        if (next === null || (next === undefined && !props.optional)) {
          input.value = props.value === undefined ? '' : String(props.value);
          return;
        }
        props.onValue(next);
      }}
    />
  );
}

/**
 * Three inputs for a vector: a whole one, its missing coordinates taken from `fallback`, or with
 * `partial` a path point, whose coordinates may be left out (an emptied one is removed).
 */
function VectorInputs(props: {
  label: string;
  value: Partial<Vec3> | undefined;
  fallback: Readonly<Vec3>;
  partial?: boolean | undefined;
  onValue(next: Partial<Vec3>): void;
}) {
  const base = props.partial ? { ...props.value } : { ...props.fallback, ...props.value };
  return (
    <div class="field-row">
      {AXES.map((axis) => (
        <NumberInput
          key={axis}
          label={`${props.label} ${axis}`}
          value={props.value?.[axis]}
          placeholder={String(props.fallback[axis])}
          optional={props.partial}
          onValue={(next) => props.onValue(withKey(base, axis, next))}
        />
      ))}
    </div>
  );
}

/**
 * A reference `param × times + plus`: the parameter, `times` (a number, or a vector for a vector
 * reference) and `plus`, itself a number or vector, or another reference.
 */
function RefEditor(props: {
  label: string;
  value: ParamRef;
  context: Context;
  onValue(next: ParamRef): void;
}) {
  const { label, value, context, onValue } = props;
  const vector = isObject(value.times);
  const names = context.params.includes(value.param)
    ? context.params
    : [value.param, ...context.params];
  const plus = value.plus;
  return (
    <fieldset class="ref" aria-label={label}>
      <div class="field-row">
        <select
          aria-label={`${label} parameter`}
          value={value.param}
          onChange={(event) =>
            onValue({ ...value, param: (event.currentTarget as HTMLSelectElement).value })
          }
        >
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span>×</span>
        {vector ? null : (
          <NumberInput
            label={`${label} times`}
            value={(value as ScalarRef).times}
            placeholder="1"
            optional
            onValue={(next) => onValue(withKey(value, 'times', next))}
          />
        )}
      </div>
      {vector ? (
        <VectorInputs
          label={`${label} times`}
          value={coordinates(value.times)}
          fallback={ONE}
          onValue={(next) => onValue({ ...value, times: next as Vec3 } as VectorRef)}
        />
      ) : null}
      <div class="field-row">
        <span>+</span>
        <select
          aria-label={`${label} plus source`}
          value={isRef(plus) ? 'param' : 'value'}
          onChange={(event) => {
            const select = event.currentTarget as HTMLSelectElement;
            if (select.value === 'param') {
              // What it added stays added, as the new reference's own plus.
              const param = {
                param: value.param,
                ...(vector ? { times: ONE } : {}),
                ...(plus === undefined ? {} : { plus }),
              };
              onValue({ ...value, plus: param } as ParamRef);
            } else if (isRef(plus)) {
              // What the parameters added stays added, as a plain number or vector.
              const added = unbound(`${label} plus`, plus, context.document);
              if (added === null) select.value = 'param';
              else onValue({ ...value, plus: added } as ParamRef);
            }
          }}
        >
          <option value="value">{vector ? 'a vector' : 'a number'}</option>
          <option value="param">a parameter</option>
        </select>
        {!isRef(plus) && !vector ? (
          <NumberInput
            label={`${label} plus`}
            value={typeof plus === 'number' ? plus : undefined}
            placeholder="0"
            optional
            onValue={(next) => onValue(withKey(value, 'plus', next))}
          />
        ) : null}
      </div>
      {isRef(plus) ? (
        <RefEditor
          label={`${label} plus`}
          value={plus}
          context={context}
          onValue={(next) => onValue({ ...value, plus: next } as ParamRef)}
        />
      ) : vector ? (
        <VectorInputs
          label={`${label} plus`}
          value={coordinates(plus)}
          fallback={ZERO}
          onValue={(next) => onValue({ ...value, plus: next as Vec3 } as VectorRef)}
        />
      ) : null}
    </fieldset>
  );
}

/** Where a bindable value comes from: itself, or a parameter (`kind` "param") or a palette role ("palette"). */
function SourceSelect(props: {
  label: string;
  kind: 'param' | 'palette';
  bound: boolean;
  available: boolean;
  onBind(): void;
  /** Unbinds it; `false` when it cannot, and it stays bound. */
  onUnbind(): boolean;
}) {
  return (
    <select
      aria-label={`${props.label} source`}
      value={props.bound ? props.kind : 'value'}
      onChange={(event) => {
        const select = event.currentTarget as HTMLSelectElement;
        if (select.value !== 'value') props.onBind();
        // Refused: the select shows the binding again, which the state still has.
        else if (!props.onUnbind()) select.value = props.kind;
      }}
    >
      <option value="value">value</option>
      <option value={props.kind} disabled={!props.available && !props.bound}>
        {props.kind === 'param' ? 'parameter' : 'palette'}
      </option>
    </select>
  );
}

/** A labelled field: its name, what it is bound to, a reset, and its editor below. */
function Field(props: {
  title: string;
  label: string;
  invalid?: boolean;
  source?: ComponentChildren;
  reset?: (() => void) | null;
  children: ComponentChildren;
}) {
  return (
    <div class={props.invalid ? 'prop invalid' : 'prop'}>
      <div class="prop-head">
        <span class="prop-name" title={props.label}>
          {props.title}
        </span>
        {props.source}
        {props.reset !== undefined ? (
          <button
            type="button"
            aria-label={`Reset ${props.label}`}
            title="Back to the default"
            disabled={props.reset === null}
            onClick={() => props.reset?.()}
          >
            ↺
          </button>
        ) : null}
      </div>
      {props.children}
    </div>
  );
}

/** A color: a CSS color as text with a picker, or a palette role. */
function ColorEditor(props: {
  label: string;
  value: unknown;
  placeholder: string;
  context: Context;
  onValue(next: string | ColorRef | undefined): void;
}) {
  // A stored value of another kind shows as empty; the format reports it.
  const { label, value, context, onValue } = props;
  if (isColorRef(value)) {
    const roles = context.roles.includes(value.color)
      ? context.roles
      : [value.color, ...context.roles];
    return (
      <select
        aria-label={`${label} role`}
        value={value.color}
        onChange={(event) => onValue({ color: (event.currentTarget as HTMLSelectElement).value })}
      >
        {roles.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
    );
  }
  const text = typeof value === 'string' ? value : '';
  const parsed = color.parse(text || props.placeholder);
  const hex = parsed ? color.toHex(parsed) : null;
  const change = (next: string) => onValue(next.trim() === '' ? undefined : next.trim());
  return (
    <div class="field-row">
      <input
        type="text"
        aria-label={label}
        value={text}
        placeholder={props.placeholder}
        onChange={(event) => change((event.currentTarget as HTMLInputElement).value)}
      />
      <input
        type="color"
        aria-label={`${label} picker`}
        value={hex?.slice(0, 7) ?? '#ffffff'}
        // The picker has no alpha: the color's own alpha stays.
        onChange={(event) =>
          change((event.currentTarget as HTMLInputElement).value + (hex?.slice(7) ?? ''))
        }
      />
    </div>
  );
}

/**
 * The source select of a color: its own value or a palette role. Binding takes the first role;
 * unbinding keeps the role's color in the base palette (or the first naming it), and a role no
 * palette names cannot be unbound.
 */
function colorSource(
  label: string,
  value: unknown,
  context: Context,
  onValue: (next: string | ColorRef) => void,
) {
  const role = context.roles[0];
  return (
    <SourceSelect
      label={label}
      kind="palette"
      bound={isColorRef(value)}
      available={role !== undefined}
      onBind={() => role !== undefined && onValue({ color: role })}
      onUnbind={() => {
        if (!isColorRef(value)) return true;
        const color = colorOf(context.document, value.color);
        if (color === undefined) {
          problem.value = `Could not unbind ${label}: no palette has the role "${value.color}".`;
          return false;
        }
        onValue(color);
        return true;
      }}
    />
  );
}

/**
 * The source select of a number or vector: its own value or a parameter. Binding takes the first
 * parameter, times 1; unbinding keeps what the binding comes to with the parameters at their
 * defaults.
 */
function paramSource(
  label: string,
  value: unknown,
  vector: boolean,
  context: Context,
  onValue: (next: ParamRef | number | Vec3) => void,
) {
  const param = context.params[0];
  return (
    <SourceSelect
      label={label}
      kind="param"
      bound={isRef(value)}
      available={param !== undefined}
      onBind={() => param !== undefined && onValue(vector ? { param, times: ONE } : { param })}
      onUnbind={() => {
        if (!isRef(value)) return true;
        const plain = unbound(label, value, context.document);
        if (plain === null) return false;
        onValue(plain);
        return true;
      }}
    />
  );
}

/**
 * Euler angles in degrees (XYZ) for a rotation the document stores as a quaternion; unset, it
 * shows `fallback`'s. A stored value that is no rotation shows as unset (the format reports it).
 */
function EulerInputs(props: {
  label: string;
  value: unknown;
  fallback: Quat;
  onValue(next: Quat): void;
}) {
  const stored = isQuat(props.value) ? props.value : undefined;
  // Normalized, so the angles shown are those the node turns by.
  const turn = quat.normalize(quat.create(), stored ?? props.fallback);
  const angles = quat.toEuler(euler.create(), turn, 'XYZ');
  const degrees = (radians: number) => Math.round(((radians * 180) / Math.PI) * 1000) / 1000;
  return (
    <div class="field-row">
      {AXES.map((axis) => (
        <NumberInput
          key={axis}
          label={`${props.label} ${axis}`}
          value={stored === undefined ? undefined : degrees(angles[axis])}
          placeholder={String(degrees(angles[axis]))}
          onValue={(next) => {
            const turned = quat.fromEuler(quat.create(), {
              ...angles,
              [axis]: ((next as number) * Math.PI) / 180,
            });
            props.onValue({ x: turned.x, y: turned.y, z: turned.z, w: turned.w });
          }}
        />
      ))}
    </div>
  );
}

/** What a plain field shows: its value, else the inherited one, else the default (of its kind). */
function shownValue<T extends boolean | string>(
  value: unknown,
  inherited: unknown,
  fallback: T,
): T {
  if (typeof value === typeof fallback) return value as T;
  if (typeof inherited === typeof fallback) return inherited as T;
  return fallback;
}

/** The editor of one registry property of the node at `path`. */
function PropertyField(props: {
  path: DocPath;
  property: Property;
  value: PropertyValue | undefined;
  /** The value it has unless set: a prefab root's own (for an instance), when it is plain. */
  inherited: unknown;
  context: Context;
  invalid: boolean;
}) {
  const { path, property, inherited, context } = props;
  const name = property.name;
  // With auto-key on and a clip open, an edit of an animatable property keys the clip at the
  // playhead, and the field shows the value the node has there, so an edit of one axis keeps the
  // others. What a key cannot hold (no value, a binding) is refused, not set as a rest value.
  const keying = autoKey.value && property.animatable && openClip() !== null;
  const live = keying ? liveNode(path) : null;
  const value = live ? (liveValue(property, live) as PropertyValue) : props.value;
  const set = (next: PropertyValue | undefined) => {
    if (!keying) run(setProp(path, name, next));
    else if (next === undefined || isRef(next) || isColorRef(next)) {
      problem.value = `Auto-key keys values: turn it off to clear or bind ${name}.`;
    } else if (!live) {
      // The value at the playhead is not shown: an edit of one axis would key the others wrong.
      problem.value = `The document has issues: fix them to key ${name}.`;
    } else keyNode(path, property, next);
  };
  let source: ComponentChildren = null;
  let body: ComponentChildren;
  switch (property.type) {
    case 'number':
      source = paramSource(name, value, false, context, set);
      body = isRef(value) ? (
        <RefEditor label={name} value={value} context={context} onValue={set} />
      ) : (
        <NumberInput
          label={name}
          value={typeof value === 'number' ? value : undefined}
          placeholder={String(typeof inherited === 'number' ? inherited : property.default)}
          min={property.min}
          max={property.max}
          step={property.integer ? 1 : undefined}
          optional
          onValue={set}
        />
      );
      break;
    case 'vec3':
      source = paramSource(name, value, true, context, set);
      body = isRef(value) ? (
        <RefEditor label={name} value={value} context={context} onValue={set} />
      ) : (
        <VectorInputs
          label={name}
          value={coordinates(value)}
          fallback={isVec3(inherited) ? inherited : property.default}
          onValue={(next) => set(next as Vec3)}
        />
      );
      break;
    case 'quat':
      body = (
        <EulerInputs
          label={name}
          value={value}
          fallback={isQuat(inherited) ? inherited : property.default}
          onValue={set}
        />
      );
      break;
    case 'color':
      source = colorSource(name, value, context, set);
      body = (
        <ColorEditor
          label={name}
          value={value}
          placeholder={typeof inherited === 'string' ? inherited : (property.default ?? 'none')}
          context={context}
          onValue={set}
        />
      );
      break;
    case 'bool':
      body = (
        <input
          type="checkbox"
          aria-label={name}
          checked={shownValue(value, inherited, property.default)}
          onChange={(event) => set((event.currentTarget as HTMLInputElement).checked)}
        />
      );
      break;
    case 'enum':
      body = (
        <select
          aria-label={name}
          value={shownValue(value, inherited, property.default)}
          onChange={(event) => set((event.currentTarget as HTMLSelectElement).value)}
        >
          {property.values.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      );
      break;
  }
  return (
    <Field
      title={name.startsWith('style.') ? name.slice(6) : name}
      label={name}
      invalid={props.invalid}
      source={source}
      reset={value === undefined || keying ? null : () => set(undefined)}
    >
      {body}
    </Field>
  );
}

/**
 * A path's commands: their types and points (each a vector or bound to a parameter). A path that
 * is no list, or a command that is no command, is shown as such, to be removed (the format
 * reports what is wrong with it).
 */
function PathEditor(props: { path: DocPath; node: NodeDocument; context: Context }) {
  const { path, context } = props;
  const stored: unknown = props.node.path;
  const set = (next: readonly unknown[]) =>
    run(
      setNodeField(
        path,
        'path',
        // Commands made here have their type's points; others are kept as they were.
        next.length === 0 ? undefined : (next as PathCommandDocument[]),
      ),
    );
  if (stored !== undefined && !Array.isArray(stored)) {
    return (
      <fieldset>
        <legend>Path</legend>
        <p class="empty">The path is not a list of commands.</p>
        <button type="button" aria-label="Remove the path" onClick={() => set([])}>
          Remove the path
        </button>
      </fieldset>
    );
  }
  const list: readonly unknown[] = stored ?? [];
  const change = (i: number, next: LooseCommand) =>
    set(list.map((command, j) => (j === i ? next : command)));
  const last = list.at(-1);
  const end = isObject(last) ? coordinates(last.point) : undefined;
  return (
    <fieldset>
      <legend>Path</legend>
      {list.map((entry, i) => {
        const label = `Path ${i + 1}`;
        const remove = (
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={() => set(list.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        );
        if (!isObject(entry) || typeof entry.type !== 'string') {
          return (
            <div key={i} class="path-command">
              <div class="prop-head">
                <span class="prop-name">{`${label} is not a command`}</span>
                {remove}
              </div>
            </div>
          );
        }
        const command = entry as LooseCommand;
        const types = [...COMMAND_POINTS.keys()];
        if (!COMMAND_POINTS.has(command.type)) types.unshift(command.type);
        return (
          <div key={i} class="path-command">
            <div class="prop-head">
              <select
                aria-label={`${label} type`}
                value={command.type}
                onChange={(event) => {
                  const type = (event.currentTarget as HTMLSelectElement).value;
                  const points = COMMAND_POINTS.get(type) ?? [];
                  // The points it had keep their places; new ones start at its end point.
                  const next = Object.fromEntries(
                    points.map((key) => [key, command[key] ?? command.point ?? {}]),
                  );
                  change(i, { type, ...next });
                }}
              >
                {types.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              {remove}
            </div>
            {(COMMAND_POINTS.get(command.type) ?? []).map((key) => {
              const point = command[key];
              const pointLabel = `${label} ${key}`;
              const setPoint = (next: unknown) => change(i, { ...command, [key]: next });
              return (
                <Field
                  key={key}
                  title={key}
                  label={pointLabel}
                  source={paramSource(pointLabel, point, true, context, setPoint)}
                >
                  {isRef(point) ? (
                    <RefEditor
                      label={pointLabel}
                      value={point}
                      context={context}
                      onValue={setPoint}
                    />
                  ) : (
                    <VectorInputs
                      label={pointLabel}
                      value={coordinates(point)}
                      fallback={ZERO}
                      partial
                      onValue={setPoint}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        );
      })}
      <button
        type="button"
        aria-label="Add point"
        onClick={() =>
          set([...list, { type: list.length === 0 ? 'move' : 'line', point: end ?? {} }])
        }
      >
        Add point
      </button>
    </fieldset>
  );
}

/** A box's faces: whether each is shown, and its color (the box's by default). */
function FacesEditor(props: { path: DocPath; node: NodeDocument; context: Context }) {
  const { path, context } = props;
  // Settings that are not objects show as the defaults; the format reports them.
  const faces: Faces = isObject(props.node.faces) ? props.node.faces : {};
  const set = (face: BoxFace, settings: FaceSettings) => {
    const next = withKey(faces, face, Object.keys(settings).length === 0 ? undefined : settings);
    run(setNodeField(path, 'faces', Object.keys(next).length === 0 ? undefined : next));
  };
  return (
    <fieldset>
      <legend>Faces</legend>
      {BOX_FACES.map((face) => {
        const stored = faces[face];
        const settings: FaceSettings = isObject(stored) ? stored : {};
        const label = `${face} face color`;
        const setColor = (next: string | ColorRef | undefined) =>
          set(face, withKey(settings, 'color', next));
        return (
          <Field
            key={face}
            title={face}
            label={`${face} face`}
            source={colorSource(label, settings.color, context, setColor)}
            reset={stored === undefined ? null : () => set(face, {})}
          >
            <div class="field-row">
              <label class="check">
                <input
                  type="checkbox"
                  aria-label={`${face} face visible`}
                  checked={settings.visible !== false}
                  onChange={(event) =>
                    set(
                      face,
                      withKey(
                        settings,
                        'visible',
                        (event.currentTarget as HTMLInputElement).checked ? undefined : false,
                      ),
                    )
                  }
                />
                visible
              </label>
              <ColorEditor
                label={label}
                value={settings.color}
                placeholder="the box's"
                context={context}
                onValue={setColor}
              />
            </div>
          </Field>
        );
      })}
    </fieldset>
  );
}

/**
 * A prefab instance's parameters: each a number, or bound to the document's parameters; unset,
 * it is the prefab's default.
 */
function InstanceParams(props: {
  path: DocPath;
  node: NodeDocument;
  specs: Readonly<Record<string, unknown>>;
  context: Context;
  invalid: (name: string) => boolean;
}) {
  const { path, node, specs, context } = props;
  const values: Readonly<Record<string, Num>> = isObject(node.params) ? node.params : {};
  // The prefab's parameters, and any the instance sets that it does not have (the format says so).
  const names = [...new Set([...Object.keys(specs), ...Object.keys(values)])];
  if (names.length === 0) return null;
  const set = (name: string, next: Num | undefined) => {
    const all = withKey<Record<string, Num>, string>({ ...values }, name, next);
    run(setNodeField(path, 'params', Object.keys(all).length === 0 ? undefined : all));
  };
  return (
    <fieldset>
      <legend>Parameters</legend>
      {names.map((name) => {
        const spec = specs[name];
        const { default: fallback, min, max } = isObject(spec) ? spec : {};
        const value = values[name];
        const label = `param ${name}`;
        // A parameter is a number (or none, back to the prefab's default): anything else, such as a
        // vector, is refused.
        const setValue = (next: unknown) => {
          const scalar =
            next === undefined ||
            typeof next === 'number' ||
            (isRef(next) && !isObject(next.times));
          if (scalar) set(name, next as Num | undefined);
          else problem.value = `The parameter ${name} takes a number or a reference to one.`;
        };
        return (
          <Field
            key={name}
            title={name}
            label={label}
            invalid={props.invalid(name)}
            source={paramSource(label, value, false, context, setValue)}
            reset={value === undefined ? null : () => set(name, undefined)}
          >
            {isRef(value) ? (
              <RefEditor label={label} value={value} context={context} onValue={setValue} />
            ) : (
              <NumberInput
                label={label}
                value={typeof value === 'number' ? value : undefined}
                placeholder={typeof fallback === 'number' ? String(fallback) : ''}
                min={typeof min === 'number' ? min : undefined}
                max={typeof max === 'number' ? max : undefined}
                optional
                onValue={setValue}
              />
            )}
          </Field>
        );
      })}
    </fieldset>
  );
}

/** Makes the node and its subtree a new prefab, with an instance of it in its place. */
function MakePrefab(props: { path: DocPath }) {
  const [name, setName] = useState('');
  const make = () => {
    if (name.trim() !== '') run(extractPrefab(props.path, name));
  };
  return (
    <fieldset>
      <legend>Prefab</legend>
      <div class="field-row">
        <input
          type="text"
          aria-label="Prefab name"
          placeholder="name"
          value={name}
          onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              make();
            }
          }}
        />
        <button type="button" onClick={make}>
          Make prefab
        </button>
      </div>
    </fieldset>
  );
}

/** The group a property is shown in. */
function groupOf(name: string): string {
  if (TRANSFORM.has(name)) return 'Transform';
  if (name.startsWith('style.')) return 'Style';
  if (NODE_PROPERTIES.has(name)) return 'Display';
  return 'Shape';
}

const GROUPS = ['Transform', 'Shape', 'Style', 'Display'];

/**
 * The inspector (docs/EDITOR.md, Panels): the selected node's properties as the document stores
 * them (rest values, not the animated pose), made from the registry, with a path's points and a
 * box's faces. Numbers, vectors and path points may be bound to parameters, colors to palette
 * roles. Each edit is a command, undone as one step.
 */
export function Inspector(props: { path: DocPath }) {
  const { document, issues } = state.value;
  const { path } = props;
  const node = nodeAt(document, path);
  if (!node) return null;
  const at = pathString(path);
  // The node's own issues, not its children's (the tree shows those).
  const own = issues.filter(
    (issue) =>
      issue.path === at ||
      (issue.path.startsWith(`${at}.`) && !issue.path.startsWith(`${at}.children`)),
  );
  const invalid = (name: string) =>
    own.some(
      (issue) =>
        issue.path === `${at}.props.${name}` || issue.path.startsWith(`${at}.props.${name}.`),
    );
  const kind = kindOf(document, node);
  const typeName = kind.type;
  const type = typeName === undefined ? undefined : NODE_TYPES.get(typeName);
  const context: Context = {
    document,
    params: Object.keys(document.params ?? {}),
    roles: rolesOf(document),
  };
  const properties = type ? propertiesOf(type) : [];
  return (
    <form
      key={at}
      class="form-panel"
      aria-label="Node"
      onSubmit={(event) => event.preventDefault()}
    >
      {own.length > 0 ? (
        <ul class="document-issues" role="alert">
          {own.map((issue) => (
            <li key={`${issue.path} ${issue.message}`}>
              <code>{issue.path.slice(at.length + 1) || 'node'}</code> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <fieldset>
        <legend>
          {node.prefab === undefined ? (typeName ?? 'Node') : `${node.prefab} (${typeName ?? '?'})`}
          {node.id === undefined ? null : <code class="node-id"> {node.id}</code>}
        </legend>
        <label>
          Name
          <input
            type="text"
            value={node.name ?? ''}
            onChange={(event) =>
              run(setName(path, (event.currentTarget as HTMLInputElement).value))
            }
          />
        </label>
        {type ? null : <p class="empty">{kind.problem} Its properties cannot be shown.</p>}
      </fieldset>
      {GROUPS.map((group) => {
        const shown = properties.filter((property) => groupOf(property.name) === group);
        if (shown.length === 0) return null;
        return (
          <fieldset key={group}>
            <legend>{group}</legend>
            {shown.map((property) => (
              <PropertyField
                key={property.name}
                path={path}
                property={property}
                value={node.props?.[property.name]}
                inherited={kind.inherited[property.name]}
                context={context}
                invalid={invalid(property.name)}
              />
            ))}
          </fieldset>
        );
      })}
      {node.prefab === undefined ? null : (
        <InstanceParams
          path={path}
          node={node}
          specs={kind.params}
          context={context}
          invalid={(name) =>
            own.some(
              (issue) =>
                issue.path === `${at}.params.${name}` ||
                issue.path.startsWith(`${at}.params.${name}.`),
            )
          }
        />
      )}
      {/* An instance's path and faces are its prefab's. */}
      {node.prefab === undefined && typeName === 'PathShape' ? (
        <PathEditor path={path} node={node} context={context} />
      ) : null}
      {node.prefab === undefined && typeName === 'Box' ? (
        <FacesEditor path={path} node={node} context={context} />
      ) : null}
      {/* A prefab holds no prefabs: in a prefab's mode, nothing becomes one. */}
      {path.length > 0 && node.prefab === undefined && prefabMode.value === null ? (
        <MakePrefab path={path} />
      ) : null}
    </form>
  );
}

/**
 * A plain value of `property` (no binding), as a behavior's ends hold it: a number, a vector, a
 * rotation (a quaternion, edited as Euler angles), a CSS color (emptied, `null` where the property
 * takes it, otherwise no change), a boolean or one of an enum's values. A `value` not of the
 * property's kind shows as its default; an enum value it does not list stays listed.
 */
export function ValueField(props: {
  label: string;
  property: Property;
  value: unknown;
  onValue(next: PropertyValue): void;
}) {
  const { label, property, value, onValue } = props;
  switch (property.type) {
    case 'number':
      return (
        <NumberInput
          label={label}
          value={typeof value === 'number' ? value : undefined}
          placeholder={String(property.default)}
          min={property.min}
          max={property.max}
          step={property.integer ? 1 : undefined}
          onValue={(next) => onValue(next as number)}
        />
      );
    case 'vec3':
      return (
        <VectorInputs
          label={label}
          value={coordinates(value)}
          fallback={property.default}
          onValue={(next) => onValue({ ...property.default, ...next } as Vec3)}
        />
      );
    case 'quat':
      return (
        <EulerInputs label={label} value={value} fallback={property.default} onValue={onValue} />
      );
    case 'color': {
      const shown = typeof value === 'string' ? value : '';
      return (
        <input
          type="text"
          aria-label={label}
          value={shown}
          placeholder={property.default ?? 'none'}
          onChange={(event) => {
            const input = event.currentTarget as HTMLInputElement;
            const text = input.value.trim();
            if (text !== '') onValue(text);
            else if (property.nullable) onValue(null);
            else {
              input.value = shown;
              problem.value = `${label} takes a color: it cannot be empty.`;
            }
          }}
        />
      );
    }
    case 'bool':
      return (
        <input
          type="checkbox"
          aria-label={label}
          checked={typeof value === 'boolean' ? value : property.default}
          onChange={(event) => onValue((event.currentTarget as HTMLInputElement).checked)}
        />
      );
    case 'enum':
      return (
        <select
          aria-label={label}
          value={typeof value === 'string' ? value : property.default}
          onChange={(event) => onValue((event.currentTarget as HTMLSelectElement).value)}
        >
          {typeof value === 'string' && !property.values.includes(value) ? (
            <option value={value}>{value}</option>
          ) : null}
          {property.values.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      );
  }
}
