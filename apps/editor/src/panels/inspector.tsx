import { BOX_FACES, type BoxFace, Node, type Property, propertiesOf } from '@mascotte/engine';
import {
  type ColorRef,
  isColorRef,
  type MascotDocument,
  NODE_TYPES,
  type NodeDocument,
  type PathCommandDocument,
  type PropertyValue,
  type ScalarRef,
  type VectorRef,
} from '@mascotte/format';
import { PREFABS } from '@mascotte/library';
import { color, euler, type Quat, quat, type Vec3 } from '@mascotte/math';
import type { ComponentChildren } from 'preact';
import { type Command, setName, setNodeField, setProp } from '../model/commands.ts';
import { type DocPath, nodeAt, pathString } from '../model/paths.ts';
import { attempt, editor, state } from '../store.ts';
import { numberOf } from './document-panel.tsx';

type Ref = ScalarRef | VectorRef;
type Faces = NonNullable<NodeDocument['faces']>;
type FaceSettings = NonNullable<Faces[BoxFace]>;
/** A path command as the editor handles it: its type and its points by name. */
type LooseCommand = { readonly type: string } & Readonly<Record<string, unknown>>;

const AXES = ['x', 'y', 'z'] as const;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const ONE: Vec3 = { x: 1, y: 1, z: 1 };
const TRANSFORM = new Set(['position', 'rotation', 'scale', 'pivot']);
const NODE_PROPERTIES = new Set(propertiesOf(Node).map((property) => property.name));
// The points of each path command, in the format's order.
const COMMAND_POINTS: Readonly<Record<string, readonly string[]>> = {
  move: ['point'],
  line: ['point'],
  bezier: ['control1', 'control2', 'point'],
  arc: ['corner', 'point'],
};

/** What the editors need from the document: its parameters and palette roles. */
interface Context {
  readonly document: MascotDocument;
  readonly params: readonly string[];
  readonly roles: readonly string[];
}

/** Runs `command` as a step of its own: an edit in the inspector is not a gesture. */
function run(command: Command): void {
  attempt('Could not change the node', () => {
    const current = editor.value;
    current.execute(command);
    current.commit();
  });
}

function isRef(value: unknown): value is Ref {
  return typeof value === 'object' && value !== null && 'param' in value;
}

function isVec3(value: unknown): value is Vec3 {
  return (
    typeof value === 'object' &&
    value !== null &&
    AXES.every((axis) => typeof (value as Record<string, unknown>)[axis] === 'number')
  );
}

/** `object` with `key` set to `value`, or without it for `undefined`. */
function withKey<T extends object>(object: T, key: string, value: unknown): T {
  const { [key]: _, ...rest } = object as Record<string, unknown>;
  return (value === undefined ? rest : { ...rest, [key]: value }) as T;
}

/** What a reference comes to with the document's parameters at their defaults (an unknown one is 0). */
function resolve(ref: Ref, document: MascotDocument): number | Vec3 {
  const value = document.params?.[ref.param]?.default ?? 0;
  const plus = isRef(ref.plus) ? resolve(ref.plus, document) : ref.plus;
  if (typeof ref.times === 'object') {
    const add = isVec3(plus) ? plus : ZERO;
    return {
      x: value * ref.times.x + add.x,
      y: value * ref.times.y + add.y,
      z: value * ref.times.z + add.z,
    };
  }
  return value * (ref.times ?? 1) + (typeof plus === 'number' ? plus : 0);
}

/** The palette roles, the base palette's first. */
function rolesOf(document: MascotDocument): string[] {
  return [...new Set(Object.values(document.palettes ?? {}).flatMap(Object.keys))];
}

/** The color of `role`: the base palette's, or the first palette naming it. */
function colorOf(document: MascotDocument, role: string): string | undefined {
  return Object.values(document.palettes ?? {}).find((palette) => Object.hasOwn(palette, role))?.[
    role
  ];
}

