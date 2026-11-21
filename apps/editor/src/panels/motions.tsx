import {
  BEHAVIOR_KINDS,
  type Behavior,
  type BehaviorSet,
  type Property,
  propertiesOf,
  type Target,
} from '@mascotte/engine';
import type {
  BlendDocument,
  LibraryMotionRef,
  MascotDocument,
  MotionDocument,
} from '@mascotte/format';
import { MOTIONS } from '@mascotte/library';
import { setDocumentField } from '../model/commands.ts';
import { expandedIds } from '../model/ids.ts';
import { attempt, editor, state } from '../store.ts';
import { numberOf } from './document-panel.tsx';
import { ValueField } from './inspector.tsx';

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stores `motion` as the motion `name`, as a step. */
function save(name: string, motion: MotionDocument): void {
  attempt(`Could not change the motion ${name}`, () => {
    const current = editor.value;
    current.execute(setDocumentField(['motions', name], motion));
    current.commit();
  });
}

/** The kind of a stored motion the forms edit, or `null` for a clip or something else. */
export function formKind(motion: unknown): 'behaviors' | 'blend' | 'library' | null {
  if (!isObject(motion)) return null;
  if ('behaviors' in motion) return 'behaviors';
  if ('blend' in motion) return 'blend';
  if ('library' in motion) return 'library';
  return null;
}

/** A new motion of `kind`, to be filled in its form. */
export function newMotion(
  kind: 'behaviors' | 'blend' | 'library',
  document: MascotDocument,
): MotionDocument {
  switch (kind) {
    case 'behaviors':
      return { behaviors: [] };
    case 'blend':
      return { input: numberInputs(document)[0] ?? '', blend: [] };
    case 'library':
      return { library: [...MOTIONS.keys()][0] as string };
  }
}

/** The number inputs the document's machines declare: what a blend can be placed by. */
function numberInputs(document: MascotDocument): string[] {
  const machines: readonly unknown[] = Array.isArray(document.machines) ? document.machines : [];
  return [
    ...new Set(
      machines.flatMap((machine) =>
        isObject(machine) && Array.isArray(machine.inputs)
          ? machine.inputs.flatMap((input: unknown) =>
              isObject(input) && input.type === 'number' && typeof input.name === 'string'
                ? [input.name]
                : [],
            )
          : [],
      ),
    ),
  ];
}

/** A number field of a form: a stored number, or nothing for `optional` fields when emptied. */
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

