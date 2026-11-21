import type { Clip, Key, Target, Track } from '@mascotte/engine';
import type { MascotDocument } from '@mascotte/format';
import type { EasingSpec } from '@mascotte/math';

/*
 * Edits of a clip: each makes a new clip from one, leaving it as it was, for a command to store
 * (`setDocumentField(['motions', name], clip)`). Keys stay sorted by time and within the clip;
 * a track whose last key goes goes with it.
 */

/**
 * Whether two targets reach the same node: the same id or slot, or an id and a slot of `slots`
 * (the rig's) that binds it.
 */
export function sameTarget(
  a: Target,
  b: Target,
  slots: Readonly<Record<string, string>> = {},
): boolean {
  if (typeof a !== 'string' && typeof b !== 'string' && a.slot === b.slot) return true;
  const id = idOf(a, slots);
  return id !== undefined && id === idOf(b, slots);
}

/** The id of the node `target` reaches: its own, or the one `slots` binds its slot to. */
export function idOf(target: Target, slots: Readonly<Record<string, string>>): string | undefined {
  if (typeof target === 'string') return target;
  return Object.hasOwn(slots, target.slot) ? slots[target.slot] : undefined;
}

/** The rig's slots, as node ids by slot (none when the rig has none, or no object of them). */
export function boundSlots(document: MascotDocument): Readonly<Record<string, string>> {
  const slots: unknown = document.rig?.slots;
  if (typeof slots !== 'object' || slots === null) return {};
  // A slot bound to something that is no id is the format's to report: it binds nothing here.
  return Object.fromEntries(
    Object.entries(slots).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** A time in the clip: within it, to the millisecond (times typed or scrubbed stay readable). */
export function clipTimeOf(clip: Clip, time: number): number {
  const within = Math.min(Math.max(time, 0), clip.duration);
  return Math.min(Math.round(within * 1000) / 1000, clip.duration);
}

/**
 * `keys` with `key` in its place by time; the first key already at its time is replaced (a step,
 * two keys at one time, keeps its other key).
 */
function placed(keys: readonly Key[], key: Key): Key[] {
  const same = keys.findIndex((each) => each.time === key.time);
  if (same >= 0) return keys.map((each, i) => (i === same ? key : each));
  const at = keys.findIndex((each) => each.time > key.time);
  return at < 0 ? [...keys, key] : [...keys.slice(0, at), key, ...keys.slice(at)];
}

/** `clip` with `tracks` (those left with no keys dropped). */
function withTracks(clip: Clip, tracks: readonly Track[]): Clip {
  return { ...clip, tracks: tracks.filter((track) => track.keys.length > 0) };
}

/** `clip` with `keys` as the keys of track `trackIndex`. */
function withKeys(clip: Clip, trackIndex: number, keys: readonly Key[]): Clip {
  return {
    ...clip,
    tracks: clip.tracks.map((each, i) => (i === trackIndex ? { ...each, keys } : each)),
  };
}

function track(clip: Clip, index: number): Track {
  const found = clip.tracks[index];
  if (!found) throw new RangeError(`The clip has no track ${index + 1}.`);
  return found;
}

function key(found: Track, index: number): Key {
  const at = found.keys[index];
  if (!at) throw new RangeError(`The track has no key ${index + 1}.`);
  return at;
}

/**
 * `clip` with a key of `property` on `target` at `time` set to `value`: in the track of that
 * property on the node `target` reaches (by its id or a slot of `slots` that binds it, however the
 * track names it), made at the end if the clip has none; a key at that time is replaced, keeping
 * its easing.
 */
export function keyed(
  clip: Clip,
  target: Target,
  property: string,
  time: number,
  value: unknown,
  slots: Readonly<Record<string, string>> = {},
): Clip {
  const at = clipTimeOf(clip, time);
  const index = clip.tracks.findIndex(
    (each) => sameTarget(each.target, target, slots) && each.property === property,
  );
  if (index < 0) {
    return { ...clip, tracks: [...clip.tracks, { target, property, keys: [{ time: at, value }] }] };
  }
  const found = track(clip, index);
  const easing = found.keys.find((each) => each.time === at)?.easing;
  const next: Key = easing === undefined ? { time: at, value } : { time: at, value, easing };
  return withKeys(clip, index, placed(found.keys, next));
}

/** `clip` without key `keyIndex` of track `trackIndex` (and without the track, if it was its last). */
export function unkeyed(clip: Clip, trackIndex: number, keyIndex: number): Clip {
  const found = track(clip, trackIndex);
  key(found, keyIndex);
  const next = withKeys(
    clip,
    trackIndex,
    found.keys.filter((_, i) => i !== keyIndex),
  );
  return withTracks(next, next.tracks);
}

/** `clip` with key `keyIndex` of track `trackIndex` moved to `time` (replacing a key there). */
export function retimed(clip: Clip, trackIndex: number, keyIndex: number, time: number): Clip {
  const found = track(clip, trackIndex);
  const moved = { ...key(found, keyIndex), time: clipTimeOf(clip, time) };
  const rest = found.keys.filter((_, i) => i !== keyIndex);
  return withKeys(clip, trackIndex, placed(rest, moved));
}

/** `clip` with a copy of key `keyIndex` of track `trackIndex` at `time` (replacing a key there). */
export function copiedKey(clip: Clip, trackIndex: number, keyIndex: number, time: number): Clip {
  const found = track(clip, trackIndex);
  const copy = { ...key(found, keyIndex), time: clipTimeOf(clip, time) };
  return withKeys(clip, trackIndex, placed(found.keys, copy));
}

/** `clip` with the easing out of key `keyIndex` of track `trackIndex` (linear for `undefined`). */
export function eased(
  clip: Clip,
  trackIndex: number,
  keyIndex: number,
  easing: EasingSpec | undefined,
): Clip {
  const found = track(clip, trackIndex);
  const { easing: _, ...plain } = key(found, keyIndex);
  const next: Key = easing === undefined ? plain : { ...plain, easing };
  return withKeys(
    clip,
    trackIndex,
    found.keys.map((each, i) => (i === keyIndex ? next : each)),
  );
}

/**
 * `clip` with track `trackIndex` aimed at `target` (a node's id, or its rig slot); refused when
 * another track already sets that property with that target, which would override it.
 */
export function retargeted(clip: Clip, trackIndex: number, target: Target): Clip {
  const found = track(clip, trackIndex);
  const twin = clip.tracks.some(
    (each, i) =>
      i !== trackIndex && each.property === found.property && sameTarget(each.target, target),
  );
  if (twin) throw new RangeError(`Another track already sets ${found.property} there.`);
  return {
    ...clip,
    tracks: clip.tracks.map((each, i) => (i === trackIndex ? { ...each, target } : each)),
  };
}

/** `clip` without track `trackIndex`. */
export function untracked(clip: Clip, trackIndex: number): Clip {
  track(clip, trackIndex);
  return { ...clip, tracks: clip.tracks.filter((_, i) => i !== trackIndex) };
}

/** `clip` lasting `duration`: keys past it go (and tracks left with none). */
export function lasting(clip: Clip, duration: number): Clip {
  if (!(Number.isFinite(duration) && duration >= 0)) {
    throw new RangeError(`A clip lasts a finite time of at least 0, not ${duration}.`);
  }
  return withTracks(
    { ...clip, duration },
    clip.tracks.map((each) => ({ ...each, keys: each.keys.filter((k) => k.time <= duration) })),
  );
}
