import type { MascotDocument, ShapeParam } from '@mascotte/format';
import { ARCHETYPES, PREFABS } from '@mascotte/library';
import { useState } from 'preact/hooks';
import { expandedIds } from '../model/ids.ts';
import { attempt, editor, editPrefab, problem, state } from '../store.ts';
import { ColorField, numberOf, set } from './document-panel.tsx';

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The entries of a record the document keeps, or none when it is no object (the format says so). */
function entriesOf(value: unknown): [string, unknown][] {
  return isObject(value) ? Object.entries(value) : [];
}

/**
 * A name and a button that adds something by it: `add` runs unless the name is empty, or `taken`
 * says why it cannot be used.
 */
function AddRow(props: {
  label: string;
  taken: (name: string) => string | null;
  add: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const submit = () => {
    const wanted = name.trim();
    if (wanted === '') return;
    const why = props.taken(wanted);
    if (why !== null) {
      problem.value = why;
      return;
    }
    props.add(wanted);
    setName('');
  };
  return (
    <div class="field-row">
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
    </div>
  );
}

/** The roles of the document's palettes, the base palette's first. */
function rolesOf(document: MascotDocument): string[] {
  return [
    ...new Set(
      entriesOf(document.palettes).flatMap(([, colors]) =>
        Object.keys(isObject(colors) ? colors : {}),
      ),
    ),
  ];
}

/**
 * The palettes (docs/EDITOR.md, Panels): each palette's color for each role, the first palette
 * the base, which names every role; the others may name only some, the rest coming from the base.
 */
export function PalettesFields() {
  const { document } = state.value;
  const palettes = entriesOf(document.palettes);
  const roles = rolesOf(document);
  const base = palettes[0]?.[0];
  return (
    <fieldset>
      <legend>Palettes</legend>
      {palettes.map(([name, colors], i) => (
        <fieldset key={name} class="group" aria-label={`Palette ${name}`}>
          <div class="prop-head">
            <span class="prop-name">{i === 0 ? `${name} (base)` : name}</span>
            <button
              type="button"
              aria-label={`Remove palette ${name}`}
              onClick={() => set(['palettes', name], undefined)}
            >
              Remove
            </button>
          </div>
          {roles.map((role) => (
            <ColorField
              key={role}
              label={role}
              field={['palettes', name, role]}
              value={isObject(colors) ? colors[role] : undefined}
            />
          ))}
        </fieldset>
      ))}
      <AddRow
        label="Add palette"
        taken={(name) =>
          Object.hasOwn(isObject(document.palettes) ? document.palettes : {}, name)
            ? `There is a palette "${name}" already.`
            : null
        }
        add={(name) => set(['palettes', name], {})}
      />
      {base === undefined ? null : (
        <AddRow
          label="Add role"
          taken={(role) => (roles.includes(role) ? `There is a role "${role}" already.` : null)}
          // A new role starts grey in the base, which names every role.
          add={(role) => set(['palettes', base, role], '#888888')}
        />
      )}
    </fieldset>
  );
}

/** A number of a parameter's spec: its default (required), its least or greatest value. */
function SpecNumber(props: { name: string; spec: ShapeParam; field: 'default' | 'min' | 'max' }) {
  const { name, spec, field } = props;
  const value = spec[field];
  return (
    <label>
      {field}
      <input
        type="number"
        step="any"
        aria-label={`${name} ${field}`}
        value={typeof value === 'number' ? value : ''}
        onChange={(event) => {
          const input = event.currentTarget as HTMLInputElement;
          const next = numberOf(input);
          if (next === null || (next === undefined && field === 'default')) {
            input.value = typeof value === 'number' ? String(value) : '';
            return;
          }
          const { [field]: _, ...rest } = spec;
          set(
            ['params', name],
            (next === undefined ? rest : { ...rest, [field]: next }) as ShapeParam,
          );
        }}
      />
    </label>
  );
}

/** A parameter's spec from what the document stores: its fields of the right kinds, or none without a default. */
function specOf(value: unknown): ShapeParam | undefined {
  if (!isObject(value) || typeof value.default !== 'number') return undefined;
  const { min, max, description } = value;
  return {
    default: value.default,
    ...(typeof min === 'number' ? { min } : {}),
    ...(typeof max === 'number' ? { max } : {}),
    ...(typeof description === 'string' ? { description } : {}),
  };
}

/**
 * The shape parameters (docs/EDITOR.md, Panels): each one's default, range and description, and a
 * slider that shows the viewport another value without changing the document.
 */
export function ParamsFields() {
  const { document, preview } = state.value;
  const params = entriesOf(document.params);
  const setPreview = (name: string, value: number | undefined) => {
    const { [name]: _, ...rest } = preview.params ?? {};
    const next = value === undefined ? rest : { ...rest, [name]: value };
    attempt('Could not preview it', () => editor.value.setPreview({ ...preview, params: next }));
  };
  return (
    <fieldset>
      <legend>Parameters</legend>
      {params.map(([name, value]) => {
        const spec = specOf(value);
        // One that is no spec can only go; the format says what is wrong with it.
        if (!spec) {
          return (
            <div key={name} class="prop-head">
              <span class="prop-name">{`${name} is not a parameter`}</span>
              <button
                type="button"
                aria-label={`Remove parameter ${name}`}
                onClick={() => set(['params', name], undefined)}
              >
                Remove
              </button>
            </div>
          );
        }
        const shown = Object.hasOwn(preview.params ?? {}, name)
          ? preview.params?.[name]
          : undefined;
        const low = spec.min ?? Math.min(0, spec.default);
        const high = spec.max ?? Math.max(spec.default * 2, low + 1);
        return (
          <fieldset key={name} class="group" aria-label={`Parameter ${name}`}>
            <div class="prop-head">
              <span class="prop-name">{name}</span>
              <button
                type="button"
                aria-label={`Remove parameter ${name}`}
                onClick={() => set(['params', name], undefined)}
              >
                Remove
              </button>
            </div>
            <div class="field-row">
              <SpecNumber name={name} spec={spec} field="default" />
              <SpecNumber name={name} spec={spec} field="min" />
              <SpecNumber name={name} spec={spec} field="max" />
            </div>
            <label>
              Description
              <input
                type="text"
                value={spec.description ?? ''}
                onChange={(event) => {
                  const text = (event.currentTarget as HTMLInputElement).value.trim();
                  const { description: _, ...rest } = spec;
                  set(['params', name], text === '' ? rest : { ...rest, description: text });
                }}
              />
            </label>
            <div class="field-row">
              <input
                type="range"
                aria-label={`${name} preview`}
                min={low}
                max={high}
                step="any"
                value={shown ?? spec.default}
                onInput={(event) =>
                  setPreview(name, (event.currentTarget as HTMLInputElement).valueAsNumber)
                }
              />
              <span>{shown === undefined ? 'default' : String(Math.round(shown * 100) / 100)}</span>
              <button
                type="button"
                aria-label={`Reset ${name} preview`}
                disabled={shown === undefined}
                onClick={() => setPreview(name, undefined)}
              >
                ↺
              </button>
            </div>
          </fieldset>
        );
      })}
      <AddRow
        label="Add parameter"
        taken={(name) =>
          Object.hasOwn(isObject(document.params) ? document.params : {}, name)
            ? `There is a parameter "${name}" already.`
            : null
        }
        add={(name) => set(['params', name], { default: 1 })}
      />
    </fieldset>
  );
}

/**
 * The prefabs (docs/EDITOR.md, Panels): the document's own and the library's, each edited in its
 * own mode (a library prefab edited becomes the document's own, which takes the library's place
 * in the document).
 */
export function PrefabsFields() {
  const { document } = state.value;
  const own = entriesOf(document.prefabs).map(([name]) => name);
  const library = [...PREFABS.keys()].filter((name) => !own.includes(name));
  const edit = (name: string) =>
    attempt(`Could not edit the prefab ${name}`, () => editPrefab(name));
  return (
    <fieldset>
      <legend>Prefabs</legend>
      {[...own, ...library].map((name) => (
        <div key={name} class="prop-head">
          <span class="prop-name">{own.includes(name) ? name : `${name} (library)`}</span>
          <button type="button" aria-label={`Edit prefab ${name}`} onClick={() => edit(name)}>
            Edit
          </button>
          {own.includes(name) ? (
            <button
              type="button"
              aria-label={`Remove prefab ${name}`}
              onClick={() => set(['prefabs', name], undefined)}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <AddRow
        label="Add prefab"
        taken={(name) =>
          own.includes(name) || PREFABS.has(name) ? `There is a prefab "${name}" already.` : null
        }
        add={(name) => set(['prefabs', name], { root: { type: 'Node' } })}
      />
    </fieldset>
  );
}

/**
 * The rig (docs/EDITOR.md, Panels): the archetype's slots (required ones marked) and any other the
 * document binds, each to a node of the expanded tree, and what the format says is wrong with it.
 */
export function RigFields() {
  const { document, issues } = state.value;
  const slots = Object.fromEntries(entriesOf(document.rig?.slots));
  const archetype =
    typeof document.archetype === 'string' ? ARCHETYPES.get(document.archetype) : undefined;
  const required = archetype?.slots ?? [];
  const names = [...new Set([...required, ...(archetype?.optional ?? []), ...Object.keys(slots)])];
  const ids = [...expandedIds(document)].sort();
  const own = issues.filter((issue) => /^rig(\.|$)/.test(issue.path));
  return (
    <fieldset>
      <legend>Rig</legend>
      {own.length > 0 ? (
        <ul class="document-issues" role="alert">
          {own.map((issue) => (
            <li key={`${issue.path} ${issue.message}`}>
              <code>{issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {names.map((slot) => {
        const bound = slots[slot];
        const options = typeof bound === 'string' && !ids.includes(bound) ? [bound, ...ids] : ids;
        return (
          <label key={slot}>
            {required.includes(slot) ? `${slot} (required)` : slot}
            <select
              aria-label={`Slot ${slot}`}
              value={typeof bound === 'string' ? bound : ''}
              onChange={(event) => {
                const id = (event.currentTarget as HTMLSelectElement).value;
                set(['rig', 'slots', slot], id === '' ? undefined : id);
              }}
            >
              <option value="">unbound</option>
              {options.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      <AddRow
        label="Add slot"
        taken={(slot) => (names.includes(slot) ? `There is a slot "${slot}" already.` : null)}
        // Bound at once, to the root: an unbound slot that no archetype names is not kept.
        add={(slot) => {
          const root = document.root.id;
          if (root === undefined) problem.value = 'Give the root an id to bind a slot to it.';
          else set(['rig', 'slots', slot], root);
        }}
      />
    </fieldset>
  );
}
