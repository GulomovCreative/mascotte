import {
  BLEND_MODES,
  type Clip,
  clipTime,
  LOOP_MODES,
  type Node,
  type Property,
  propertiesOf,
  type Target,
} from '@mascotte/engine';
import type { LayerDocument, MascotDocument, NodeDocument } from '@mascotte/format';
import { type EasingSpec, easing } from '@mascotte/math';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import {
  clipTimeOf,
  copiedKey,
  eased,
  idOf,
  keyed,
  lasting,
  retargeted,
  retimed,
  unkeyed,
  untracked,
} from '../model/clips.ts';
import { type Command, setDocumentField } from '../model/commands.ts';
import { clipOf, isClip } from '../model/editor-document.ts';
import { type DocPath, nodeAt, samePath } from '../model/paths.ts';
import { attempt, editor, problem, state } from '../store.ts';
import { numberOf } from './document-panel.tsx';
import { formKind, MotionForm, newMotion } from './motions.tsx';

/** Whether an edit in the inspector sets a key at the playhead of the clip open, not a rest value. */
export const autoKey = signal(false);
/**
 * The key selected on the timeline: its track, and its time there, so the key stays the same one
 * when others are added or go (of two keys at one time, a step, the first).
 */
const selectedKey = signal<{ readonly track: number; readonly time: number } | null>(null);
/** Whether the clip open plays. */
const playing = signal(false);
/** A motion open in its form (a behavior set, a blend or a library motion), or `null`. */
const openForm = signal<string | null>(null);
/** The label of "New" for each kind of motion it makes. */
const NEW_LABELS = {
  clip: 'New clip',
  behaviors: 'New behaviors',
  blend: 'New blend',
  library: 'New library motion',
} as const;
/** The kind of motion "New" makes. */
const newKind = signal<keyof typeof NEW_LABELS>('clip');

function run(command: Command): void {
  attempt(`Could not ${command.label.toLowerCase()}`, () => {
    const current = editor.value;
    current.execute(command);
    current.commit();
  });
}

/** Runs `task`; whether it could (what went wrong is said in the menu bar, after `what`). */
function tried(what: string, task: () => void): boolean {
  try {
    task();
    return true;
  } catch (error) {
    console.error(error);
    problem.value = `${what}: ${error instanceof Error ? error.message : String(error)}`;
    return false;
  }
}

/**
 * Stores the clip `edit` makes as the motion `name`, as a step; whether it could (an edit that
 * throws is said in the menu bar).
 */
function store(name: string, edit: () => Clip): boolean {
  return tried('Could not change the clip', () => {
    const current = editor.value;
    current.execute(setDocumentField(['motions', name], edit()));
    current.commit();
  });
}

/**
 * The clip open on the timeline (the one previewed solo), with its name, the layer time and the
 * time in the clip it shows (`local`, after the loop mode: the playhead).
 */
export function openClip(): { name: string; clip: Clip; time: number; local: number } | null {
  const { document, preview } = state.value;
  const solo = preview.solo;
  const clip = solo ? clipOf(document, solo.motion) : undefined;
  if (!solo || !clip) return null;
  return {
    name: solo.motion,
    clip,
    time: solo.time,
    local: clipTime(clip.duration, clip.loop, solo.time),
  };
}