/** A library motion: which one, what it does and the kind of layer it is written for. */
function LibraryForm(props: { name: string; motion: LibraryMotionRef }) {
  const { name, motion } = props;
  const names = [...MOTIONS.keys()];
  const entry = MOTIONS.get(motion.library);
  return (
    <fieldset class="motion-form" aria-label={`Motion ${name}`}>
      <legend>{`${name}: library motion`}</legend>
      <label>
        Library motion
        <select
          value={motion.library}
          onChange={(event) =>
            save(name, { library: (event.currentTarget as HTMLSelectElement).value })
          }
        >
          {/* One the library does not have stays listed (the format reports it). */}
          {entry ? null : <option value={motion.library}>{motion.library}</option>}
          {names.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      </label>
      {entry ? <p class="empty">{`${entry.description} For ${entry.layer} layers.`}</p> : null}
    </fieldset>
  );
}

/** What a behavior's target reaches: the node built for it, if the scene shown has one. */
function nodeFor(target: Target, document: MascotDocument) {
  const slots: Readonly<Record<string, unknown>> = isObject(document.rig?.slots)
    ? document.rig.slots
    : {};
  const id = typeof target === 'string' ? target : slots[target.slot];
  return typeof id === 'string' ? (state.value.scene?.built.root.findById(id) ?? null) : null;
}

/** The fields each kind of behavior has besides its target, property and ends, with defaults. */
const KIND_FIELDS = {
  oscillate: { period: 1 },
  blink: { duration: 0.15, minInterval: 2, maxInterval: 5 },
  noise: { frequency: 1 },
} as const;
const OPTIONAL_FIELDS = { oscillate: ['phase'], blink: ['seed'], noise: ['seed'] } as const;

/** One behavior: its kind, target, property, ends and the numbers its kind takes. */
function BehaviorFields(props: {
  index: number;
  behavior: Behavior;
  document: MascotDocument;
  set(next: Behavior): void;
  remove(): void;
}) {
  const { index, behavior, document, set } = props;
  const label = `Behavior ${index + 1}`;
  const slots = Object.keys(isObject(document.rig?.slots) ? document.rig.slots : {});
  const ids = [...expandedIds(document)].sort();
  const targetValue =
    typeof behavior.target === 'string' ? `id:${behavior.target}` : `slot:${behavior.target?.slot}`;
  const node = nodeFor(behavior.target, document);
  const properties: readonly Property[] = node
    ? propertiesOf(node).filter((property) => property.animatable)
    : [];
  const property = properties.find((each) => each.name === behavior.property);
  // A property's ends start at the value the node has now.
  const ends = (next: Property) => {
    const value =
      next.type === 'vec3'
        ? { ...next.get(node as never, { x: 0, y: 0, z: 0 }) }
        : next.type === 'quat'
          ? { ...next.get(node as never, { x: 0, y: 0, z: 0, w: 1 }) }
          : next.get(node as never);
    return { from: value, to: value };
  };
  const kind = behavior.kind;
  const fields = (KIND_FIELDS as Record<string, Record<string, number>>)[kind] ?? {};
  const optional: readonly string[] =
    (OPTIONAL_FIELDS as Record<string, readonly string[]>)[kind] ?? [];
  return (
    <fieldset class="group" aria-label={label}>
      <div class="field-row">
        <select
          aria-label={`${label} kind`}
          value={kind}
          onChange={(event) => {
            const next = (event.currentTarget as HTMLSelectElement).value as Behavior['kind'];
            const { target, property: name, from, to } = behavior;
            set({ kind: next, target, property: name, from, to, ...KIND_FIELDS[next] } as Behavior);
          }}
        >
          {BEHAVIOR_KINDS.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
        <select
          aria-label={`${label} target`}
          value={targetValue}
          onChange={(event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            const target: Target = value.startsWith('slot:')
              ? { slot: value.slice(5) }
              : value.slice(3);
            set({ ...behavior, target });
          }}
        >
          {slots.includes(String((behavior.target as { slot?: string })?.slot)) ||
          ids.includes(behavior.target as string) ? null : (
            <option value={targetValue}>{targetValue.replace(':', ' ')}</option>
          )}
          {slots.map((slot) => (
            <option key={`slot:${slot}`} value={`slot:${slot}`}>{`slot ${slot}`}</option>
          ))}
          {ids.map((id) => (
            <option key={`id:${id}`} value={`id:${id}`}>
              {id}
            </option>
          ))}
        </select>
        <select
          aria-label={`${label} property`}
          value={behavior.property}
          onChange={(event) => {
            const name = (event.currentTarget as HTMLSelectElement).value;
            const next = properties.find((each) => each.name === name);
            if (next) set({ ...behavior, property: name, ...ends(next) });
          }}
        >
          {property ? null : <option value={behavior.property}>{behavior.property}</option>}
          {properties.map((each) => (
            <option key={each.name} value={each.name}>
              {each.name}
            </option>
          ))}
        </select>
        <button type="button" aria-label={`Remove ${label}`} onClick={props.remove}>
          ×
        </button>
      </div>
      {property ? (
        <>
          <div class="field-row">
            <span>from</span>
            <ValueField
              label={`${label} from`}
              property={property}
              value={behavior.from}
              onValue={(from) => set({ ...behavior, from })}
            />
          </div>
          <div class="field-row">
            <span>to</span>
            <ValueField
              label={`${label} to`}
              property={property}
              value={behavior.to}
              onValue={(to) => set({ ...behavior, to })}
            />
          </div>
        </>
      ) : (
        <p class="empty">Its target is not shown (see the issues): its ends cannot be edited.</p>
      )}
      <div class="field-row">
        {[...Object.keys(fields), ...optional].map((field) => (
          <NumberField
            key={field}
            label={field}
            value={(behavior as unknown as Record<string, unknown>)[field]}
            placeholder={optional.includes(field) ? '0' : String(fields[field])}
            optional={optional.includes(field)}
            onValue={(next) => {
              const { [field]: _, ...rest } = behavior as unknown as Record<string, unknown>;
              set((next === undefined ? rest : { ...rest, [field]: next }) as unknown as Behavior);
            }}
          />
        ))}
      </div>
    </fieldset>
  );
}

/** A behavior set: its behaviors, each edited in place, added and removed. */
function BehaviorsForm(props: { name: string; motion: BehaviorSet; document: MascotDocument }) {
  const { name, motion, document } = props;
  const behaviors: readonly Behavior[] = Array.isArray(motion.behaviors) ? motion.behaviors : [];
  const set = (next: readonly Behavior[]) => save(name, { ...motion, behaviors: next });
  const slots = Object.keys(isObject(document.rig?.slots) ? document.rig.slots : {});
  const rootId = document.root.id;
  return (
    <fieldset class="motion-form" aria-label={`Motion ${name}`}>
      <legend>{`${name}: behaviors`}</legend>
      {behaviors.map((behavior, i) =>
        isObject(behavior) ? (
          <BehaviorFields
            key={i}
            index={i}
            behavior={behavior}
            document={document}
            set={(next) => set(behaviors.map((each, j) => (j === i ? next : each)))}
            remove={() => set(behaviors.filter((_, j) => j !== i))}
          />
        ) : (
          <p key={i} class="empty">{`Behavior ${i + 1} is not a behavior (see the issues).`}</p>
        ),
      )}
      <button
        type="button"
        onClick={() => {
          // A new behavior breathes the first slot (or the root): every node has an opacity.
          const target: Target = slots[0] !== undefined ? { slot: slots[0] } : (rootId ?? 'root');
          set([
            ...behaviors,
            { kind: 'oscillate', target, property: 'opacity', from: 1, to: 1, period: 1 },
          ]);
        }}
      >
        Add behavior
      </button>
    </fieldset>
  );
}

/** A blend: the number input that places it, and its points (a motion at a value of the input). */
function BlendForm(props: { name: string; motion: BlendDocument; document: MascotDocument }) {
  const { name, motion, document } = props;
  const points = Array.isArray(motion.blend) ? motion.blend : [];
  // Points stay in increasing order of `at`, as the engine takes them.
  const set = (next: BlendDocument['blend']) =>
    save(name, { ...motion, blend: [...next].sort((a, b) => a.at - b.at) });
  const inputs = numberInputs(document);
  const motions = Object.entries(isObject(document.motions) ? document.motions : {})
    .filter(([other, each]) => other !== name && formKind(each) !== 'blend')
    .map(([other]) => other);
  return (
    <fieldset class="motion-form" aria-label={`Motion ${name}`}>
      <legend>{`${name}: blend`}</legend>
      <label>
        Input
        <input
          type="text"
          list={`inputs-${name}`}
          value={typeof motion.input === 'string' ? motion.input : ''}
          onChange={(event) =>
            save(name, { ...motion, input: (event.currentTarget as HTMLInputElement).value.trim() })
          }
        />
        <datalist id={`inputs-${name}`}>
          {inputs.map((input) => (
            <option key={input} value={input} />
          ))}
        </datalist>
      </label>
      {points.map((point, i) => {
        const label = `Point ${i + 1}`;
        const named = typeof point?.motion === 'string' ? point.motion : '';
        return (
          <fieldset key={i} class="field-row" aria-label={label}>
            <NumberField
              label={`${label} at`}
              value={point?.at}
              onValue={(at) =>
                set(points.map((each, j) => (j === i ? { ...each, at: at as number } : each)))
              }
            />
            <label>
              {`${label} motion`}
              <select
                value={named}
                onChange={(event) => {
                  const value = (event.currentTarget as HTMLSelectElement).value;
                  set(points.map((each, j) => (j === i ? { ...each, motion: value } : each)));
                }}
              >
                {named === '' ? <option value="">its own motion</option> : null}
                {named !== '' && !motions.includes(named) ? (
                  <option value={named}>{named}</option>
                ) : null}
                {motions.map((each) => (
                  <option key={each} value={each}>
                    {each}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-label={`Remove ${label}`}
              onClick={() => set(points.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        disabled={motions.length === 0}
        onClick={() => {
          const last = points.at(-1)?.at;
          set([
            ...points,
            { at: typeof last === 'number' ? last + 1 : 0, motion: motions[0] as string },
          ]);
        }}
      >
        Add point
      </button>
    </fieldset>
  );
}

/**
 * The form of a motion that is not a clip (docs/EDITOR.md, Timeline): a behavior set, a blend or
 * a library motion. Its layer's kind shows in the layers' issues.
 */
export function MotionForm(props: { name: string }) {
  const { document } = state.value;
  const motions: Readonly<Record<string, unknown>> = isObject(document.motions)
    ? document.motions
    : {};
  const motion = Object.hasOwn(motions, props.name) ? motions[props.name] : undefined;
  switch (formKind(motion)) {
    case 'library':
      return <LibraryForm name={props.name} motion={motion as LibraryMotionRef} />;
    case 'behaviors':
      return <BehaviorsForm name={props.name} motion={motion as BehaviorSet} document={document} />;
    case 'blend':
      return <BlendForm name={props.name} motion={motion as BlendDocument} document={document} />;
    default:
      return null;
  }
}
