import { CONDITION_OPS, INPUT_TYPES, type InputType } from '@mascotte/engine';
import type { MachineDocument, MascotDocument } from '@mascotte/format';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { setDocumentField } from '../model/commands.ts';
import { attempt, editor, frame, problem, state } from '../store.ts';
import { numberOf } from './document-panel.tsx';

type Transition = NonNullable<MachineDocument['transitions']>[number];
type Condition = NonNullable<Transition['conditions']>[number];
type Input = NonNullable<MachineDocument['inputs']>[number];
type State = MachineDocument['states'][number];

/** The machine open (its index in the document's machines). */
const openMachine = signal(0);
/** The transition selected in the open machine (its index), or `null`. */
const openTransition = signal<number | null>(null);
/** Whether the preview plays: the document's animator stepped, its machines driven by the inputs. */
export const previewing = signal(false);

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stores the document's machines as `make` gives them, as a step; what goes wrong is said. */
function setMachines(make: () => readonly MachineDocument[]): void {
  attempt('Could not change the machines', () => {
    const current = editor.value;
    const next = make();
    current.execute(setDocumentField(['machines'], next.length === 0 ? undefined : next));
    current.commit();
  });
}

/** The machines of a document whose machines are a list of objects; `null` when they are not. */
function machinesOf(document: MascotDocument): readonly MachineDocument[] | null {
  const stored: unknown = document.machines;
  if (stored === undefined) return [];
  return Array.isArray(stored) && stored.every(isObject)
    ? (stored as unknown as MachineDocument[])
    : null;
}