/** The node type of a node: its own, or its prefab's root's for an instance. */
function typeOf(document: MascotDocument, node: NodeDocument): string | undefined {
  if (node.prefab === undefined) return node.type;
  const prefab = document.prefabs?.[node.prefab] ?? PREFABS.get(node.prefab);
  const type = prefab?.root.type;
  return typeof type === 'string' ? type : undefined;
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
  value: Ref;
  context: Context;
  onValue(next: Ref): void;
}) {
  const { label, value, context, onValue } = props;
  const vector = typeof value.times === 'object';
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
          value={value.times as Vec3}
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
            const bound = (event.currentTarget as HTMLSelectElement).value === 'param';
            onValue(
              withKey(
                value,
                'plus',
                bound
                  ? vector
                    ? { param: value.param, times: ONE }
                    : { param: value.param }
                  : undefined,
              ),
            );
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
          onValue={(next) => onValue({ ...value, plus: next } as Ref)}
        />
      ) : vector ? (
        <VectorInputs
          label={`${label} plus`}
          value={isVec3(plus) ? plus : undefined}
          fallback={ZERO}
          onValue={(next) => onValue({ ...value, plus: next as Vec3 } as VectorRef)}
        />
      ) : null}
    </fieldset>
  );
}

/**
 * Where a bindable value comes from: itself, or a parameter (`kind` "param") or a palette role
 * ("palette"). Binding starts from the first parameter or role; unbinding keeps what the
 * binding comes to.
 */
function SourceSelect(props: {
  label: string;
  kind: 'param' | 'palette';
  bound: boolean;
  available: boolean;
  onBind(): void;
  onUnbind(): void;
}) {
  return (
    <select
      aria-label={`${props.label} source`}
      value={props.bound ? props.kind : 'value'}
      onChange={(event) =>
        (event.currentTarget as HTMLSelectElement).value === 'value'
          ? props.onUnbind()
          : props.onBind()
      }
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
        value={parsed ? color.toHex(parsed).slice(0, 7) : '#ffffff'}
        onChange={(event) => change((event.currentTarget as HTMLInputElement).value)}
      />
    </div>
  );
}

/** The source select of a color: its own value or a palette role. */
function colorSource(
  label: string,
  value: unknown,
  context: Context,
  onValue: (next: string | ColorRef) => void,
) {
  return (
    <SourceSelect
      label={label}
      kind="palette"
      bound={isColorRef(value)}
      available={context.roles.length > 0}
      onBind={() => onValue({ color: context.roles[0] as string })}
      onUnbind={() =>
        isColorRef(value) && onValue(colorOf(context.document, value.color) ?? '#000000')
      }
    />
  );
}

/** The source select of a number or vector: its own value or a parameter. */
function paramSource(
  label: string,
  value: unknown,
  vector: boolean,
  context: Context,
  onValue: (next: Ref | number | Vec3) => void,
) {
  const param = context.params[0] as string;
  return (
    <SourceSelect
      label={label}
      kind="param"
      bound={isRef(value)}
      available={context.params.length > 0}
      onBind={() => onValue(vector ? { param, times: ONE } : { param })}
      onUnbind={() => isRef(value) && onValue(resolve(value, context.document))}
    />
  );
}

