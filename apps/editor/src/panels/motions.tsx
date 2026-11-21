import {
  BEHAVIOR_KINDS,
  type Behavior,
  type BehaviorKind,
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
  NodeDocument,
} from '@mascotte/format';
import { MOTIONS, slotsOf, usesSize } from '@mascotte/library';
import { setDocumentField } from '../model/commands.ts';
import { expandedIds } from '../model/ids.ts';
import { attempt, editor, problem, state } from '../store.ts';
import { numberOf } from './document-panel.tsx';
import { ValueField } from './inspector.tsx';

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stores the motion `make` gives as the motion `name`, as a step; what goes wrong is said. */
function save(name: string, make: () => MotionDocument): void {
  attempt(`Could not change the motion ${name}`, () => {
    const current = editor.value;
    current.execute(setDocumentField(['motions', name], make()));
    current.commit();
  });
}

/** The kinds of motion the forms edit. */
export type FormKind = 'behaviors' | 'blend' | 'library';

/**
 * The kind of a stored motion the forms edit, as the format tells them apart (a library motion,
 * then a blend, then behaviors); `null` for a clip (it has tracks) or something else.
 */
export function formKind(motion: unknown): FormKind | null {
  if (!isObject(motion) || 'tracks' in motion) return null;
  if (motion.library !== undefined) return 'library';
  if (Array.isArray(motion.blend)) return 'blend';
  if ('behaviors' in motion) return 'behaviors';
  return null;
}

/** The rig's slots that bind a node (by name). */
function boundSlots(document: MascotDocument): Set<string> {
  const slots: unknown = document.rig?.slots;
  return new Set(
    isObject(slots)
      ? Object.entries(slots)
          .filter(([, id]) => typeof id === 'string')
          .map(([slot]) => slot)
      : [],
  );
}

/** Why `document` cannot play the library motion `name` (slots its rig lacks, no archetype), or `null`. */
function unplayable(document: MascotDocument, name: string): string | null {
  const entry = MOTIONS.get(name);
  if (!entry) return null;
  const bound = boundSlots(document);
  const missing = slotsOf(entry.motion).filter((slot) => !bound.has(slot));
  if (missing.length > 0) return `needs the slots ${missing.join(', ')}`;
  if (usesSize(entry.motion) && typeof document.archetype !== 'string') {
    return 'needs an archetype';
  }
  return null;
}

/**
 * A new motion of `kind`, to be filled in its form. A library motion is the first one the document
 * can play; a blend starts with no points, an issue only once something plays it.
 */
