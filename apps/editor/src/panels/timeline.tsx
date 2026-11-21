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
  keyed,
  lasting,
  retargeted,
  retimed,
  unkeyed,
  untracked,
} from '../model/clips.ts';
import { type Command, setDocumentField } from '../model/commands.ts';
import { type BuiltScene, clipOf } from '../model/editor-document.ts';
import { type DocPath, nodeAt, samePath } from '../model/paths.ts';
import { attempt, editor, problem, state } from '../store.ts';
import { numberOf } from './document-panel.tsx';

/** Whether an edit in the inspector sets a key at the playhead of the clip open, not a rest value. */
export const autoKey = signal(false);
/** The key selected on the timeline: its track and its index there. */
const selectedKey = signal<{ readonly track: number; readonly key: number } | null>(null);
/** Whether the clip open plays. */
const playing = signal(false);

function run(command: Command): void {
  attempt(`Could not ${command.label.toLowerCase()}`, () => {
    const current = editor.value;
    current.execute(command);
    current.commit();
  });
}

/** Stores `clip` as the motion `name`, as a step. */
function store(name: string, clip: Clip): void {
  run(setDocumentField(['motions', name], clip));
}

/** The clip open on the timeline (the one previewed solo), with its name and the playhead. */
export function openClip(): { name: string; clip: Clip; time: number } | null {
  const { document, preview } = state.value;
  const solo = preview.solo;
  const clip = solo ? clipOf(document, solo.motion) : undefined;
  return solo && clip ? { name: solo.motion, clip, time: solo.time } : null;
}

/**
 * How a track names `node`: by the rig slot that binds it (as the library's and the reference
 * clips do), else by its id; `null` for a node with no id.
 */
export function targetOf(document: MascotDocument, node: NodeDocument): Target | null {
  if (node.id === undefined) return null;
  const slots = Object.entries(document.rig?.slots ?? {});
  const slot = slots.find(([, id]) => id === node.id)?.[0];
  return slot === undefined ? node.id : { slot };
}

/** The node built for the document node at `path` (a prefab instance's root, a solid itself). */
export function liveNode(scene: BuiltScene | null, path: DocPath): Node | null {
  if (!scene) return null;
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
 * Sets a key of `property` on the node at `path` at the playhead of the clip open: `value`, or the
 * value the node shows now. Says why when it cannot (no clip open, a node with no id).
 */
export function keyNode(path: DocPath, property: Property, value?: unknown): void {
  const open = openClip();
  const { document, scene } = state.value;
  const node = nodeAt(document, path);
  if (!open || !node) {
    problem.value = 'Open a clip on the timeline to key it.';
    return;
  }
  const target = targetOf(document, node);
  if (target === null) {
    problem.value = 'Give the node an id to key it.';
    return;
  }
  const live = liveNode(scene, path);
  const shown = value === undefined ? (live ? liveValue(property, live) : undefined) : value;
  if (shown === undefined) {
    problem.value = 'The node is not shown (see the issues) to key what it shows.';
    return;
  }
  store(open.name, keyed(open.clip, target, property.name, open.time, shown));
}

/** Shows the clip `name` solo at `time`, or no clip (the document as it plays) for `null`. */
function show(name: string | null, time = 0): void {
  const { preview } = state.peek();
  const { solo: _, ...rest } = preview;
  playing.value = false;
  selectedKey.value = null;
  attempt('Could not show the clip', () =>
    editor.value.setPreview(name === null ? rest : { ...rest, solo: { motion: name, time } }),
  );
}

function seek(time: number): void {
  attempt('Could not seek the clip', () => editor.value.seek(Math.max(0, time)));
}

/** What kind of motion a stored motion is, for the list. */
function kindOf(motion: unknown): string {
  if (typeof motion !== 'object' || motion === null) return 'not a motion';
  if (Array.isArray((motion as Clip).tracks)) return 'clip';
  if ('behaviors' in motion) return 'behaviors';
  if ('blend' in motion) return 'blend';
  if ('library' in motion) return 'library';
  return 'not a motion';
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

/** Plays the clip open while `playing`: the playhead runs on, by the clip's loop mode. */
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
      seek(at);
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
    // The loop starts from the playhead as it is when playing starts, not on every seek.
  }, [on, clip]);
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

/** The selected key's time and easing, and its copy and removal. */
function KeyEditor(props: { name: string; clip: Clip; time: number }) {
  const { name, clip, time } = props;
  const selected = selectedKey.value;
  const track = selected ? clip.tracks[selected.track] : undefined;
  const key = selected && track ? track.keys[selected.key] : undefined;
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
            const moved = retimed(clip, selected.track, selected.key, next);
            selectedKey.value = {
              track: selected.track,
              key: moved.tracks[selected.track]?.keys.findIndex(
                (each) => each.time === clipTimeOf(clip, next),
              ) as number,
            };
            store(name, moved);
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
            const next = value === 'linear' ? undefined : (value as EasingSpec);
            store(name, eased(clip, selected.track, selected.key, next));
          }}
        >
          {named === 'custom' ? <option value="custom">custom</option> : null}
          {names.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        onClick={() => store(name, copiedKey(clip, selected.track, selected.key, time))}
      >
        Copy to playhead
      </button>
      <button
        type="button"
        onClick={() => {
          selectedKey.value = null;
          store(name, unkeyed(clip, selected.track, selected.key));
        }}
      >
        Delete key
      </button>
    </fieldset>
  );
}

