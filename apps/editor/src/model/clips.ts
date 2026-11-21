import type { Clip, Key, Target, Track } from '@mascotte/engine';
import type { EasingSpec } from '@mascotte/math';

/*
 * Edits of a clip: each makes a new clip from one, leaving it as it was, for a command to store
 * (`setDocumentField(['motions', name], clip)`). Keys stay sorted by time and within the clip;
 * a track whose last key goes goes with it.
 */

/** Whether two targets name the same node or slot. */
export function sameTarget(a: Target, b: Target): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.slot === b.slot;
}

/** A time in the clip: within it, to the millisecond (keys typed or dragged stay readable). */
export function clipTimeOf(clip: Clip, time: number): number {
  const within = Math.min(Math.max(time, 0), clip.duration);
  return Math.round(within * 1000) / 1000;
}

/** `keys` with `key` in its place by time; one already at its time is replaced. */
function placed(keys: readonly Key[], key: Key): Key[] {
  const rest = keys.filter((each) => each.time !== key.time);
  const at = rest.findIndex((each) => each.time > key.time);
  return at < 0 ? [...rest, key] : [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** `clip` with `tracks` (those left with no keys dropped). */
function withTracks(clip: Clip, tracks: readonly Track[]): Clip {
  return { ...clip, tracks: tracks.filter((track) => track.keys.length > 0) };
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
 * `clip` with a key of `property` on `target` at `time` set to `value`: in its track (made at the
 * end if the clip has none for them), replacing a key at that time but keeping its easing.
 */
export function keyed(
  clip: Clip,
  target: Target,
  property: string,
  time: number,
  value: unknown,
): Clip {
  const at = clipTimeOf(clip, time);
  const index = clip.tracks.findIndex(
    (each) => sameTarget(each.target, target) && each.property === property,
  );
  if (index < 0) {
    return { ...clip, tracks: [...clip.tracks, { target, property, keys: [{ time: at, value }] }] };
  }
  const found = track(clip, index);
  const easing = found.keys.find((each) => each.time === at)?.easing;
  const next: Key = easing === undefined ? { time: at, value } : { time: at, value, easing };
  const tracks = clip.tracks.map((each, i) =>
    i === index ? { ...each, keys: placed(each.keys, next) } : each,
  );
  return { ...clip, tracks };
}

/** `clip` without key `keyIndex` of track `trackIndex` (and without the track, if it was its last). */
export function unkeyed(clip: Clip, trackIndex: number, keyIndex: number): Clip {
  const found = track(clip, trackIndex);
  key(found, keyIndex);
  const keys = found.keys.filter((_, i) => i !== keyIndex);
  return withTracks(
    clip,
    clip.tracks.map((each, i) => (i === trackIndex ? { ...each, keys } : each)),
  );
}

/** `clip` with key `keyIndex` of track `trackIndex` moved to `time` (replacing a key there). */
export function retimed(clip: Clip, trackIndex: number, keyIndex: number, time: number): Clip {
  const found = track(clip, trackIndex);
  const moved = { ...key(found, keyIndex), time: clipTimeOf(clip, time) };
  const keys = placed(
    found.keys.filter((_, i) => i !== keyIndex),
    moved,
  );
  return {
    ...clip,
    tracks: clip.tracks.map((each, i) => (i === trackIndex ? { ...each, keys } : each)),
  };
}

/** `clip` with a copy of key `keyIndex` of track `trackIndex` at `time`. */
export function copiedKey(clip: Clip, trackIndex: number, keyIndex: number, time: number): Clip {
  const found = track(clip, trackIndex);
  const copy = { ...key(found, keyIndex), time: clipTimeOf(clip, time) };
  const keys = placed(found.keys, copy);
  return {
    ...clip,
    tracks: clip.tracks.map((each, i) => (i === trackIndex ? { ...each, keys } : each)),
  };
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
  const keys = found.keys.map((each, i) => (i === keyIndex ? next : each));
  return {
    ...clip,
    tracks: clip.tracks.map((each, i) => (i === trackIndex ? { ...each, keys } : each)),
  };
}

/** `clip` with track `trackIndex` aimed at `target` (a node's id, or its rig slot). */
export function retargeted(clip: Clip, trackIndex: number, target: Target): Clip {
  track(clip, trackIndex);
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
  return withTracks(
    { ...clip, duration },
    clip.tracks.map((each) => ({ ...each, keys: each.keys.filter((k) => k.time <= duration) })),
  );
}