export function newMotion(kind: FormKind, document: MascotDocument): MotionDocument {
  switch (kind) {
    case 'behaviors':
      return { behaviors: [] };
    case 'blend':
      return { input: numberInputs(document)[0] ?? '', blend: [] };
    case 'library': {
      const names = [...MOTIONS.keys()];
      const playable = names.find((name) => unplayable(document, name) === null);
      return { library: (playable ?? names[0]) as string };
    }
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

/**
 * A number field of a form: emptied, an `optional` one gives `undefined`; text that is not a
 * number, or an emptied field that is not optional, changes nothing and shows the stored value
 * again.
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

/**
 * A library motion: which one, what it does and the kind of layer it is written for. One the
 * document cannot play (a slot its rig lacks, no archetype) is marked.
 */
function LibraryForm(props: { name: string; motion: LibraryMotionRef; document: MascotDocument }) {
  const { name, motion, document } = props;
  const names = [...MOTIONS.keys()];
  const library = typeof motion.library === 'string' ? motion.library : String(motion.library);
  const entry = MOTIONS.get(library);
  return (
    <fieldset class="motion-form" aria-label={`Motion ${name}`}>
      <legend>{`${name}: library motion`}</legend>
      <label>
        Library motion
        <select
          value={library}
          onChange={(event) => {
            const next = (event.currentTarget as HTMLSelectElement).value;
            save(name, () => ({ library: next }));
          }}
        >
          {/* One the library does not have stays listed (the format reports it). */}
          {entry ? null : <option value={library}>{library}</option>}
          {names.map((each) => {
            const why = unplayable(document, each);
            return (
              <option key={each} value={each}>
                {why === null ? each : `${each} (${why})`}
              </option>
            );
          })}
        </select>
      </label>
      {entry ? <p class="empty">{`${entry.description} For ${entry.layer} layers.`}</p> : null}
    </fieldset>
  );
}

/** Whether `value` is a target: a node's id, or a rig slot. */
function isTarget(value: unknown): value is Target {
  return typeof value === 'string' || (isObject(value) && typeof value.slot === 'string');
}

/** The node id a target reaches through the rig's slots, if any. */
function idOf(target: Target, document: MascotDocument): string | undefined {
  if (typeof target === 'string') return target;
  const slots: unknown = document.rig?.slots;
  const id = isObject(slots) && Object.hasOwn(slots, target.slot) ? slots[target.slot] : undefined;
  return typeof id === 'string' ? id : undefined;
}

/**
 * The node built for `target` in the scene shown, if it is the document's (a stale scene is an
 * older document's: its nodes may be gone or other).
 */
function nodeFor(target: Target, document: MascotDocument) {
  const { scene, stale } = state.value;
  const id = idOf(target, document);
  return id === undefined || !scene || stale ? null : scene.built.root.findById(id);
}

/** The rest value of `property` on the node `id`: what its document node stores, or the default. */
function restValue(document: MascotDocument, id: string | undefined, property: Property): unknown {
  const find = (node: NodeDocument): NodeDocument | undefined =>
    node.id === id ? node : (node.children ?? []).map(find).find((each) => each !== undefined);
  const stored = id === undefined ? undefined : find(document.root)?.props?.[property.name];
  // A stored binding is the document's to resolve: the ends start at the plain default instead.
  const plain =
    stored === undefined || (isObject(stored) && ('param' in stored || 'color' in stored));
  return plain ? property.default : stored;
}

/** The numbers each kind of behavior takes besides its target, property and ends: their starting values. */
const KIND_FIELDS = {
  oscillate: { period: 1 },
  blink: { duration: 0.15, minInterval: 2, maxInterval: 5 },
  noise: { frequency: 1 },
} as const satisfies {
  readonly [K in BehaviorKind]: Partial<Record<keyof Extract<Behavior, { kind: K }>, number>>;
};
/** The numbers each kind may take, 0 when left out (as the engine has them). */
const OPTIONAL_FIELDS = {
  oscillate: ['phase'],
  blink: ['seed'],
  noise: ['seed'],
} as const satisfies {
  readonly [K in BehaviorKind]: readonly (keyof Extract<Behavior, { kind: K }>)[];
};

function isKind(kind: unknown): kind is BehaviorKind {
  return typeof kind === 'string' && Object.hasOwn(KIND_FIELDS, kind);
}

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
  const slots = [...boundSlots(document)];
  const ids = [...expandedIds(document)].sort();
  const target = behavior.target;
  const targetValue = typeof target === 'string' ? `id:${target}` : `slot:${target.slot}`;
  const listed = typeof target === 'string' ? ids.includes(target) : slots.includes(target.slot);
  const node = nodeFor(target, document);
  const properties: readonly Property[] = node
    ? propertiesOf(node).filter((property) => property.animatable)
    : [];
  const property = properties.find((each) => each.name === behavior.property);
  const kind = behavior.kind;
  const fields: Readonly<Record<string, number>> = isKind(kind) ? KIND_FIELDS[kind] : {};
  const optional: readonly string[] = isKind(kind) ? OPTIONAL_FIELDS[kind] : [];
  const numbers = behavior as unknown as Readonly<Record<string, unknown>>;
  return (
    <fieldset class="group" aria-label={label}>
      <div class="field-row">
        <select
          aria-label={`${label} kind`}
          value={kind}
          onChange={(event) => {
            const next = (event.currentTarget as HTMLSelectElement).value as BehaviorKind;
            const { target: at, property: name, from, to } = behavior;
            // The ends stay, and the optional numbers both kinds take (a blink's seed, a noise's).
            const kept = Object.fromEntries(
              OPTIONAL_FIELDS[next]
                .filter((field) => numbers[field] !== undefined)
                .map((field) => [field, numbers[field]]),
            );
            set({
              kind: next,
              target: at,
              property: name,
              from,
              to,
              ...KIND_FIELDS[next],
              ...kept,
            } as Behavior);
          }}
        >
          {/* A kind the engine does not have stays listed (the engine reports it). */}
          {isKind(kind) ? null : <option value={String(kind)}>{String(kind)}</option>}
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
            const next: Target = value.startsWith('slot:')
              ? { slot: value.slice(5) }
              : value.slice(3);
            set({ ...behavior, target: next });
          }}
        >
          {listed ? null : <option value={targetValue}>{targetValue.replace(':', ' ')}</option>}
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
            if (!next) return;
            // Its ends start at the node's rest value: the neutral end of most behaviors.
            const rest = restValue(document, idOf(target, document), next);
            set({ ...behavior, property: name, from: rest, to: rest });
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
        <p class="empty">
          {node
            ? `Pick a property its target animates: it has no ${behavior.property}.`
            : 'Its target is not shown (see the issues): its ends cannot be edited.'}
        </p>
      )}
      <div class="field-row">
        {[...Object.keys(fields), ...optional].map((field) => (
          <NumberField
            key={field}
            label={`${label} ${field}`}
            value={numbers[field]}
            placeholder={optional.includes(field) ? '0' : String(fields[field])}
            optional={optional.includes(field)}
            onValue={(next) => {
              const { [field]: _, ...rest } = numbers;
              set((next === undefined ? rest : { ...rest, [field]: next }) as unknown as Behavior);
            }}
          />
        ))}
      </div>
    </fieldset>
  );
}

