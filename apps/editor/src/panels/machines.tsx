import { CONDITION_OPS, INPUT_NAME_PATTERN, INPUT_TYPES, type InputType } from '@mascotte/engine';
import type { MachineDocument, MascotDocument } from '@mascotte/format';
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { setDocumentField } from '../model/commands.ts';
import type { EditorDocument } from '../model/editor-document.ts';
import { attempt, editor, frame, problem, state } from '../store.ts';
import { numberOf } from './document-panel.tsx';

type Transition = NonNullable<MachineDocument['transitions']>[number];
type Condition = NonNullable<Transition['conditions']>[number];
type Input = NonNullable<MachineDocument['inputs']>[number];
type State = MachineDocument['states'][number];

/**
 * What the panel has open: a machine (its index in the document's machines) and a transition of
 * it (its index), for the editor they were opened in; another document opened starts over.
 */
const opened = signal<{ editor: unknown; machine: number; transition: number | null }>({
  editor: null,
  machine: 0,
  transition: null,
});
/**
 * The editor whose document the preview plays (its animator stepped, its machines driven by the
 * inputs), or `null`. Another editor shown (another document, a prefab's mode) stops it.
 */
export const previewing = signal<EditorDocument | null>(null);

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What is open, for the open document (nothing yet in another). */
function openNow(): { machine: number; transition: number | null } {
  const now = opened.value;
  return now.editor === editor.value ? now : { machine: 0, transition: null };
}

function open(machine: number, transition: number | null): void {
  opened.value = { editor: editor.peek(), machine, transition };
}

/** Stores the document's machines as `make` gives them, as a step; what goes wrong is said. */
function setMachines(make: () => readonly unknown[]): void {
  attempt('Could not change the machines', () => {
    const current = editor.value;
    const next = make() as readonly MachineDocument[];
    current.execute(setDocumentField(['machines'], next.length === 0 ? undefined : next));
    current.commit();
  });
}

/**
 * The machines of a document (each entry as stored: one that is no object is the format's to
 * report), or `null` when they are not a list.
 */
function machinesOf(document: MascotDocument): readonly unknown[] | null {
  const stored: unknown = document.machines;
  if (stored === undefined) return [];
  return Array.isArray(stored) ? stored : null;
}

/** A list the document stores (its entries unchecked), or none when it is not one. */
function listOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** `object` with `key` set to `value`, or without it for `undefined`. */
function withKey<T extends object>(object: T, key: string, value: unknown): T {
  const { [key]: _, ...rest } = object as Record<string, unknown>;
  return (value === undefined ? rest : { ...rest, [key]: value }) as T;
}

/** The names of the document's layers that are objects. */
function layerNamesOf(document: MascotDocument): string[] {
  return listOf<unknown>(document.layers)
    .filter(isObject)
    .map((layer) => String(layer.name));
}

/** What a state plays, as its state shows it: a motion's name, `inline`, or nothing. */
function motionLabel(motion: unknown): string {
  if (typeof motion === 'string') return motion;
  return motion ? 'inline' : '';
}

/** The machine's name in the machines' select. */
function machineLabel(machine: unknown, index: number): string {
  if (!isObject(machine)) return `${index + 1}: not a machine`;
  return typeof machine.name === 'string' ? machine.name : `machine ${index + 1}`;
}

/** Removes the document's machine `index`, and opens the first. */
function removeMachine(machines: readonly unknown[], index: number): void {
  open(0, null);
  setMachines(() => machines.filter((_, i) => i !== index));
}

/** A condition on `input` of `type`, at its kind's default: a number `> 0`, a bool true, a trigger fired. */
function conditionFor(input: string, type: unknown): Condition {
  return type === 'number' ? { input, op: '>', value: 0 } : { input };
}

/**
 * Stops the preview, and builds the scene it played again at rest (the animator stepped it into a
 * pose), in the editor it played in. A failure to build is said in the menu bar.
 */
function stopPreview(): void {
  const played = previewing.peek();
  if (!played) return;
  previewing.value = null;
  attempt('Could not stop it', () => played.rest());
}

/**
 * A number field. Emptied, an `optional` one gives `undefined`; otherwise, and for text that is not
 * a number, nothing changes and the stored value shows again.
 */