/** The rig's slots, as node ids by slot (none when the rig has none, or no object of them). */
function slotsOf(document: MascotDocument): Readonly<Record<string, string>> {
  const slots: unknown = document.rig?.slots;
  if (typeof slots !== 'object' || slots === null) return {};
  // A slot bound to something that is no id is the format's to report: it binds nothing here.
  return Object.fromEntries(
    Object.entries(slots).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * How a track names `node`: by the rig slot that binds it (as the library's and the reference
 * clips do), else by its id; `null` for a node with no id.
 */
export function targetOf(document: MascotDocument, node: NodeDocument): Target | null {
  if (node.id === undefined) return null;
  const slot = Object.entries(slotsOf(document)).find(([, id]) => id === node.id)?.[0];
  return slot === undefined ? node.id : { slot };
}

/**
 * The first node built for the document node at `path` (a prefab instance's root, not its
 * prefab's nodes; a solid, not its parts), in the scene shown; none while that scene is stale,
 * as its nodes are then another document's or another clip's.
 */
export function liveNode(path: DocPath): Node | null {
  const { scene, stale } = state.value;
  if (!scene || stale) return null;
  for (const [node, from] of scene.sources) if (samePath(from, path)) return node;
  return null;
}

/** The value of `property` on `node` now, as a key holds it (vectors and rotations copied). */
export function liveValue(property: Property, node: Node): unknown {
  switch (property.type) {
    case 'vec3': {
      const { x, y, z } = property.get(node, { x: 0, y: 0, z: 0 });
      return { x, y, z };
    }
    case 'quat': {
      const { x, y, z, w } = property.get(node, { x: 0, y: 0, z: 0, w: 1 });
      return { x, y, z, w };
    }
    default:
      return property.get(node);
  }
}

/**
 * Sets a key of `property` on the node at `path` at the playhead of the clip open (in its track,
 * however that names the node): `value`, or the value the node shows now. Says why when it
 * cannot: no clip open, no node there, a node with no id, or one not shown.
 */
export function keyNode(path: DocPath, property: Property, value?: unknown): void {
  const open = openClip();
  const { document } = state.value;
  const node = nodeAt(document, path);
  if (!open) {
    problem.value = 'Open a clip on the timeline to key it.';
    return;
  }
  if (!node) {
    problem.value = 'There is no node there to key.';
    return;
  }
  const target = targetOf(document, node);
  if (target === null) {
    problem.value = 'Give the node an id to key it.';
    return;
  }
  const live = liveNode(path);
  const shown = value === undefined ? (live ? liveValue(property, live) : undefined) : value;
  if (shown === undefined) {
    problem.value = 'The node is not shown (see the issues) to key what it shows.';
    return;
  }
  const slots = slotsOf(document);
  store(open.name, () => keyed(open.clip, target, property.name, open.local, shown, slots));
}

/**
 * Shows the clip `name` solo at `time`, or no clip (the document as it plays) for `null`; a motion
 * form open closes.
 */
function show(name: string | null, time = 0): void {
  const { preview } = state.peek();
  const { solo: _, ...rest } = preview;
  playing.value = false;
  selectedKey.value = null;
  openForm.value = null;
  attempt('Could not show the clip', () =>
    editor.value.setPreview(name === null ? rest : { ...rest, solo: { motion: name, time } }),
  );
}

/** Seeks the clip open to `time`; whether it could (what went wrong is said in the menu bar). */
function seek(time: number): boolean {
  return tried('Could not seek the clip', () => editor.value.seek(Math.max(0, time)));
}

/** What kind of motion a stored motion is, for the list (`clip` only for a clip the timeline can open). */
function kindOf(motion: unknown): string {
  if (typeof motion === 'object' && motion !== null && 'tracks' in motion) {
    return isClip(motion) ? 'clip' : 'clip with issues';
  }
  return formKind(motion) ?? 'not a motion';
}

function targetLabel(target: Target): string {
  return typeof target === 'string' ? target : `slot ${target.slot}`;
}

/** The value of a key, short. */
function valueLabel(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 1000) / 1000);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value)
      .map((each) => (typeof each === 'number' ? Math.round(each * 1000) / 1000 : each))
      .join(', ');
  }
  return String(value);
}

/**
 * Plays the clip open while `playing`: the playhead runs on, by the clip's loop mode. It stops at
 * the end of a clip played once, when a seek fails, and when the scene shown stops being the
 * clip's (it has issues).
 */