/** Euler angles in degrees (XYZ) for a rotation the document stores as a quaternion. */
function EulerInputs(props: { label: string; value: unknown; onValue(next: Quat): void }) {
  const stored = props.value as Quat | undefined;
  const angles = quat.toEuler(euler.create(), stored ?? quat.create(), 'XYZ');
  const degrees = (radians: number) => Math.round(((radians * 180) / Math.PI) * 1000) / 1000;
  return (
    <div class="field-row">
      {AXES.map((axis) => (
        <NumberInput
          key={axis}
          label={`${props.label} ${axis}`}
          value={stored === undefined ? undefined : degrees(angles[axis])}
          placeholder="0"
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

/** The editor of one registry property of the node at `path`. */
function PropertyField(props: {
  path: DocPath;
  property: Property;
  value: PropertyValue | undefined;
  context: Context;
  invalid: boolean;
}) {
  const { path, property, value, context } = props;
  const name = property.name;
  const set = (next: PropertyValue | undefined) => run(setProp(path, name, next));
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
          placeholder={String(property.default)}
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
          value={isVec3(value) ? value : undefined}
          fallback={property.default}
          onValue={(next) => set(next as Vec3)}
        />
      );
      break;
    case 'quat':
      body = <EulerInputs label={name} value={value} onValue={set} />;
      break;
    case 'color':
      source = colorSource(name, value, context, set);
      body = (
        <ColorEditor
          label={name}
          value={value}
          placeholder={property.default ?? 'none'}
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
          checked={typeof value === 'boolean' ? value : property.default}
          onChange={(event) => set((event.currentTarget as HTMLInputElement).checked)}
        />
      );
      break;
    case 'enum':
      body = (
        <select
          aria-label={name}
          value={typeof value === 'string' ? value : property.default}
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
      reset={value === undefined ? null : () => set(undefined)}
    >
      {body}
    </Field>
  );
}

/** A path's commands: their types and points (each a vector or bound to a parameter). */
function PathEditor(props: { path: DocPath; node: NodeDocument; context: Context }) {
  const { path, context } = props;
  const list = (props.node.path ?? []) as unknown as readonly LooseCommand[];
  const set = (next: readonly LooseCommand[]) =>
    run(
      setNodeField(
        path,
        'path',
        next.length === 0 ? undefined : (next as unknown as PathCommandDocument[]),
      ),
    );
  const change = (i: number, next: LooseCommand) =>
    set(list.map((command, j) => (j === i ? next : command)));
  const last = list.at(-1)?.point;
  return (
    <fieldset>
      <legend>Path</legend>
      {list.map((command, i) => {
        const label = `Path ${i + 1}`;
        return (
          <div key={i} class="path-command">
            <div class="prop-head">
              <select
                aria-label={`${label} type`}
                value={command.type}
                onChange={(event) => {
                  const type = (event.currentTarget as HTMLSelectElement).value;
                  const points = COMMAND_POINTS[type] ?? [];
                  // The points it had keep their places; new ones start at its end point.
                  const next = Object.fromEntries(
                    points.map((key) => [key, command[key] ?? command.point ?? {}]),
                  );
                  change(i, { type, ...next });
                }}
              >
                {Object.keys(COMMAND_POINTS).map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Remove ${label}`}
                onClick={() => set(list.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
            {(COMMAND_POINTS[command.type] ?? []).map((key) => {
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
                      value={point as Partial<Vec3> | undefined}
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
          set([
            ...list,
            { type: list.length === 0 ? 'move' : 'line', point: isRef(last) ? {} : (last ?? {}) },
          ])
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
  const faces: Faces = props.node.faces ?? {};
  const set = (face: BoxFace, settings: FaceSettings) => {
    const next = withKey(faces, face, Object.keys(settings).length === 0 ? undefined : settings);
    run(setNodeField(path, 'faces', Object.keys(next).length === 0 ? undefined : next));
  };
  return (
    <fieldset>
      <legend>Faces</legend>
      {BOX_FACES.map((face) => {
        const settings: FaceSettings = faces[face] ?? {};
        const label = `${face} face color`;
        const setColor = (next: unknown) => set(face, withKey(settings, 'color', next));
        return (
          <Field
            key={face}
            title={face}
            label={`${face} face`}
            source={colorSource(label, settings.color, context, setColor)}
            reset={faces[face] === undefined ? null : () => set(face, {})}
          >
            <div class="field-row">
              <label class="check">
                <input
                  type="checkbox"
                  checked={settings.visible ?? true}
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
                {`${face} visible`}
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

/** The group a property is shown in. */
function groupOf(name: string): string {
  if (TRANSFORM.has(name)) return 'Transform';
  if (name.startsWith('style.')) return 'Style';
  if (NODE_PROPERTIES.has(name)) return 'Display';
  return 'Shape';
}

const GROUPS = ['Transform', 'Shape', 'Style', 'Display'];

/**
 * The inspector (docs/EDITOR.md, 3.4): the selected node's properties as the document stores
 * them (rest values, not the animated pose), made from the registry, with a path's points and a
 * box's faces. Numbers and vectors may be bound to parameters, colors to palette roles. Each
 * edit is a command, undone as one step.
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
  const typeName = typeOf(document, node);
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
        {type ? null : <p class="empty">Unknown type: its properties cannot be shown.</p>}
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
                context={context}
                invalid={invalid(property.name)}
              />
            ))}
          </fieldset>
        );
      })}
      {/* An instance's path and faces are its prefab's. */}
      {node.prefab === undefined && typeName === 'PathShape' ? (
        <PathEditor path={path} node={node} context={context} />
      ) : null}
      {node.prefab === undefined && typeName === 'Box' ? (
        <FacesEditor path={path} node={node} context={context} />
      ) : null}
    </form>
  );
}