function NumberField(props: {
  label: string;
  value: unknown;
  placeholder?: string;
  optional?: boolean;
  onValue(next: number | undefined): void;
}) {
  const value = typeof props.value === 'number' ? props.value : undefined;
  return (
    <label>
      {props.label}
      <input
        type="number"
        step="any"
        value={value ?? ''}
        placeholder={props.placeholder}
        onChange={(event) => {
          const input = event.currentTarget as HTMLInputElement;
          const next = numberOf(input);
          if (next === null || (next === undefined && !props.optional)) {
            input.value = value === undefined ? '' : String(value);
            return;
          }
          props.onValue(next);
        }}
      />
    </label>
  );
}

/** A name and a button that adds something by it. */
function NewName(props: { label: string; add: (name: string) => void }) {
  const [name, setName] = useState('');
  const submit = () => {
    if (name.trim() === '') return;
    props.add(name.trim());
    setName('');
  };
  return (
    <span class="field-row">
      <input
        type="text"
        aria-label={`${props.label} name`}
        placeholder="name"
        value={name}
        onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
      />
      <button type="button" onClick={submit}>
        {props.label}
      </button>
    </span>
  );
}

/** A select that keeps a stored value it does not list (the format reports it) as an option. */
function Choice<V extends string>(props: {
  label: string;
  value: string;
  options: readonly (readonly [V, string])[];
  onValue(next: V): void;
}) {
  const known = props.options.some(([value]) => value === props.value);
  return (
    <label>
      {props.label}
      <select
        value={props.value}
        onChange={(event) => props.onValue((event.currentTarget as HTMLSelectElement).value as V)}
      >
        {known ? null : <option value={props.value}>{props.value || 'none'}</option>}
        {props.options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The scene the preview plays in the editor shown, or `undefined` when it plays none. */
function playingScene() {
  const { scene, stale } = state.value;
  return previewing.value === editor.value && scene && !stale ? scene : undefined;
}

/**
 * The machine's graph: the any-state, then its states in a row (the motion each plays),
 * transitions as arrows (one into its own state as a loop); the transition selected and, while
 * playing, the state the machine is in lit. It alone renders again on each preview step.
 */
function Graph(props: { machine: MachineDocument; index: number; selected: number | null }) {
  const { machine, index, selected } = props;
  frame.value;
  const active = playingScene()?.animator.stateMachines[index]?.state ?? null;
  const states = listOf<State>(machine.states).filter(isObject);
  const transitions = listOf<Transition>(machine.transitions);
  const box = { width: 110, height: 40, gap: 50 };
  const names = ['*', ...states.map((each) => String(each.name))];
  const x = (name: unknown) => {
    const at = names.indexOf(String(name));
    return at < 0 ? null : 10 + at * (box.width + box.gap);
  };
  const width = 20 + names.length * (box.width + box.gap);
  const height = 160;
  const y = 60;
  return (
    <svg
      class="machine-graph"
      role="img"
      aria-label={`The graph of ${machine.name ?? 'the machine'}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L10,5 L0,10 z" class="machine-arrow-head" />
        </marker>
      </defs>
      {transitions.map((transition, i) => {
        if (!isObject(transition)) return null;
        const from = x(transition.from);
        // Nothing goes into the any-state: one that says so is the transition's issue.
        const to = transition.to === '*' ? null : x(transition.to);
        // A transition naming a state the machine lacks is its issue: it has nowhere to go.
        if (from === null || to === null) return null;
        const startX = from + box.width / 2;
        const endX = to + box.width / 2;
        // Into its own state: a loop over the box. Otherwise arrows to the right bend up, to the
        // left down, so a pair of opposite ones part.
        const d =
          from === to
            ? `M ${startX - 15} ${y} C ${startX - 30} ${y - 45} ${startX + 30} ${y - 45} ${startX + 15} ${y}`
            : to > from
              ? `M ${startX} ${y} Q ${(startX + endX) / 2} ${y - 40} ${endX} ${y}`
              : `M ${startX} ${y + box.height} Q ${(startX + endX) / 2} ${y + box.height + 40} ${endX} ${y + box.height}`;
        return (
          <path
            key={i}
            class={i === selected ? 'machine-edge selected' : 'machine-edge'}
            d={d}
            marker-end="url(#arrow)"
          />
        );
      })}
      {names.map((name) => {
        const state = states.find((each) => String(each.name) === name);
        const motion = motionLabel(state?.motion);
        const left = x(name) as number;
        const classes = [
          'machine-state',
          name === '*' ? 'any' : '',
          name === active ? 'active' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <g key={name} class={classes}>
            <rect x={left} y={y} width={box.width} height={box.height} rx="6" />
            <text x={left + box.width / 2} y={y + 17} text-anchor="middle">
              {name === '*' ? 'any state' : name}
            </text>
            {motion ? (
              <text class="machine-motion" x={left + box.width / 2} y={y + 32} text-anchor="middle">
                {motion}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** A transition's form: its ends, its conditions on the machine's inputs, its duration and exit time. */
function TransitionForm(props: {
  machine: MachineDocument;
  index: number;
  set(next: Transition): void;
  remove(): void;
}) {
  const { machine, index, set } = props;
  const transition = listOf<unknown>(machine.transitions)[index];
  if (!isObject(transition)) {
    return (
      <div class="field-row">
        <span class="empty">{`Transition ${index + 1} is not a transition (see the issues).`}</span>
        <button type="button" onClick={props.remove}>
          Remove transition
        </button>
      </div>
    );
  }
  const current = transition as unknown as Transition;
  const states = listOf<State>(machine.states)
    .filter(isObject)
    .map((each) => String(each.name));
  const inputs = listOf<Input>(machine.inputs).filter(isObject);
  const typeOf = (name: string): InputType | undefined => {
    const type = inputs.find((input) => input.name === name)?.type;
    return (INPUT_TYPES as readonly unknown[]).includes(type) ? type : undefined;
  };
  const conditions = listOf<unknown>(current.conditions);
  const setConditions = (next: readonly unknown[]) =>
    set(withKey(current, 'conditions', next.length === 0 ? undefined : next));
  return (
    <fieldset class="group transition-form" aria-label="Transition">
      <legend>{`${String(current.from)} → ${String(current.to)}`}</legend>
      <div class="field-row">
        <Choice
          label="From"
          value={String(current.from)}
          options={[['*', 'any state'], ...states.map((each) => [each, each] as const)]}
          onValue={(from) => set({ ...current, from })}
        />
        <Choice
          label="To"
          value={String(current.to)}
          options={states.map((each) => [each, each] as const)}
          onValue={(to) => set({ ...current, to })}
        />
        <NumberField
          label="Duration"
          value={current.duration}
          placeholder="0"
          optional
          onValue={(next) => set(withKey(current, 'duration', next))}
        />
        <NumberField
          label="Exit time"
          value={current.exitTime}
          placeholder="none"
          optional
          onValue={(next) => set(withKey(current, 'exitTime', next))}
        />
        <button type="button" onClick={props.remove}>
          Remove transition
        </button>
      </div>
      {conditions.map((condition, i) => {
        const label = `Condition ${i + 1}`;
        const remove = (
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={() => setConditions(conditions.filter((_, j) => j !== i))}
          >
            ×
          </button>
        );
        if (!isObject(condition)) {
          return (
            <div key={i} class="field-row">
              <span class="empty">{`${label} is not a condition (see the issues).`}</span>
              {remove}
            </div>
          );
        }
        const stored = condition as unknown as Condition;
        const name = String(condition.input);
        const type = typeOf(name);
        const setCondition = (next: Condition) =>
          setConditions(conditions.map((each, j) => (j === i ? next : each)));
        const ops: readonly string[] =
          type === 'bool' ? ['==', '!='] : type === 'number' ? CONDITION_OPS : [];
        const op = typeof condition.op === 'string' ? condition.op : type === 'bool' ? '==' : '';
        return (
          <fieldset key={i} class="field-row" aria-label={label}>
            <Choice
              label={`${label} input`}
              value={name}
              options={inputs.map(
                (input) => [String(input.name), `${input.name} (${input.type})`] as const,
              )}
              // Picking an input starts its condition over at its kind's default.
              onValue={(input) => setCondition(conditionFor(input, typeOf(input)))}
            />
            {ops.length > 0 ? (
              <Choice
                label={`${label} op`}
                value={op}
                options={ops.map((each) => [each, each] as const)}
                onValue={(next) =>
                  setCondition(
                    withKey(stored, 'op', type === 'bool' && next === '==' ? undefined : next),
                  )
                }
              />
            ) : null}
            {type === 'bool' ? (
              <label class="check">
                <input
                  type="checkbox"
                  aria-label={`${label} value`}
                  checked={condition.value !== false}
                  onChange={(event) =>
                    setCondition(
                      withKey(
                        stored,
                        'value',
                        (event.currentTarget as HTMLInputElement).checked ? undefined : false,
                      ),
                    )
                  }
                />
                true
              </label>
            ) : null}
            {type === 'number' ? (
              <NumberField
                label={`${label} value`}
                value={condition.value}
                onValue={(next) => setCondition({ ...stored, value: next as number })}
              />
            ) : null}
            {remove}
          </fieldset>
        );
      })}
      <button
        type="button"
        disabled={inputs.length === 0}
        title={inputs.length === 0 ? 'Declare an input of the machine first.' : undefined}
        onClick={() => {
          const input = inputs[0] as Input;
          setConditions([...conditions, conditionFor(input.name, input.type)]);
        }}
      >
        Add condition
      </button>
    </fieldset>
  );
}

/** The open machine: its name, layer and first state, inputs, states and transitions, and its graph. */
function MachineEditor(props: {
  machines: readonly unknown[];
  index: number;
  selected: number | null;
}) {
  const { machines, index, selected } = props;
  const machine = machines[index] as MachineDocument;
  const { document } = state.value;
  const set = (next: MachineDocument) =>
    setMachines(() => machines.map((each, i) => (i === index ? next : each)));
  const states = listOf<unknown>(machine.states);
  const inputs = listOf<unknown>(machine.inputs);
  const transitions = listOf<unknown>(machine.transitions);
  const names = states.filter(isObject).map((each) => String(each.name));
  const layers = layerNamesOf(document);
  const motions = Object.keys(isObject(document.motions) ? document.motions : {});
  // Lists that are no lists are the format's to report: edits leave them as they are.
  const malformed = (list: unknown) => list !== undefined && !Array.isArray(list);
  /** The machine with `rest` as its transitions, the key gone when none is left. */
  const withTransitions = (base: MachineDocument, rest: readonly unknown[]) =>
    malformed(machine.transitions)
      ? base
      : withKey(base, 'transitions', rest.length === 0 ? undefined : rest);
  /** The machine with a state renamed, and every transition and the first state following it. */
  const renamed = (from: string, to: string): MachineDocument => ({
    ...machine,
    ...(machine.initial === from ? { initial: to } : {}),
    states: states.map((each) =>
      isObject(each) && each.name === from ? { ...each, name: to } : each,
    ) as State[],
    ...(Array.isArray(machine.transitions)
      ? {
          transitions: transitions.map((each) =>
            isObject(each)
              ? {
                  ...each,
                  ...(each.from === from ? { from: to } : {}),
                  ...(each.to === from ? { to } : {}),
                }
              : each,
          ) as Transition[],
        }
      : {}),
  });
  /** The machine's transitions with every condition on the input `name` rewritten by `change`. */
  const onInput = (name: unknown, change: (condition: Condition) => Condition | null) =>
    transitions.map((transition) => {
      if (!isObject(transition) || !Array.isArray(transition.conditions)) return transition;
      const conditions = transition.conditions.flatMap((condition: unknown) => {
        if (!isObject(condition) || condition.input !== name) return [condition];
        const next = change(condition as unknown as Condition);
        return next === null ? [] : [next];
      });
      return withKey(transition, 'conditions', conditions.length === 0 ? undefined : conditions);
    });
  return (
    <div class="machine-editor">
      <div class="field-row">
        <label>
          Name
          <input
            type="text"
            value={typeof machine.name === 'string' ? machine.name : ''}
            onChange={(event) => {
              const name = (event.currentTarget as HTMLInputElement).value.trim();
              set(withKey(machine, 'name', name === '' ? undefined : name));
            }}
          />
        </label>
        <Choice
          label="Layer"
          value={String(machine.layer ?? '')}
          options={layers.map((layer) => [layer, layer] as const)}
          onValue={(layer) => set({ ...machine, layer })}
        />
        <Choice
          label="First state"
          value={String(machine.initial ?? '')}
          options={[['', 'the first one'], ...names.map((each) => [each, each] as const)]}
          onValue={(initial) =>
            set(withKey(machine, 'initial', initial === '' ? undefined : initial))
          }
        />
        <button type="button" onClick={() => removeMachine(machines, index)}>
          Remove machine
        </button>
      </div>
      <Graph machine={machine} index={index} selected={selected} />
      <fieldset class="group" aria-label="Inputs">
        <legend>Inputs</legend>
        {inputs.map((input, i) => {
          const remove = (rest: readonly unknown[]) =>
            set(
              withTransitions(
                withKey(machine, 'inputs', rest.length === 0 ? undefined : rest),
                isObject(input) ? onInput(input.name, () => null) : transitions,
              ),
            );
          if (!isObject(input)) {
            return (
              <div key={i} class="field-row">
                <span class="empty">{`Input ${i + 1} is not an input (see the issues).`}</span>
                <button
                  type="button"
                  aria-label={`Remove input ${i + 1}`}
                  onClick={() => remove(inputs.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            );
          }
          const name = String(input.name);
          return (
            <div key={i} class="field-row">
              <span>{name}</span>
              <Choice
                label={`${name} type`}
                value={String(input.type)}
                options={INPUT_TYPES.map((type) => [type, type] as const)}
                onValue={(type) =>
                  // Its conditions start over at the new kind's default.
                  set(
                    withTransitions(
                      {
                        ...machine,
                        inputs: inputs.map((each, j) =>
                          j === i ? { name, type } : each,
                        ) as Input[],
                      },
                      onInput(input.name, () => conditionFor(name, type)),
                    ),
                  )
                }
              />
              <button
                type="button"
                aria-label={`Remove input ${name}`}
                // Its conditions go with it.
                onClick={() => remove(inputs.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          );
        })}
        <NewName
          label="Add input"
          add={(name) => {
            if (malformed(machine.inputs)) {
              problem.value = 'The inputs are not a list (see the issues).';
              return;
            }
            if (!INPUT_NAME_PATTERN.test(name)) {
              problem.value = `"${name}" is no input name: letters, digits, "." and "_".`;
              return;
            }
            if (inputs.some((input) => isObject(input) && input.name === name)) {
              problem.value = `There is an input "${name}" already.`;
              return;
            }
            set({ ...machine, inputs: [...inputs, { name, type: 'bool' }] as Input[] });
          }}
        />
      </fieldset>
      <fieldset class="group" aria-label="States">
        <legend>States</legend>
        {states.map((each, i) => {
          const removable = states.length > 1;
          const remove = () => {
            // Its transitions go with it, and it is no longer the first state.
            open(index, null);
            // A state that is no state has no name its transitions could give.
            const gone = isObject(each) ? each.name : undefined;
            const rest = transitions.filter(
              (transition) =>
                gone === undefined ||
                !isObject(transition) ||
                (transition.from !== gone && transition.to !== gone),
            );
            const base =
              machine.initial === gone ? withKey(machine, 'initial', undefined) : machine;
            set({
              ...withTransitions(base, rest),
              states: states.filter((_, j) => j !== i) as State[],
            });
          };
          if (!isObject(each)) {
            return (
              <div key={i} class="field-row">
                <span class="empty">{`State ${i + 1} is not a state (see the issues).`}</span>
                <button type="button" aria-label={`Remove state ${i + 1}`} onClick={remove}>
                  ×
                </button>
              </div>
            );
          }
          const own = String(each.name);
          return (
            <div key={i} class="field-row">
              <input
                type="text"
                aria-label={`State ${i + 1} name`}
                value={own}
                onChange={(event) => {
                  const input = event.currentTarget as HTMLInputElement;
                  const name = input.value.trim();
                  if (name === own) {
                    input.value = own;
                    return;
                  }
                  if (name === '' || name === '*' || names.includes(name)) {
                    problem.value = `A state needs a name of its own, not "${name}".`;
                    input.value = own;
                    return;
                  }
                  set(
                    typeof each.name === 'string'
                      ? renamed(each.name, name)
                      : {
                          ...machine,
                          states: states.map((other, j) =>
                            j === i ? { ...each, name } : other,
                          ) as State[],
                        },
                  );
                }}
              />
              <Choice
                label={`${own} plays`}
                value={motionLabel(each.motion)}
                options={[['', 'nothing'], ...motions.map((motion) => [motion, motion] as const)]}
                onValue={(motion) =>
                  set({
                    ...machine,
                    states: states.map((other, j) =>
                      j === i ? withKey(each, 'motion', motion === '' ? undefined : motion) : other,
                    ) as State[],
                  })
                }
              />
              <button
                type="button"
                aria-label={`Remove state ${own}`}
                disabled={!removable}
                title={removable ? undefined : 'A machine has at least one state.'}
                onClick={remove}
              >
                ×
              </button>
            </div>
          );
        })}
        <NewName
          label="Add state"
          add={(name) => {
            if (malformed(machine.states)) {
              problem.value = 'The states are not a list (see the issues).';
              return;
            }
            if (name === '*' || names.includes(name)) {
              problem.value = `A state needs a name of its own, not "${name}".`;
              return;
            }
            set({ ...machine, states: [...states, { name }] as State[] });
          }}
        />
      </fieldset>
      <fieldset class="group" aria-label="Transitions">
        <legend>Transitions</legend>
        <div class="field-row transitions">
          {transitions.map((transition, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={i === selected}
              onClick={() => open(index, i)}
            >
              {isObject(transition)
                ? `${transition.from} → ${transition.to}`
                : `${i + 1}: not a transition`}
            </button>
          ))}
          <button
            type="button"
            disabled={names.length === 0 || malformed(machine.transitions)}
            onClick={() => {
              // A transition fires on a condition: it starts with one on the first input.
              const [first, second] = names;
              const input = inputs.find(isObject);
              const transition: Transition = {
                from: first as string,
                to: (second ?? first) as string,
                ...(input ? { conditions: [conditionFor(String(input.name), input.type)] } : {}),
              };
              open(index, transitions.length);
              set({ ...machine, transitions: [...transitions, transition] as Transition[] });
            }}
          >
            Add transition
          </button>
        </div>
        {selected !== null && selected < transitions.length ? (
          <TransitionForm
            machine={machine}
            index={selected}
            set={(next) =>
              set({
                ...machine,
                transitions: transitions.map((each, j) =>
                  j === selected ? next : each,
                ) as Transition[],
              })
            }
            remove={() => {
              open(index, null);
              set(
                withTransitions(
                  machine,
                  transitions.filter((_, j) => j !== selected),
                ),
              );
            }}
          />
        ) : null}
      </fieldset>
    </div>
  );
}

/** The state each machine is in while playing; it alone of the preview renders again on each step. */
function ActiveStates() {
  frame.value;
  const scene = playingScene();
  if (!scene) return null;
  return (
    <>
      {scene.animator.stateMachines.map((machine, i) => (
        <span
          key={i}
          class="machine-active"
        >{`${machine.name || `machine ${i + 1}`}: ${machine.state}`}</span>
      ))}
    </>
  );
}

/**
 * The preview: the document's animator stepped every frame (its layers, machines, constraints and
 * springs), its machines' inputs driven here, and each machine's state. It stops, and the scene is
 * built again at rest, on Stop, when the panel closes, and when the document has issues.
 */
function Preview(props: { machines: readonly unknown[] }) {
  const { scene, stale, preview } = state.value;
  const played = previewing.value;
  const on = played === editor.value;
  // The inputs panel shows what the engine holds: it renders again after each change of one.
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!played) return;
    let last = performance.now();
    let id = requestAnimationFrame(function step(now) {
      if (previewing.peek() !== played) return;
      // Another document, or a prefab's mode: what it played goes back to rest.
      if (editor.peek() !== played) {
        stopPreview();
        return;
      }
      // Each frame steps the animator of the scene shown: a new one after an edit starts over.
      const shown = played.state;
      if (!shown.scene || shown.stale) {
        problem.value = 'The document has issues: fix them to play it.';
        stopPreview();
        return;
      }
      try {
        // A frame after a stall or a hidden tab steps at most 0.1 s, and never back.
        shown.scene.animator.update(Math.min(Math.max(0, (now - last) / 1000), 0.1));
      } catch (error) {
        console.error(error);
        problem.value = `Could not play it: ${error instanceof Error ? error.message : String(error)}`;
        stopPreview();
        return;
      }
      last = now;
      frame.value += 1;
      id = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(id);
  }, [played]);
  // Closed while playing (another tab), the preview it started stops: the scene goes back to rest.
  // Another panel's preview is not this one's to stop (a panel's cleanup may come late).
  const started = useRef<EditorDocument | null>(null);
  useEffect(
    () => () => {
      if (started.current !== null && previewing.peek() === started.current) stopPreview();
    },
    [],
  );
  const inputs = scene && !stale ? scene.animator.inputs : null;
  const names = [
    ...new Set(
      props.machines.filter(isObject).flatMap((machine) =>
        listOf<unknown>(machine.inputs)
          .filter(isObject)
          .map((input) => String(input.name)),
      ),
    ),
  ];
  return (
    <fieldset class="group machine-preview" aria-label="Preview">
      <legend>Try it</legend>
      <div class="field-row">
        <button
          type="button"
          aria-label={on ? 'Stop' : 'Play'}
          disabled={!inputs}
          onClick={() => {
            if (on) {
              stopPreview();
              return;
            }
            // The machines play the document as it is: a clip open solo closes first.
            const { solo: _, ...rest } = preview;
            attempt('Could not play it', () => {
              const current = editor.value;
              if (preview.solo) current.setPreview(rest);
              started.current = current;
              previewing.value = current;
            });
          }}
        >
          {on ? '■ Stop' : '▶ Play'}
        </button>
        <ActiveStates />
      </div>
      <div class="field-row">
        {inputs
          ? names.map((name) => {
              const type = inputs.typeOf(name);
              if (type === 'trigger') {
                return (
                  <button key={name} type="button" disabled={!on} onClick={() => inputs.fire(name)}>
                    {`Fire ${name}`}
                  </button>
                );
              }
              if (type === 'bool') {
                return (
                  <label key={name} class="check">
                    <input
                      type="checkbox"
                      aria-label={`Input ${name}`}
                      checked={inputs.get(name) === true}
                      onChange={(event) => {
                        inputs.set(name, (event.currentTarget as HTMLInputElement).checked);
                        redraw((n) => n + 1);
                      }}
                    />
                    {name}
                  </label>
                );
              }
              if (type === 'number') {
                return (
                  <NumberField
                    key={name}
                    label={`Input ${name}`}
                    value={inputs.get(name)}
                    onValue={(next) => {
                      if (next !== undefined) inputs.set(name, next);
                      redraw((n) => n + 1);
                    }}
                  />
                );
              }
              return null;
            })
          : null}
      </div>
    </fieldset>
  );
}

/**
 * The state machine editor (docs/EDITOR.md, State machine editor): the document's machines, each
 * as a graph with its inputs, states and transitions; and a preview to try them with the inputs.
 */
export function Machines() {
  const { document } = state.value;
  const machines = machinesOf(document);
  if (machines === null) {
    return (
      <div class="machines">
        <p class="empty">The machines are malformed (see the issues).</p>
        <button type="button" onClick={() => setMachines(() => [])}>
          Remove the machines
        </button>
      </div>
    );
  }
  // The machine open, or the last there is (one removed by an undo); its transition only if it
  // is still the one that was open.
  const now = openNow();
  const index = Math.min(now.machine, machines.length - 1);
  const machine = index >= 0 ? machines[index] : undefined;
  const selected = index === now.machine ? now.transition : null;
  return (
    <div class="machines">
      <div class="field-row">
        <select
          aria-label="Machine"
          value={String(index)}
          onChange={(event) => open(Number((event.currentTarget as HTMLSelectElement).value), null)}
        >
          {machines.length === 0 ? <option value="-1">no machine</option> : null}
          {machines.map((each, i) => (
            <option key={i} value={String(i)}>
              {machineLabel(each, i)}
            </option>
          ))}
        </select>
        <NewName
          label="New machine"
          add={(name) => {
            if (machines.some((each) => isObject(each) && each.name === name)) {
              problem.value = `There is a machine "${name}" already.`;
              return;
            }
            // It drives the first layer no machine drives yet (one machine per layer).
            const used = new Set(machines.filter(isObject).map((each) => each.layer));
            const layer = layerNamesOf(document).find((each) => !used.has(each));
            if (layer === undefined) {
              problem.value = 'Every layer has a machine: add a layer for this one to drive.';
            }
            open(machines.length, null);
            setMachines(() => [
              ...machines,
              { name, layer: layer ?? '', states: [{ name: 'idle' }] },
            ]);
          }}
        />
      </div>
      {machine === undefined ? (
        <p class="empty">No machine: make one to drive a layer by its inputs.</p>
      ) : isObject(machine) ? (
        <MachineEditor key={index} machines={machines} index={index} selected={selected} />
      ) : (
        <div class="field-row">
          <span class="empty">{`Machine ${index + 1} is not a machine (see the issues).`}</span>
          <button type="button" onClick={() => removeMachine(machines, index)}>
            Remove machine
          </button>
        </div>
      )}
      <Preview machines={machines} />
    </div>
  );
}
