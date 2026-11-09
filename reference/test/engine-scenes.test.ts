import { describe, expect, it } from 'vitest';
import { engineScenes } from '../src/index.ts';
import { isUpdatingSnapshots, matchSnapshot, renderEngineSceneToPng } from '../src/snapshot.ts';

const expectedStatus = isUpdatingSnapshots() ? 'written' : 'match';

/* Snapshots of features Zdog lacks: compared with the new engine's own references. */
describe('new-engine-only scenes', () => {
  for (const scene of engineScenes) {
    it(`${scene.id} matches the snapshot`, () => {
      const result = matchSnapshot(scene.id, renderEngineSceneToPng(scene, { pixelRatio: 2 }));
      expect(result.status, JSON.stringify(result)).toBe(expectedStatus);
    });

    for (const [i, time] of (scene.snapshotTimes ?? []).entries()) {
      it(`${scene.id} at time ${time.toFixed(2)} matches the snapshot`, () => {
        const png = renderEngineSceneToPng(scene, { pixelRatio: 2, time });
        const result = matchSnapshot(`${scene.id}-${i + 1}`, png);
        expect(result.status, JSON.stringify(result)).toBe(expectedStatus);
      });
    }

    it(`${scene.id}: pose changes the frame`, () => {
      const a = renderEngineSceneToPng(scene);
      const b = renderEngineSceneToPng(scene, { time: 1.5 });
      expect(a.equals(b)).toBe(false);
    });
  }
});

describe('demo clips', () => {
  it('lookAroundClip binds to the 3D mascot and moves its head', async () => {
    const { bindClip, Scene } = await import('@mascotte/engine');
    const { lookAroundClip } = await import('../src/index.ts');
    const scene = engineScenes.find((item) => item.id === 'engine-mascot-3d');
    if (!scene) throw new Error('No engine-mascot-3d scene.');
    const world = new Scene(scene.build().root);
    const binding = bindClip(lookAroundClip, world);
    const head = world.getById('head');
    binding.apply(0);
    const start = head?.rotation.y;
    binding.apply(1);
    expect(head?.rotation.y).not.toBe(start);
    expect(head?.position.y).toBeCloseTo(0, 9);
  });

  it('the animated mascot is rigged: its motions follow slots bound to other nodes', async () => {
    const { Animator, Scene } = await import('@mascotte/engine');
    const { animatedMascot } = await import('../src/index.ts');
    const { root, rig } = animatedMascot.build();
    expect(rig.bones.map((node) => node.id)).toEqual([
      'mascot',
      'head',
      'ear-left',
      'ear-right',
      'body',
      'shoulder-left',
      'shoulder-right',
    ]);
    for (const [slot, id] of rig.slots) expect(rig.node(slot)?.id, slot).toBe(id);
    // The wave is written for the slot `arm.R`; bound to the left shoulder, that arm waves.
    rig.setSlot('arm.R', 'shoulder-left');
    const world = new Scene(root);
    const animator = new Animator(world, { rig });
    animatedMascot.animate(animator);
    animator.update(0.5);
    expect(world.getById('shoulder-left')?.rotation.z).not.toBe(0);
    expect(world.getById('shoulder-right')?.rotation.z).toBe(0);
  });

  it('the animated mascot turns its head to a gaze point, by at most its limit', async () => {
    const { Animator, Scene } = await import('@mascotte/engine');
    const { mat3x4, vec3 } = await import('@mascotte/math');
    const { animatedMascot } = await import('../src/index.ts');
    const { root, rig } = animatedMascot.build();
    const world = new Scene(root);
    const animator = new Animator(world, { rig });
    const { gaze } = animatedMascot.animate(animator);
    const head = rig.node('head');
    if (!head) throw new Error('no head');
    const face = () => {
      const axis = mat3x4.transformDirection(vec3.create(), head.worldMatrix, { x: 0, y: 0, z: 1 });
      return vec3.normalize(axis, axis);
    };
    animator.evaluate();
    const before = face();
    expect(gaze.weight).toBe(0);
    const center = head.localToWorld(vec3.create(), head.pivot);
    // A point slightly to the side of where the face looks: the head turns all the way to it.
    const near = vec3.scaleAndAdd(vec3.create(), center, before, 100);
    near.x += 20;
    gaze.point = near;
    gaze.weight = 1;
    animator.evaluate();
    const toNear = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), near, center));
    expect(vec3.dot(face(), toNear)).toBeCloseTo(1, 9);
    // Far to the side, the turn stops at the limit.
    gaze.point = vec3.scaleAndAdd(vec3.create(), center, { x: 1, y: 0, z: 0 }, 500);
    animator.evaluate();
    expect(Math.acos(Math.min(1, vec3.dot(face(), before)))).toBeCloseTo(gaze.maxAngle, 9);
  });

  it('the animated mascot waves, breathes, blinks and swings its ears, and seeking matches playback', async () => {
    const { Animator, Scene } = await import('@mascotte/engine');
    const { animatedMascot } = await import('../src/index.ts');
    const make = () => {
      const { root, rig } = animatedMascot.build();
      const world = new Scene(root);
      const animator = new Animator(world, { rig });
      animatedMascot.animate(animator);
      return { world, animator, rig };
    };
    const played = make();
    const shoulder = played.world.getById('shoulder-right');
    const body = played.world.getById('body');
    const eyes = played.world.getById('eyes');
    const lids = played.world.getById('lids');
    const ear = played.world.getById('ear-left');
    const angles = new Set<number>();
    const scales = new Set<number>();
    const ears: number[] = [];
    let blinks = 0;
    for (let frame = 0; frame < 60 * 10; frame++) {
      played.animator.update(1 / 60);
      angles.add(Number(shoulder?.rotation.z.toFixed(3)));
      scales.add(Number(body?.scale.x.toFixed(3)));
      ears.push(ear?.rotation.z ?? 0);
      if (lids?.visible && !eyes?.visible) blinks++;
    }
    expect(angles.size).toBeGreaterThan(10);
    expect(scales.size).toBeGreaterThan(10);
    expect(blinks).toBeGreaterThan(0);
    // The ears have no clip: only their springs turn them, after the head sways and bobs.
    expect(Math.max(...ears.map(Math.abs))).toBeGreaterThan(0.05);
    const sought = make();
    const state = ({ world }: { world: InstanceType<typeof Scene> }) =>
      ['shoulder-right', 'body', 'head', 'eyes'].map((id) => {
        const node = world.getById(id);
        return [node?.rotation.z, node?.scale.x, node?.position.y, node?.visible];
      });
    // Playback sums 600 steps of 1/60 s, which is not exactly 10 in floating point.
    const at = played.animator.layers[0]?.time ?? 0;
    for (const layer of sought.animator.layers) layer.time = at;
    sought.animator.evaluate();
    expect(state(sought)).toEqual(state(played));
    // Springs are not seekable: with them off the ears show the pose, and playing the same
    // frames again gives the same swing.
    sought.animator.springsEnabled = false;
    sought.animator.evaluate();
    expect(sought.world.getById('ear-left')?.rotation.z).toBe(0);
    const replayed = make();
    const again: number[] = [];
    for (let frame = 0; frame < 60 * 10; frame++) {
      replayed.animator.update(1 / 60);
      again.push(replayed.world.getById('ear-left')?.rotation.z ?? 0);
    }
    expect(again).toEqual(ears);
  });
});