function usePlayback(clip: Clip | null, time: number): void {
  const on = playing.value;
  useEffect(() => {
    if (!on || !clip) return;
    let last = performance.now();
    let at = time;
    let frame = requestAnimationFrame(function step(now) {
      // Paused since this frame was asked for (the effect is cleaned up after the next paint).
      if (!playing.peek()) return;
      at += (now - last) / 1000;
      last = now;
      if (clip.loop === 'once' && at >= clip.duration) {
        seek(clip.duration);
        playing.value = false;
        return;
      }
      // The playhead stays within one round of the loop.
      const round = clip.loop === 'pingpong' ? 2 * clip.duration : clip.duration;
      if (round > 0) at %= round;
      if (!seek(at)) {
        playing.value = false;
        return;
      }
      if (state.peek().stale) {
        playing.value = false;
        problem.value = 'The document has issues: fix them to play the clip.';
        return;
      }
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
    // The loop starts from the playhead as it is when playing starts, not on every seek.
  }, [on, clip]);
  // Closed (another clip, or undone), the clip stops playing.
  useEffect(
    () => () => {
      playing.value = false;
    },
    [],
  );
}

/** A name and a button that adds something by it (see `AddRow` in the assets panels). */
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

/**
 * The selected key's time and easing, and its copy and removal. Moved or copied onto another
 * key's time, it replaces that key.
 */
function KeyEditor(props: { name: string; clip: Clip; time: number }) {
  const { name, clip, time } = props;
  const selected = selectedKey.value;
  const track = selected ? clip.tracks[selected.track] : undefined;
  const index =
    selected && track ? track.keys.findIndex((each) => each.time === selected.time) : -1;
  const key = track?.keys[index];
  if (!selected || !track || !key) return null;
  const names = Object.keys(easing.named);
  const current = key.easing;
  const named = typeof current === 'string' ? current : current === undefined ? 'linear' : 'custom';
  return (
    <fieldset class="field-row key-editor" aria-label="Key">
      <span>{`${targetLabel(track.target)} · ${track.property} = ${valueLabel(key.value)}`}</span>
      <label>
        Time
        <input
          type="number"
          step="any"
          min={0}
          max={clip.duration}
          aria-label="Key time"
          value={key.time}
          onChange={(event) => {
            const input = event.currentTarget as HTMLInputElement;
            const next = numberOf(input);
            if (next === null || next === undefined) {
              input.value = String(key.time);
              return;
            }
            if (store(name, () => retimed(clip, selected.track, index, next))) {
              selectedKey.value = { track: selected.track, time: clipTimeOf(clip, next) };
            }
          }}
        />
      </label>
      <label>
        Easing
        <select
          aria-label="Key easing"
          value={named}
          onChange={(event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            if (value === 'custom') return;
            const next = value === 'linear' ? undefined : (value as EasingSpec);
            store(name, () => eased(clip, selected.track, index, next));
          }}
        >
          {/* One the editor has no name for (a curve, or a name it does not know) stays listed. */}
          {named === 'custom' || !names.includes(named) ? (
            <option value={named}>{named}</option>
          ) : null}
          {names.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => store(name, () => copiedKey(clip, selected.track, index, time))}
      >
        Copy to playhead
      </button>
      <button
        type="button"
        onClick={() => {
          selectedKey.value = null;
          store(name, () => unkeyed(clip, selected.track, index));
        }}
      >
        Delete key
      </button>
    </fieldset>
  );
}

/** A clip on the timeline: its duration and loop, the playhead, and its tracks with their keys. */
function ClipEditor(props: { name: string; clip: Clip; time: number; local: number }) {
  const { name, clip, time, local } = props;
  const { document, selection } = state.value;
  usePlayback(clip, time);
  const at = (t: number) => (clip.duration > 0 ? `${(t / clip.duration) * 100}%` : '0%');
  const slots = slotsOf(document);
  // What the selected node can be keyed by: its animatable properties.
  const node = selection === null ? null : nodeAt(document, selection);
  const live = selection === null ? null : liveNode(selection);
  const keyable = live ? propertiesOf(live).filter((property) => property.animatable) : [];
  return (
    <div class="clip-editor">
      <div class="field-row timeline-bar">
        <button
          type="button"
          aria-label={playing.value ? 'Pause' : 'Play'}
          onClick={() => {
            if (!playing.value && clip.loop === 'once' && local >= clip.duration) seek(0);
            playing.value = !playing.value;
          }}
        >
          {playing.value ? '❚❚' : '▶'}
        </button>
        <input
          type="range"
          aria-label="Playhead"
          min={0}
          max={clip.duration}
          step="any"
          value={local}
          onInput={(event) => {
            playing.value = false;
            seek((event.currentTarget as HTMLInputElement).valueAsNumber);
          }}
        />
        <span>{`${local.toFixed(2)} s`}</span>
        <label>
          Duration
          <input
            type="number"
            min={0}
            step="any"
            aria-label="Duration"
            value={clip.duration}
            onChange={(event) => {
              const input = event.currentTarget as HTMLInputElement;
              const next = numberOf(input);
              if (next === null || next === undefined || next < 0) {
                input.value = String(clip.duration);
                return;
              }
              // A shorter clip drops the keys past its end, and tracks may go with them.
              selectedKey.value = null;
              store(name, () => lasting(clip, next));
            }}
          />
        </label>
        <label>
          Loop
          <select
            aria-label="Loop"
            value={clip.loop}
            onChange={(event) =>
              store(name, () => ({
                ...clip,
                loop: (event.currentTarget as HTMLSelectElement).value as Clip['loop'],
              }))
            }
          >
            {LOOP_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
        <label class="check">
          <input
            type="checkbox"
            aria-label="Auto-key"
            checked={autoKey.value}
            onChange={(event) => {
              autoKey.value = (event.currentTarget as HTMLInputElement).checked;
            }}
          />
          Auto-key
        </label>
      </div>
      <ul class="tracks" aria-label="Tracks">
        {clip.tracks.map((track, t) => {
          const id = idOf(track.target, slots);
          const slot = Object.entries(slots).find(([, bound]) => bound === track.target)?.[0];
          return (
            <li key={t} class="track" aria-label={`${targetLabel(track.target)} ${track.property}`}>
              <span class="track-name">
                {`${targetLabel(track.target)} · ${track.property}`}
                {typeof track.target !== 'string' && id !== undefined ? (
                  <button
                    type="button"
                    title={`Target the node ${id} rather than the slot`}
                    onClick={() => store(name, () => retargeted(clip, t, id))}
                  >
                    by id
                  </button>
                ) : null}
                {typeof track.target === 'string' && slot !== undefined ? (
                  <button
                    type="button"
                    title={`Target the slot ${slot} rather than the node`}
                    onClick={() => store(name, () => retargeted(clip, t, { slot }))}
                  >
                    by slot
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove track ${targetLabel(track.target)} ${track.property}`}
                  onClick={() => {
                    selectedKey.value = null;
                    store(name, () => untracked(clip, t));
                  }}
                >
                  ×
                </button>
              </span>
              <span class="track-lane">
                <span class="playhead" style={{ left: at(local) }} />
                {track.keys.map((key, k) => {
                  // Of two keys at one time (a step), the first is the one selected.
                  const chosen =
                    selectedKey.value?.track === t &&
                    selectedKey.value.time === key.time &&
                    track.keys.findIndex((each) => each.time === key.time) === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      class={chosen ? 'key selected' : 'key'}
                      style={{ left: at(key.time) }}
                      aria-label={`Key ${key.time} s`}
                      aria-pressed={chosen}
                      onClick={() => {
                        selectedKey.value = { track: t, time: key.time };
                        seek(key.time);
                      }}
                    />
                  );
                })}
              </span>
            </li>
          );
        })}
      </ul>
      <KeyEditor name={name} clip={clip} time={local} />
      {node && selection !== null && keyable.length > 0 ? (
        <KeySelected path={selection} label={node.id ?? 'the node'} keyable={keyable} />
      ) : (
        <p class="empty">
          {state.value.stale
            ? 'The document has issues: fix them to key what the clip shows.'
            : 'Select a node to key it at the playhead.'}
        </p>
      )}
    </div>
  );
}

/** "Key this": a property of the selected node, keyed at the playhead with what it shows. */
function KeySelected(props: { path: DocPath; label: string; keyable: readonly Property[] }) {
  const [name, setName] = useState('position');
  const property = props.keyable.find((each) => each.name === name) ?? props.keyable[0];
  return (
    <div class="field-row">
      <span>{`Key ${props.label}:`}</span>
      <select
        aria-label="Property to key"
        value={property?.name}
        onChange={(event) => setName((event.currentTarget as HTMLSelectElement).value)}
      >
        {props.keyable.map((each) => (
          <option key={each.name} value={each.name}>
            {each.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => property && keyNode(props.path, property)}>
        Key this
      </button>
    </div>
  );
}

/** The document's layers, in blend order: each one's mode, weight, mask and what it plays. */
function Layers() {
  const { document } = state.value;
  // Layers that are no list, or a layer that is no object, are reported by the format; they can
  // only go, as a whole, until they are fixed in the file.
  const stored: unknown = document.layers;
  const malformed =
    (stored !== undefined && !Array.isArray(stored)) ||
    (Array.isArray(stored) &&
      stored.some(
        (layer) => typeof layer !== 'object' || layer === null || typeof layer.name !== 'string',
      ));
  if (malformed) {
    return (
      <fieldset class="layers">
        <legend>Layers</legend>
        <p class="empty">The layers are malformed (see the issues).</p>
        <button type="button" onClick={() => run(setDocumentField(['layers'], undefined))}>
          Remove the layers
        </button>
      </fieldset>
    );
  }
  const layers = document.layers ?? [];
  const motions = Object.keys(document.motions ?? {});
  const slots = Object.keys(slotsOf(document));
  const set = (next: readonly LayerDocument[]) =>
    run(setDocumentField(['layers'], next.length === 0 ? undefined : next));
  const change = (i: number, layer: LayerDocument) =>
    set(layers.map((each, j) => (j === i ? layer : each)));
  const move = (i: number, by: number) => {
    const next = [...layers];
    const [layer] = next.splice(i, 1);
    next.splice(i + by, 0, layer as LayerDocument);
    set(next);
  };
  const maskValue = (mask: LayerDocument['mask']) =>
    mask === undefined || mask === null
      ? ''
      : typeof mask === 'string'
        ? `id:${mask}`
        : `slot:${mask.slot}`;
  return (
    <fieldset class="layers">
      <legend>Layers</legend>
      {layers.map((layer, i) => {
        // Option values carry a kind, so a motion named like the others cannot be taken for them.
        const play =
          typeof layer.play === 'string'
            ? `motion:${layer.play}`
            : typeof layer.play === 'object' && layer.play !== null
              ? 'inline'
              : '';
        const mask = maskValue(layer.mask);
        return (
          <fieldset key={`${i} ${layer.name}`} class="field-row" aria-label={`Layer ${layer.name}`}>
            <span class="track-name">{layer.name}</span>
            <select
              aria-label={`${layer.name} mode`}
              value={layer.mode ?? 'override'}
              onChange={(event) => {
                const mode = (event.currentTarget as HTMLSelectElement).value as NonNullable<
                  LayerDocument['mode']
                >;
                change(i, { ...layer, mode });
              }}
            >
              {/* A mode the engine does not have stays listed (the format reports it). */}
              {layer.mode !== undefined && !BLEND_MODES.includes(layer.mode) ? (
                <option value={layer.mode}>{String(layer.mode)}</option>
              ) : null}
              {BLEND_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              aria-label={`${layer.name} weight`}
              value={layer.weight ?? 1}
              onChange={(event) => {
                const input = event.currentTarget as HTMLInputElement;
                const weight = numberOf(input);
                if (weight === null || weight === undefined) {
                  input.value = String(layer.weight ?? 1);
                  return;
                }
                change(i, { ...layer, weight });
              }}
            />
            <select
              aria-label={`${layer.name} mask`}
              value={mask}
              onChange={(event) => {
                const value = (event.currentTarget as HTMLSelectElement).value;
                const { mask: _, ...rest } = layer;
                if (value === '') change(i, rest);
                else if (value.startsWith('slot:'))
                  change(i, { ...rest, mask: { slot: value.slice(5) } });
                else change(i, { ...rest, mask: value.slice(3) });
              }}
            >
              <option value="">whole mascot</option>
              {slots.map((slot) => (
                <option key={slot} value={`slot:${slot}`}>
                  {`slot ${slot}`}
                </option>
              ))}
              {/* A mask the rig's slots do not list (an id, a slot it lacks) stays listed. */}
              {mask !== '' && !slots.some((slot) => `slot:${slot}` === mask) ? (
                <option value={mask}>{mask.replace(':', ' ')}</option>
              ) : null}
            </select>
            <select
              aria-label={`${layer.name} plays`}
              value={play}
              onChange={(event) => {
                const value = (event.currentTarget as HTMLSelectElement).value;
                const { play: _, ...rest } = layer;
                if (value === '') change(i, rest);
                else if (value.startsWith('motion:')) change(i, { ...rest, play: value.slice(7) });
              }}
            >
              <option value="">nothing</option>
              {play === 'inline' ? <option value="inline">its own motion</option> : null}
              {/* A motion the document lacks stays listed (the format reports it). */}
              {play.startsWith('motion:') && !motions.includes(play.slice(7)) ? (
                <option value={play}>{play.slice(7)}</option>
              ) : null}
              {motions.map((motion) => (
                <option key={motion} value={`motion:${motion}`}>
                  {motion}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={`Move ${layer.name} up`}
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move ${layer.name} down`}
              disabled={i === layers.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`Remove layer ${layer.name}`}
              onClick={() => set(layers.filter((_, j) => j !== i))}
            >
              ×
            </button>
          </fieldset>
        );
      })}
      <NewName
        label="Add layer"
        add={(name) => {
          if (layers.some((layer) => layer.name === name))
            problem.value = `There is a layer "${name}" already.`;
          else set([...layers, { name }]);
        }}
      />
    </fieldset>
  );
}

/**
 * The timeline (docs/EDITOR.md, Timeline): the document's motions, a clip open with its tracks and
 * keys, previewed solo at the playhead, played and scrubbed; and the layers.
 */
export function Timeline() {
  const { document } = state.value;
  const motions: Readonly<Record<string, unknown>> = document.motions ?? {};
  const open = openClip();
  // A motion form is shown only while that motion exists and is one the forms edit.
  const form =
    openForm.value !== null &&
    Object.hasOwn(motions, openForm.value) &&
    formKind(motions[openForm.value]) !== null
      ? openForm.value
      : null;
  const openName = open ? open.name : form;
  const kind = newKind.value;
  return (
    <div class="timeline">
      <div class="field-row timeline-bar">
        <select
          aria-label="Motion"
          value={openName ?? ''}
          onChange={(event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            if (value !== '' && formKind(motions[value]) !== null) {
              show(null);
              openForm.value = value;
            } else show(value === '' ? null : value);
          }}
        >
          <option value="">the document playing</option>
          {Object.entries(motions).map(([name, motion]) => {
            const what = kindOf(motion);
            const opens = what === 'clip' || formKind(motion) !== null;
            return (
              <option key={name} value={name} disabled={!opens}>
                {`${name} (${what})`}
              </option>
            );
          })}
        </select>
        <select
          aria-label="New motion kind"
          value={kind}
          onChange={(event) => {
            newKind.value = (event.currentTarget as HTMLSelectElement).value as typeof kind;
          }}
        >
          {(Object.keys(NEW_LABELS) as (keyof typeof NEW_LABELS)[]).map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
        <NewName
          label={NEW_LABELS[kind]}
          add={(name) => {
            if (Object.hasOwn(motions, name)) {
              problem.value = `There is a motion "${name}" already.`;
              return;
            }
            if (kind === 'clip') {
              run(setDocumentField(['motions', name], { duration: 1, loop: 'once', tracks: [] }));
              show(name);
            } else {
              run(setDocumentField(['motions', name], newMotion(kind, document)));
              show(null);
              openForm.value = name;
            }
          }}
        />
        {openName !== null ? (
          <button
            type="button"
            aria-label={`Remove motion ${openName}`}
            onClick={() => {
              show(null);
              run(setDocumentField(['motions', openName], undefined));
            }}
          >
            Remove
          </button>
        ) : null}
      </div>
      {open ? (
        <ClipEditor name={open.name} clip={open.clip} time={open.time} local={open.local} />
      ) : form !== null ? (
        <MotionForm name={form} />
      ) : (
        <p class="empty">
          Open a motion to edit it here: a clip on the timeline, behaviors, blends and library
          motions in their forms.
        </p>
      )}
      <Layers />
    </div>
  );
}
