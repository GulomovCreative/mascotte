import { DEFAULT_LIGHT, PROJECTIONS } from '@mascotte/engine';
import type { PlainValue } from '@mascotte/format';
import { ARCHETYPES } from '@mascotte/library';
import type { Vec3 } from '@mascotte/math';
import { type DocumentField, setDocumentField } from '../model/commands.ts';
import { attempt, editor, state } from '../store.ts';

function set(field: DocumentField, value: PlainValue | undefined): void {
  attempt('Could not change the document', () =>
    editor.value.execute(setDocumentField(field, value)),
  );
}

/** The input's number, or `undefined` for an empty input; `null` for one that is not a number. */
export function numberOf(input: HTMLInputElement): number | undefined | null {
  // Text a number input cannot read ("1e", "-") reads as empty: it is not a number, not a removal.
  if (input.validity.badInput) return null;
  if (input.value.trim() === '') return undefined;
  return Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : null;
}

/**
 * A number field: an empty one removes the value (back to its default, shown greyed) where it
 * may; one that is not a number changes nothing and shows the stored value again.
 */
function NumberField(props: {
  label: string;
  field: DocumentField;
  value: unknown;
  fallback: number;
  min?: number;
  step?: number;
  required?: boolean;
}) {
  const value = typeof props.value === 'number' ? props.value : undefined;
  return (
    <label>
      {props.label}
      <input
        type="number"
        min={props.min}
        step={props.step ?? 'any'}
        value={value ?? ''}
        placeholder={String(props.fallback)}
        onChange={(event) => {
          const input = event.currentTarget as HTMLInputElement;
          const next = numberOf(input);
          if (next === null || (next === undefined && props.required)) {
            input.value = value === undefined ? '' : String(value);
            return;
          }
          set(props.field, next);
        }}
      />
    </label>
  );
}

/** A CSS color: its text, and a picker that shows it when it is `#rrggbb` (white otherwise). */
function ColorField(props: { label: string; field: DocumentField; value: unknown }) {
  const value = typeof props.value === 'string' ? props.value : '';
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
  const change = (next: string) => set(props.field, next.trim() === '' ? undefined : next.trim());
  return (
    <div class="field-row">
      <label>
        {props.label}
        <input
          type="text"
          value={value}
          placeholder="none"
          onChange={(event) => change((event.currentTarget as HTMLInputElement).value)}
        />
      </label>
      <input
        type="color"
        aria-label={`${props.label} picker`}
        value={hex}
        onChange={(event) => change((event.currentTarget as HTMLInputElement).value)}
      />
    </div>
  );
}

/**
 * The document panel (docs/EDITOR.md, 3.4): `meta`, the frame (`view`), the camera (projection,
 * zoom, distance, light) and the archetype. Each change is a command, undone as one step.
 */
export function DocumentPanel() {
  const { document, issues } = state.value;
  // The document's issues outside its tree (`view.width`, `archetype`): the tree shows the rest.
  const own = issues.filter((issue) => !/^root(\.|$)/.test(issue.path));
  const meta = document.meta ?? { name: '' };
  const camera = document.camera?.props ?? {};
  const light = camera.light as Vec3 | undefined;
  const archetypes = [...ARCHETYPES.keys()];
  const archetype = typeof document.archetype === 'string' ? document.archetype : '';
  // A document's own archetype stays listed, even one the library does not have.
  if (archetype && !archetypes.includes(archetype)) archetypes.push(archetype);
  const projection = typeof camera.projection === 'string' ? camera.projection : '';
  const setLight = (axis: keyof Vec3, input: HTMLInputElement) => {
    const next = numberOf(input);
    if (next === null || next === undefined) {
      input.value = light ? String(light[axis]) : '';
      return;
    }
    const from = light ?? DEFAULT_LIGHT;
    set(['camera', 'props', 'light'], { x: from.x, y: from.y, z: from.z, [axis]: next });
  };
  return (
    <form class="form-panel" aria-label="Document" onSubmit={(event) => event.preventDefault()}>
      {own.length > 0 ? (
        <ul class="document-issues" role="alert">
          {own.map((issue) => (
            <li key={`${issue.path} ${issue.message}`}>
              <code>{issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      <fieldset>
        <legend>Document</legend>
        <label>
          Name
          <input
            type="text"
            value={typeof meta.name === 'string' ? meta.name : ''}
            onChange={(event) =>
              set(['meta', 'name'], (event.currentTarget as HTMLInputElement).value)
            }
          />
        </label>
        <label>
          Description
          <textarea
            rows={3}
            value={typeof meta.description === 'string' ? meta.description : ''}
            onChange={(event) => {
              const text = (event.currentTarget as HTMLTextAreaElement).value;
              set(['meta', 'description'], text.trim() === '' ? undefined : text);
            }}
          />
        </label>
        <label>
          Archetype
          <select
            value={archetype}
            onChange={(event) => {
              const value = (event.currentTarget as HTMLSelectElement).value;
              set(['archetype'], value === '' ? undefined : value);
            }}
          >
            <option value="">none</option>
            {archetypes.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <fieldset>
        <legend>Frame</legend>
        <NumberField
          label="Width"
          field={['view', 'width']}
          value={document.view?.width}
          fallback={240}
          min={1}
          required
        />
        <NumberField
          label="Height"
          field={['view', 'height']}
          value={document.view?.height}
          fallback={240}
          min={1}
          required
        />
        <ColorField
          label="Background"
          field={['view', 'background']}
          value={document.view?.background}
        />
      </fieldset>
      <fieldset>
        <legend>Camera</legend>
        <label>
          Projection
          <select
            value={projection}
            onChange={(event) => {
              const value = (event.currentTarget as HTMLSelectElement).value;
              set(['camera', 'props', 'projection'], value === '' ? undefined : value);
            }}
          >
            <option value="">default (orthographic)</option>
            {PROJECTIONS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <NumberField
          label="Zoom"
          field={['camera', 'props', 'zoom']}
          value={camera.zoom}
          fallback={1}
          min={0}
          step={0.1}
        />
        <NumberField
          label="Distance"
          field={['camera', 'props', 'distance']}
          value={camera.distance}
          fallback={1000}
          min={0}
        />
        <fieldset class="field-row" aria-label="Light">
          <span>Light</span>
          {(['x', 'y', 'z'] as const).map((axis) => (
            <input
              key={axis}
              type="number"
              step={0.05}
              aria-label={`Light ${axis}`}
              value={light ? light[axis] : ''}
              placeholder={DEFAULT_LIGHT[axis].toFixed(2)}
              onChange={(event) => setLight(axis, event.currentTarget as HTMLInputElement)}
            />
          ))}
          <button
            type="button"
            disabled={!light}
            onClick={() => set(['camera', 'props', 'light'], undefined)}
          >
            Reset
          </button>
        </fieldset>
      </fieldset>
    </form>
  );
}