/**
 * A behavior set: its behaviors, each edited in place, added and removed. One that is no behavior
 * (no target, no property) can only go.
 */
function BehaviorsForm(props: { name: string; motion: BehaviorSet; document: MascotDocument }) {
  const { name, motion, document } = props;
  const stored: unknown = motion.behaviors;
  if (!Array.isArray(stored)) {
    return (
      <fieldset class="motion-form" aria-label={`Motion ${name}`}>
        <legend>{`${name}: behaviors`}</legend>
        <p class="empty">Its behaviors are not a list (see the issues).</p>
      </fieldset>
    );
  }
  const behaviors: readonly Behavior[] = stored;
  const set = (next: readonly Behavior[]) => save(name, () => ({ ...motion, behaviors: next }));
  const remove = (i: number) => set(behaviors.filter((_, j) => j !== i));
  const slots = [...boundSlots(document)];
  const rootId = document.root.id;
  return (
    <fieldset class="motion-form" aria-label={`Motion ${name}`}>
      <legend>{`${name}: behaviors`}</legend>
      {behaviors.map((behavior, i) =>
        isObject(behavior) && isTarget(behavior.target) && typeof behavior.property === 'string' ? (
          <BehaviorFields
            key={i}
            index={i}
            behavior={behavior}
            document={document}
            set={(next) => set(behaviors.map((each, j) => (j === i ? next : each)))}
            remove={() => remove(i)}
          />
        ) : (
          <div key={i} class="field-row">
            <span class="empty">{`Behavior ${i + 1} is not a behavior (see the issues).`}</span>
            <button type="button" aria-label={`Remove Behavior ${i + 1}`} onClick={() => remove(i)}>
              ×
            </button>
          </div>
        ),
      )}
      <button
        type="button"
        onClick={() => {
          // A new behavior oscillates the first slot's (else the root's) opacity, from 1 to 1
          // until its ends are set: every node has an opacity.
          const target: Target | undefined = slots[0] !== undefined ? { slot: slots[0] } : rootId;
          if (target === undefined) {
            problem.value = 'Bind a slot or give the root an id to aim a behavior at.';
            return;
          }
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

/**
 * A blend: the number input that places it, and its points, each a motion at a value of the
 * input. The engine takes points in strictly increasing order of `at`: they are kept sorted, and
 * an `at` another point has is refused.
 */
function BlendForm(props: { name: string; motion: BlendDocument; document: MascotDocument }) {
  const { name, motion, document } = props;
  const points: readonly unknown[] = Array.isArray(motion.blend) ? motion.blend : [];
  const atOf = (point: unknown) =>
    isObject(point) && typeof point.at === 'number' ? point.at : Number.POSITIVE_INFINITY;
  const set = (next: readonly unknown[]) =>
    save(name, () => ({
      ...motion,
      blend: [...next].sort((a, b) => atOf(a) - atOf(b)) as BlendDocument['blend'],
    }));
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
          onChange={(event) => {
            const input = (event.currentTarget as HTMLInputElement).value.trim();
            save(name, () => ({ ...motion, input }));
          }}
        />
        <datalist id={`inputs-${name}`}>
          {inputs.map((input) => (
            <option key={input} value={input} />
          ))}
        </datalist>
      </label>
      {points.map((point, i) => {
        const label = `Point ${i + 1}`;
        const remove = (
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={() => set(points.filter((_, j) => j !== i))}
          >
            ×
          </button>
        );
        if (!isObject(point)) {
          return (
            <div key={i} class="field-row">
              <span class="empty">{`${label} is not a point (see the issues).`}</span>
              {remove}
            </div>
          );
        }
        const named = typeof point.motion === 'string' ? point.motion : null;
        return (
          <fieldset key={i} class="field-row" aria-label={label}>
            <NumberField
              label={`${label} at`}
              value={point.at}
              onValue={(at) => {
                if (points.some((other, j) => j !== i && atOf(other) === at)) {
                  problem.value = `Another point is at ${at}: a blend's points are at different values.`;
                  return;
                }
                set(points.map((each, j) => (j === i ? { ...point, at } : each)));
              }}
            />
            <label>
              {`${label} motion`}
              <select
                value={named ?? ''}
                onChange={(event) => {
                  const value = (event.currentTarget as HTMLSelectElement).value;
                  set(points.map((each, j) => (j === i ? { ...point, motion: value } : each)));
                }}
              >
                {named === null ? (
                  <option value="">{isObject(point.motion) ? 'its own motion' : 'none'}</option>
                ) : null}
                {/* A motion the document lacks stays listed (the format reports it). */}
                {named !== null && !motions.includes(named) ? (
                  <option value={named}>{named}</option>
                ) : null}
                {motions.map((each) => (
                  <option key={each} value={each}>
                    {each}
                  </option>
                ))}
              </select>
            </label>
            {remove}
          </fieldset>
        );
      })}
      <button
        type="button"
        disabled={motions.length === 0}
        onClick={() => {
          const ats = points.map(atOf).filter(Number.isFinite);
          const at = ats.length === 0 ? 0 : Math.max(...ats) + 1;
          set([...points, { at, motion: motions[0] as string }]);
        }}
      >
        Add point
      </button>
    </fieldset>
  );
}

/**
 * The form of a motion that is not a clip (docs/EDITOR.md, Timeline): a behavior set, a blend or
 * a library motion. A library motion on a layer of the other kind is that layer's issue (the
 * format's `layerKindProblem`).
 */
export function MotionForm(props: { name: string }) {
  const { document } = state.value;
  const motions: Readonly<Record<string, unknown>> = isObject(document.motions)
    ? document.motions
    : {};
  const motion = Object.hasOwn(motions, props.name) ? motions[props.name] : undefined;
  switch (formKind(motion)) {
    case 'library':
      return (
        <LibraryForm name={props.name} motion={motion as LibraryMotionRef} document={document} />
      );
    case 'behaviors':
      return <BehaviorsForm name={props.name} motion={motion as BehaviorSet} document={document} />;
    case 'blend':
      return <BlendForm name={props.name} motion={motion as BlendDocument} document={document} />;
    default:
      return null;
  }
}