/** A list the document stores, or none when it is not one (the format reports it). */
function listOf<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** A number field: emptied, an `optional` one gives `undefined`; bad text changes nothing. */
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
function Choice(props: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onValue(next: string): void;
}) {
  const known = props.options.some(([value]) => value === props.value);
  return (
    <label>
      {props.label}
      <select
        value={props.value}
        onChange={(event) => props.onValue((event.currentTarget as HTMLSelectElement).value)}
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

/** `object` with `key` set to `value`, or without it for `undefined`. */
function withKey<T extends object>(object: T, key: string, value: unknown): T {
  const { [key]: _, ...rest } = object as Record<string, unknown>;
  return (value === undefined ? rest : { ...rest, [key]: value }) as T;
}

/** The machine's graph: its states as boxes (the motion each plays), the any-state, transitions as arrows. */
function Graph(props: {
  machine: MachineDocument;
  active: string | null;
  selected: number | null;
}) {
  const { machine, active, selected } = props;
  const states = listOf<State>(machine.states).filter(isObject);
  const transitions = listOf<Transition>(machine.transitions).filter(isObject);
  const box = { width: 110, height: 40, gap: 50 };
  // The any-state first, then the states in a row.
  const names = ['*', ...states.map((each) => String(each.name))];
  const x = (name: string) => {
    const at = names.indexOf(name);
    return at < 0 ? null : 10 + at * (box.width + box.gap);
  };
  const width = 20 + names.length * (box.width + box.gap);
  const height = 150;
  const y = 55;
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
        const from = x(String(transition.from));
        const to = x(String(transition.to));
        if (from === null || to === null || from === to) return null;
        // Arrows to the right bend up, to the left down, so a pair of opposite ones part.
        const right = to > from;
        const startX = from + box.width / 2;
        const endX = to + box.width / 2;
        const edgeY = right ? y : y + box.height;
        const bend = right ? -40 : 40;
        return (
          <path
            key={i}
            class={i === selected ? 'machine-edge selected' : 'machine-edge'}
            d={`M ${startX} ${edgeY} Q ${(startX + endX) / 2} ${edgeY + bend} ${endX} ${edgeY}`}
            marker-end="url(#arrow)"
          />
        );
      })}
      {names.map((name) => {
        const state = states.find((each) => each.name === name);
        const motion =
          typeof state?.motion === 'string' ? state.motion : state?.motion ? 'inline' : '';
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
  const transition = listOf<Transition>(machine.transitions)[index];
  if (!isObject(transition)) return null;
  const states = listOf<State>(machine.states)
    .filter(isObject)
    .map((each) => String(each.name));
  const inputs = listOf<Input>(machine.inputs).filter(isObject);
  const typeOf = (name: string): InputType | undefined =>
    inputs.find((input) => input.name === name)?.type;
  const conditions = listOf<Condition>(transition.conditions);
  const setConditions = (next: readonly Condition[]) =>
    set(withKey(transition, 'conditions', next.length === 0 ? undefined : next));
  const label = 'Transition';
  return (
    <fieldset class="group transition-form" aria-label={label}>
      <legend>{`${transition.from} → ${transition.to}`}</legend>
      <div class="field-row">
        <Choice
          label="From"
          value={String(transition.from)}
          options={[['*', 'any state'], ...states.map((each) => [each, each] as const)]}
          onValue={(from) => set({ ...transition, from })}
        />
        <Choice
          label="To"
          value={String(transition.to)}
          options={states.map((each) => [each, each] as const)}
          onValue={(to) => set({ ...transition, to })}
        />
        <NumberField
          label="Duration"
          value={transition.duration}
          placeholder="0"
          optional
          onValue={(next) => set(withKey(transition, 'duration', next))}
        />
        <NumberField
          label="Exit time"
          value={transition.exitTime}
          placeholder="none"
          optional
          onValue={(next) => set(withKey(transition, 'exitTime', next))}
        />
        <button type="button" onClick={props.remove}>
          Remove transition
        </button>
      </div>
      {conditions.map((condition, i) => {
        const name = isObject(condition) ? String(condition.input) : '';
        const type = typeOf(name);
        const setCondition = (next: Condition) =>
          setConditions(conditions.map((each, j) => (j === i ? next : each)));
        const ops: readonly string[] =
          type === 'bool' ? ['==', '!='] : type === 'number' ? CONDITION_OPS : [];
        return (
          <fieldset key={i} class="field-row" aria-label={`Condition ${i + 1}`}>
            <Choice
              label={`Condition ${i + 1} input`}
              value={name}
              options={inputs.map(
                (input) => [input.name, `${input.name} (${input.type})`] as const,
              )}
              onValue={(input) => {
                // Another input's kind takes its own comparison: it starts at its default.
                const next = typeOf(input);
                setCondition(next === 'number' ? { input, op: '>', value: 0 } : { input });
              }}
            />
            {ops.length > 0 ? (
              <Choice
                label={`Condition ${i + 1} op`}
                value={
                  isObject(condition) && typeof condition.op === 'string' ? condition.op : '=='
                }
                options={ops.map((op) => [op, op] as const)}
                onValue={(op) =>
                  setCondition(
                    withKey(condition, 'op', type === 'bool' && op === '==' ? undefined : op),
                  )
                }
              />
            ) : null}
            {type === 'bool' ? (
              <label class="check">
                <input
                  type="checkbox"
                  aria-label={`Condition ${i + 1} value`}
                  checked={condition.value !== false}
                  onChange={(event) =>
                    setCondition(
                      withKey(
                        condition,
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
                label={`Condition ${i + 1} value`}
                value={condition.value}
                onValue={(next) => setCondition({ ...condition, value: next as number })}
              />
            ) : null}
            <button
              type="button"
              aria-label={`Remove Condition ${i + 1}`}
              onClick={() => setConditions(conditions.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        disabled={inputs.length === 0}
        title={inputs.length === 0 ? 'Declare an input of the machine first.' : undefined}
        onClick={() => {
          const input = inputs[0] as Input;
          setConditions([
            ...conditions,
            input.type === 'number'
              ? { input: input.name, op: '>', value: 0 }
              : { input: input.name },
          ]);
        }}
      >
        Add condition
      </button>
    </fieldset>
  );
}

/** The open machine: its name, layer and first state, inputs, states and transitions, and its graph. */
function MachineEditor(props: {
  machines: readonly MachineDocument[];
  index: number;
  active: string | null;
}) {
  const { machines, index, active } = props;
  const machine = machines[index] as MachineDocument;
  const { document } = state.value;
  const set = (next: MachineDocument) =>
    setMachines(() => machines.map((each, i) => (i === index ? next : each)));
  const states = listOf<State>(machine.states);
  const inputs = listOf<Input>(machine.inputs);
  const transitions = listOf<Transition>(machine.transitions);
  const names = states.filter(isObject).map((each) => String(each.name));
  const layers = listOf<{ name?: unknown }>(document.layers)
    .filter(isObject)
    .map((layer) => String(layer.name));
  const motions = Object.keys(isObject(document.motions) ? document.motions : {});
  const selected = openTransition.value;
  /** The machine with a state renamed, and every transition and the first state following it. */
  const renamed = (from: string, to: string): MachineDocument => ({
    ...machine,
    ...(machine.initial === from ? { initial: to } : {}),
    states: states.map((each) =>
      isObject(each) && each.name === from ? { ...each, name: to } : each,
    ),
    ...(machine.transitions
      ? {
          transitions: transitions.map((each) =>
            isObject(each)
              ? {
                  ...each,
                  ...(each.from === from ? { from: to } : {}),
                  ...(each.to === from ? { to } : {}),
                }
              : each,
          ),
        }
      : {}),
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
          value={typeof machine.initial === 'string' ? machine.initial : ''}
          options={[['', 'the first one'], ...names.map((each) => [each, each] as const)]}
          onValue={(initial) =>
            set(withKey(machine, 'initial', initial === '' ? undefined : initial))
          }
        />
        <button
          type="button"
          onClick={() => {
            openMachine.value = 0;
            openTransition.value = null;
            setMachines(() => machines.filter((_, i) => i !== index));
          }}
        >
          Remove machine
        </button>
      </div>
      <Graph machine={machine} active={active} selected={selected} />
      <fieldset class="group" aria-label="Inputs">
        <legend>Inputs</legend>
        {inputs.map((input, i) =>
          isObject(input) ? (
            <div key={i} class="field-row">
              <span>{input.name}</span>
              <select
                aria-label={`${input.name} type`}
                value={input.type}
                onChange={(event) => {
                  const type = (event.currentTarget as HTMLSelectElement).value as InputType;
                  set({
                    ...machine,
                    inputs: inputs.map((each, j) =>
                      j === i ? ({ name: input.name, type } as Input) : each,
                    ),
                  });
                }}
              >
                {INPUT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={`Remove input ${input.name}`}
                onClick={() => {
                  const rest = inputs.filter((_, j) => j !== i);
                  set(withKey(machine, 'inputs', rest.length === 0 ? undefined : rest));
                }}
              >
                ×
              </button>
            </div>
          ) : (
            <p key={i} class="empty">{`Input ${i + 1} is not an input (see the issues).`}</p>
          ),
        )}
        <NewName
          label="Add input"
          add={(name) => {
            if (inputs.some((input) => isObject(input) && input.name === name)) {
              problem.value = `There is an input "${name}" already.`;
              return;
            }
            set({ ...machine, inputs: [...inputs, { name, type: 'bool' }] });
          }}
        />
      </fieldset>
      <fieldset class="group" aria-label="States">
        <legend>States</legend>
        {states.map((each, i) =>
          isObject(each) ? (
            <div key={i} class="field-row">
              <input
                type="text"
                aria-label={`State ${i + 1} name`}
                value={String(each.name)}
                onChange={(event) => {
                  const input = event.currentTarget as HTMLInputElement;
                  const name = input.value.trim();
                  if (name === '' || name === '*' || names.includes(name)) {
                    problem.value = `A state needs a name of its own, not "${name}".`;
                    input.value = String(each.name);
                    return;
                  }
                  set(renamed(String(each.name), name));
                }}
              />
              <Choice
                label={`${each.name} plays`}
                value={typeof each.motion === 'string' ? each.motion : each.motion ? 'inline' : ''}
                options={[['', 'nothing'], ...motions.map((motion) => [motion, motion] as const)]}
                onValue={(motion) =>
                  set({
                    ...machine,
                    states: states.map((other, j) =>
                      j === i ? withKey(each, 'motion', motion === '' ? undefined : motion) : other,
                    ),
                  })
                }
              />
              <button
                type="button"
                aria-label={`Remove state ${each.name}`}
                onClick={() => {
                  // Its transitions go with it.
                  openTransition.value = null;
                  const rest = transitions.filter(
                    (transition) =>
                      !isObject(transition) ||
                      (transition.from !== each.name && transition.to !== each.name),
                  );
                  set({
                    ...withKey(machine, 'transitions', rest.length === 0 ? undefined : rest),
                    states: states.filter((_, j) => j !== i),
                  });
                }}
              >
                ×
              </button>
            </div>
          ) : (
            <p key={i} class="empty">{`State ${i + 1} is not a state (see the issues).`}</p>
          ),
        )}
        <NewName
          label="Add state"
          add={(name) => {
            if (name === '*' || names.includes(name)) {
              problem.value = `A state needs a name of its own, not "${name}".`;
              return;
            }
            set({ ...machine, states: [...states, { name }] });
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
              onClick={() => {
                openTransition.value = i;
              }}
            >
              {isObject(transition)
                ? `${transition.from} → ${transition.to}`
                : `${i + 1}: not a transition`}
            </button>
          ))}
          <button
            type="button"
            disabled={names.length === 0}
            onClick={() => {
              const [first, second] = names;
              openTransition.value = transitions.length;
              set({
                ...machine,
                transitions: [
                  ...transitions,
                  { from: first as string, to: (second ?? first) as string },
                ],
              });
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
                transitions: transitions.map((each, j) => (j === selected ? next : each)),
              })
            }
            remove={() => {
              openTransition.value = null;
              const rest = transitions.filter((_, j) => j !== selected);
              set(withKey(machine, 'transitions', rest.length === 0 ? undefined : rest));
            }}
          />
        ) : null}
      </fieldset>
    </div>
  );
}

/**
 * The preview: the document's animator stepped every frame (its layers, machines and springs),
 * its machines' inputs driven here, and each machine's state.
 */
function Preview(props: { machines: readonly MachineDocument[] }) {
  const { scene, stale, preview } = state.value;
  const on = previewing.value;
  // Each frame steps the animator of the scene shown (a new one after an edit starts over).
  useEffect(() => {
    if (!on) return;
    let last = performance.now();
    let id = requestAnimationFrame(function step(now) {
      if (!previewing.peek()) return;
      const shown = state.peek();
      if (!shown.scene || shown.stale) {
        previewing.value = false;
        problem.value = 'The document has issues: fix them to play it.';
        return;
      }
      try {
        shown.scene.animator.update(Math.min((now - last) / 1000, 0.1));
      } catch (error) {
        console.error(error);
        previewing.value = false;
        problem.value = `Could not play it: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      last = now;
      frame.value += 1;
      id = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(id);
  }, [on]);
  // Drawn again on each step: the states and inputs shown follow the animator.
  frame.value;
  const animator = scene && !stale ? scene.animator : null;
  const inputs = animator?.inputs;
  const names = [
    ...new Set(
      props.machines.flatMap((machine) =>
        listOf<Input>(machine.inputs)
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
          disabled={!animator}
          onClick={() => {
            if (on) {
              previewing.value = false;
              // Back at rest: the scene is built again.
              attempt('Could not stop it', () => editor.value.setPreview(state.peek().preview));
              return;
            }
            // The machines play the document as it is: a clip open solo closes.
            const { solo: _, ...rest } = preview;
            if (preview.solo) attempt('Could not play it', () => editor.value.setPreview(rest));
            previewing.value = true;
          }}
        >
          {on ? '■ Stop' : '▶ Play'}
        </button>
        {animator
          ? animator.stateMachines.map((machine) => (
              <span
                key={machine.name}
                class="machine-active"
              >{`${machine.name}: ${machine.state}`}</span>
            ))
          : null}
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
                      onChange={(event) =>
                        inputs.set(name, (event.currentTarget as HTMLInputElement).checked)
                      }
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
                    onValue={(next) => next !== undefined && inputs.set(name, next)}
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
  const { document, scene, stale } = state.value;
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
  const index = Math.min(openMachine.value, machines.length - 1);
  const open = index >= 0 ? machines[index] : undefined;
  const animator = scene && !stale ? scene.animator : null;
  // Read on each preview step, so the graph lights the state the machine is in.
  frame.value;
  const active =
    open && animator && previewing.value
      ? (animator.stateMachines.find((each) => each.name === open.name)?.state ?? null)
      : null;
  return (
    <div class="machines">
      <div class="field-row">
        <select
          aria-label="Machine"
          value={String(index)}
          onChange={(event) => {
            openMachine.value = Number((event.currentTarget as HTMLSelectElement).value);
            openTransition.value = null;
          }}
        >
          {machines.length === 0 ? <option value="-1">no machine</option> : null}
          {machines.map((machine, i) => (
            <option key={i} value={String(i)}>
              {typeof machine.name === 'string' ? machine.name : `machine ${i + 1}`}
            </option>
          ))}
        </select>
        <NewName
          label="New machine"
          add={(name) => {
            if (machines.some((machine) => machine.name === name)) {
              problem.value = `There is a machine "${name}" already.`;
              return;
            }
            // It drives the first layer no machine drives yet.
            const used = new Set(machines.map((machine) => machine.layer));
            const layers = listOf<{ name?: unknown }>(document.layers)
              .filter(isObject)
              .map((layer) => String(layer.name));
            const layer = layers.find((each) => !used.has(each)) ?? '';
            openMachine.value = machines.length;
            openTransition.value = null;
            setMachines(() => [...machines, { name, layer, states: [{ name: 'idle' }] }]);
          }}
        />
      </div>
      {open && isObject(open) ? (
        <MachineEditor key={index} machines={machines} index={index} active={active} />
      ) : (
        <p class="empty">No machine: make one to drive a layer by its inputs.</p>
      )}
      <Preview machines={machines} />
    </div>
  );
}