/** A clip on the timeline: its duration and loop, the playhead, and its tracks with their keys. */
function ClipEditor(props: { name: string; clip: Clip; time: number }) {
  const { name, clip, time } = props;
  const { document, selection } = state.value;
  usePlayback(clip, time);
  const local = clipTime(clip.duration, clip.loop, time);
  const at = (t: number) => (clip.duration > 0 ? `${(t / clip.duration) * 100}%` : '0%');
  const slots = document.rig?.slots ?? {};
  // What the selected node can be keyed by: its animatable properties.
  const node = selection === null ? null : nodeAt(document, selection);
  const live = selection === null ? null : liveNode(state.value.scene, selection);
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
              store(name, lasting(clip, next));
            }}
          />
        </label>
        <label>
          Loop
          <select
            aria-label="Loop"
            value={clip.loop}
            onChange={(event) =>
              store(name, {
                ...clip,
                loop: (event.currentTarget as HTMLSelectElement).value as Clip['loop'],
              })
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
          const id = typeof track.target === 'string' ? track.target : slots[track.target.slot];
          const slot = Object.entries(slots).find(([, bound]) => bound === track.target)?.[0];
          return (
            <li key={t} class="track" aria-label={`${targetLabel(track.target)} ${track.property}`}>
              <span class="track-name">
                {`${targetLabel(track.target)} · ${track.property}`}
                {typeof track.target !== 'string' && id !== undefined ? (
                  <button
                    type="button"
                    title={`Target the node ${id} rather than the slot`}
                    onClick={() => store(name, retargeted(clip, t, id))}
                  >
                    by id
                  </button>
                ) : null}
                {typeof track.target === 'string' && slot !== undefined ? (
                  <button
                    type="button"
                    title={`Target the slot ${slot} rather than the node`}
                    onClick={() => store(name, retargeted(clip, t, { slot }))}
                  >
                    by slot
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove track ${targetLabel(track.target)} ${track.property}`}
                  onClick={() => {
                    selectedKey.value = null;
                    store(name, untracked(clip, t));
                  }}
                >
                  ×
                </button>
              </span>
              <span class="track-lane">
                <span class="playhead" style={{ left: at(local) }} />
                {track.keys.map((key, k) => {
                  const chosen = selectedKey.value?.track === t && selectedKey.value.key === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      class={chosen ? 'key selected' : 'key'}
                      style={{ left: at(key.time) }}
                      aria-label={`Key ${key.time} s`}
                      aria-pressed={chosen}
                      onClick={() => {
                        selectedKey.value = { track: t, key: k };
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
        <p class="empty">Select a node to key it at the playhead.</p>
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
  const layers: readonly LayerDocument[] = Array.isArray(document.layers) ? document.layers : [];
  const motions = Object.keys(document.motions ?? {});
  const slots = Object.keys(document.rig?.slots ?? {});
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
        const play = typeof layer.play === 'string' ? layer.play : layer.play ? 'inline' : '';
        return (
          <fieldset key={layer.name} class="field-row" aria-label={`Layer ${layer.name}`}>
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
              value={maskValue(layer.mask)}
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
              {typeof layer.mask === 'string' ? (
                <option value={maskValue(layer.mask)}>{layer.mask}</option>
              ) : null}
            </select>
            <select
              aria-label={`${layer.name} plays`}
              value={play}
              onChange={(event) => {
                const value = (event.currentTarget as HTMLSelectElement).value;
                const { play: _, ...rest } = layer;
                change(i, value === '' ? rest : { ...rest, play: value });
              }}
            >
              <option value="">nothing</option>
              {play === 'inline' ? <option value="inline">its own motion</option> : null}
              {motions.map((motion) => (
                <option key={motion} value={motion}>
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
  const shownName = state.value.preview.solo?.motion ?? '';
  return (
    <div class="timeline">
      <div class="field-row timeline-bar">
        <select
          aria-label="Motion"
          value={open ? open.name : ''}
          onChange={(event) => {
            const value = (event.currentTarget as HTMLSelectElement).value;
            show(value === '' ? null : value);
          }}
        >
          <option value="">the document playing</option>
          {Object.entries(motions).map(([name, motion]) => (
            <option key={name} value={name} disabled={kindOf(motion) !== 'clip'}>
              {`${name} (${kindOf(motion)})`}
            </option>
          ))}
        </select>
        <NewName
          label="New clip"
          add={(name) => {
            if (Object.hasOwn(motions, name)) {
              problem.value = `There is a motion "${name}" already.`;
              return;
            }
            run(setDocumentField(['motions', name], { duration: 1, loop: 'once', tracks: [] }));
            show(name);
          }}
        />
        {open ? (
          <button
            type="button"
            aria-label={`Remove motion ${open.name}`}
            onClick={() => {
              const name = open.name;
              show(null);
              run(setDocumentField(['motions', name], undefined));
            }}
          >
            Remove
          </button>
        ) : null}
      </div>
      {open ? (
        <ClipEditor name={open.name} clip={open.clip} time={open.time} />
      ) : shownName ? null : (
        <p class="empty">
          Open a clip to edit it here; behaviors, blends and library motions are edited in their
          forms.
        </p>
      )}
      <Layers />
    </div>
  );
}
