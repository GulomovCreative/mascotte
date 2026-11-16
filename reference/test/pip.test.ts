import { Animator, PointerInputs, propertiesOf, Scene, type Sphere } from '@mascotte/engine';
import { buildDocument, readDocument, writeNode } from '@mascotte/format';
import { mat3x4, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import { pip, pipDocument } from '../src/index.ts';

function make() {
  const { root, camera, rig } = pip.build();
  const world = new Scene(root);
  const animator = new Animator(world, { rig });
  const { gaze, emotion } = pip.animate(animator);
  return { root, camera, rig, world, animator, gaze, emotion };
}

function run(animator: Animator, seconds: number) {
  for (let frame = 0; frame < Math.round(seconds * 60); frame++) animator.update(1 / 60);
}

describe('Pip', () => {
  it('is rigged with bird slots: its motions follow slots bound to other nodes', () => {
    const { rig, root } = pip.build();
    expect(rig.bones.map((node) => node.id)).toEqual([
      'pip',
      'body',
      'wing-left',
      'wing-right',
      'head',
      'crest-l',
      'crest-m',
      'crest-r',
    ]);
    for (const [slot, id] of rig.slots) expect(rig.node(slot)?.id, slot).toBe(id);
    // Happy flaps the wings written for `wing.R`; bound to the left wing, that one flaps.
    rig.setSlot('wing.R', 'wing-left');
    const world = new Scene(root);
    const animator = new Animator(world, { rig });
    pip.animate(animator);
    const right = world.getById('wing-right');
    const rest = right?.rotation.z;
    animator.inputs.set('hover', true);
    const angles = new Set<number>();
    for (let frame = 0; frame < 60; frame++) {
      animator.update(1 / 60);
      angles.add(Number(world.getById('wing-left')?.rotation.z.toFixed(3)));
    }
    expect(angles.size).toBeGreaterThan(10);
    expect(right?.rotation.z).toBe(rest);
  });

  it('cheers up while hovered and startles on a poke, then goes back by the hover', () => {
    const { animator, emotion, rig } = make();
    const node = (slot: string) => {
      const found = rig.node(slot);
      if (!found) throw new Error(`no ${slot}`);
      return found;
    };
    const [eye, happyEyes, crest, beak] = ['eye.L', 'eyes.happy', 'crest.M', 'beak.lower'].map(
      node,
    );
    animator.springsEnabled = false;
    // Without chirps only the emotion opens the beak (the lower part turns down about x).
    const chirp = animator.layers.find((layer) => layer.name === 'chirp');
    if (!chirp) throw new Error('no chirp layer');
    chirp.weight = 0;
    run(animator, 0.5);
    expect(emotion.state).toBe('calm');
    expect([eye?.visible, happyEyes?.visible]).toEqual([true, false]);
    expect(beak?.rotation.x).toBeCloseTo(0);
    animator.inputs.set('hover', true);
    run(animator, 0.5);
    expect(emotion.state).toBe('happy');
    expect([eye?.visible, happyEyes?.visible]).toEqual([false, true]);
    expect(beak?.rotation.x).toBeCloseTo(-Math.sin(0.25));
    // The pointer leaves: calm again, with open eyes and a closed beak.
    animator.inputs.set('hover', false);
    run(animator, 0.5);
    expect(emotion.state).toBe('calm');
    expect([eye?.visible, happyEyes?.visible]).toEqual([true, false]);
    expect(beak?.rotation.x).toBeCloseTo(0);
    animator.inputs.set('hover', true);
    run(animator, 0.5);
    animator.inputs.fire('poke');
    run(animator, 0.3);
    expect(emotion.state).toBe('surprised');
    expect(eye?.visible).toBe(true);
    expect(eye?.scale.x).toBeCloseTo(1.45);
    expect(crest?.scale.y).toBeCloseTo(1.45);
    // A poke while surprised does not start it again: it lasts its 0.9 s.
    animator.inputs.fire('poke');
    run(animator, 0.4);
    expect(emotion.state).toBe('surprised');
    // Still hovered when the surprise has played out, 0.9 s after the first poke: happy again.
    run(animator, 0.3);
    expect(emotion.state).toBe('happy');
    animator.inputs.fire('poke');
    animator.inputs.set('hover', false);
    run(animator, 1.5);
    expect(emotion.state).toBe('calm');
    expect(eye?.scale.x).toBeCloseTo(1);
    expect(crest?.scale.y).toBeCloseTo(1);
  });

  it('the pointer over Pip and a click on it drive its emotions through its inputs', () => {
    const { animator, camera, emotion } = make();
    const viewport = { width: pip.width, height: pip.height };
    const pointer = new PointerInputs(animator, {
      camera,
      viewport,
      hover: 'hover',
      click: 'poke',
    });
    const frame = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds * 60); i++) {
        pointer.update();
        animator.update(1 / 60);
      }
    };
    // The middle of the frame is on the body.
    pointer.move(pip.width / 2, pip.height / 2);
    frame(0.5);
    expect(emotion.state).toBe('happy');
    pointer.down(pip.width / 2, pip.height / 2);
    pointer.up(pip.width / 2, pip.height / 2);
    frame(0.1);
    expect(emotion.state).toBe('surprised');
    pointer.move(2, 2);
    frame(1.5);
    expect(emotion.state).toBe('calm');
  });

  it('turns its head towards the gaze point, by at most its limit', () => {
    const { animator, gaze, rig } = make();
    const head = rig.node('head');
    if (!head) throw new Error('no head');
    const face = () => {
      const axis = mat3x4.transformDirection(vec3.create(), head.worldMatrix, { x: 0, y: 0, z: 1 });
      return vec3.normalize(axis, axis);
    };
    animator.evaluate();
    const before = face();
    const center = head.localToWorld(vec3.create(), head.pivot);
    const near = vec3.scaleAndAdd(vec3.create(), center, before, 100);
    near.y -= 20;
    gaze.point = near;
    gaze.weight = 1;
    animator.evaluate();
    const toNear = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), near, center));
    expect(vec3.dot(face(), toNear)).toBeCloseTo(1, 9);
    gaze.point = vec3.scaleAndAdd(vec3.create(), center, { x: -1, y: 0, z: 0 }, 500);
    animator.evaluate();
    expect(Math.acos(Math.min(1, vec3.dot(face(), before)))).toBeCloseTo(gaze.maxAngle, 9);
  });

  it('its body sphere and belly turn with the face, and the beak stands out of the belly', () => {
    const { animator, gaze, rig, world } = make();
    const head = rig.node('head');
    const belly = world.getById('belly');
    const beak = rig.node('beak.upper');
    if (!head || !belly || !beak) throw new Error('no head, belly or beak');
    const center = (node: typeof head) => node.localToWorld(vec3.create(), node.pivot);
    const face = () =>
      vec3.normalize(
        vec3.create(),
        mat3x4.transformDirection(vec3.create(), head.worldMatrix, { x: 0, y: 0, z: 1 }),
      );
    // The belly's direction from the head's center, against the face's.
    const bellyAngle = () => {
      const to = vec3.normalize(
        vec3.create(),
        vec3.sub(vec3.create(), center(belly), center(head)),
      );
      return vec3.dot(to, face());
    };
    animator.evaluate();
    const before = { angle: bellyAngle(), x: center(belly).x };
    gaze.point = vec3.scaleAndAdd(vec3.create(), center(head), { x: 1, y: 0, z: 0 }, 500);
    gaze.weight = 1;
    animator.evaluate();
    expect(bellyAngle()).toBeCloseTo(before.angle, 9);
    expect(center(belly).x).toBeGreaterThan(before.x + 5);
    // The beak's hinge is outside the belly sphere, so the belly does not swallow it.
    const gap = vec3.distance(center(beak), center(belly));
    expect(gap).toBeGreaterThan((belly as Sphere).diameter / 2);
  });

  it('breathes, blinks, chirps and swings its crest, and seeking matches playback', () => {
    const played = make();
    const body = played.rig.node('body');
    const eyes = played.rig.node('eyes');
    const lids = played.rig.node('lids');
    const beak = played.rig.node('beak.lower');
    const crest = played.rig.node('crest.L');
    const sought = make();
    const ids = ['body', 'head', 'eyes', 'lids', 'beak-lower', 'wing-left', 'eye-left'];
    const state = ({ world }: { world: Scene }) =>
      ids.map((id) => {
        const node = world.getById(id);
        const { x, y, z, w } = node?.rotation ?? {};
        return [x, y, z, w, node?.scale.y, node?.visible];
      });
    let seeks = 0;
    let seeksMidBlink = 0;
    const scales = new Set<number>();
    const crests: number[] = [];
    let blinks = 0;
    let chirps = 0;
    for (let frame = 0; frame < 60 * 10; frame++) {
      played.animator.update(1 / 60);
      scales.add(Number(body?.scale.y.toFixed(3)));
      crests.push(crest?.rotation.z ?? 0);
      if (lids?.visible && !eyes?.visible) blinks++;
      if ((beak?.rotation.x ?? 0) < -0.05) chirps++;
      // Every 10 frames, seeking another Pip to the same time gives the same pose.
      if (frame % 10 === 0) {
        const at = played.animator.layers[0]?.time ?? 0;
        for (const layer of sought.animator.layers) layer.time = at;
        sought.animator.evaluate();
        expect(state(sought)).toEqual(state(played));
        seeks++;
        if (lids?.visible) seeksMidBlink++;
      }
    }
    expect(seeks).toBe(60);
    // Some of them fall in a blink, where the eyes switch visibility.
    expect(seeksMidBlink).toBeGreaterThan(0);
    expect(scales.size).toBeGreaterThan(10);
    expect(blinks).toBeGreaterThan(0);
    expect(chirps).toBeGreaterThan(0);
    // The crest has no clip that turns it: only its springs, after the head sways.
    expect(Math.max(...crests.map(Math.abs))).toBeGreaterThan(0.02);
    // Springs are not seekable: with them off the crest shows the pose.
    sought.animator.springsEnabled = false;
    sought.animator.evaluate();
    expect(sought.world.getById('crest-l')?.rotation.z).toBe(0);
  });

  it('read back from its JSON document, it is the same mascot frame by frame', () => {
    const json = JSON.stringify(pipDocument());
    const built = buildDocument(readDocument(json));
    expect(built.view).toEqual({
      width: pip.width,
      height: pip.height,
      background: pip.background,
    });
    expect(built.camera.zoom).toBe(pip.build().camera.zoom);
    // Every property, path and id comes back as it was written.
    expect(writeNode(built.root)).toEqual(writeNode(pip.build().root));
    const fromJson = new Scene(built.root);
    const read = new Animator(fromJson, { rig: built.rig });
    const { constraints } = built.animate(read);
    const code = make();
    const nodes = (world: Scene) => {
      const out: unknown[] = [];
      const walk = (node: typeof world.root) => {
        // Generated ids differ between builds; set ones are kept.
        const id = node.id.startsWith('~') ? '~' : node.id;
        // Every registry property (style, shape parameters, …) and the world transform.
        const props = propertiesOf(node).map((p) =>
          p.type === 'vec3' || p.type === 'quat'
            ? { ...p.get(node, { x: 0, y: 0, z: 0, w: 0 }) }
            : p.get(node),
        );
        out.push([id, ...props, ...node.worldMatrix]);
        for (const child of node.children) walk(child);
      };
      walk(world.root);
      return out;
    };
    expect([...built.rig.slots]).toEqual([...code.rig.slots]);
    // The same inputs and gaze over a few seconds: hover, a poke, the pointer gone.
    const point = { x: 30, y: -40, z: 200 };
    for (const gaze of [constraints.get('gaze'), code.gaze]) {
      if (!gaze || !('point' in gaze)) throw new Error('no gaze');
      gaze.point = point;
      gaze.weight = 1;
    }
    for (let frame = 0; frame < 60 * 4; frame++) {
      for (const animator of [read, code.animator]) {
        if (frame === 30) animator.inputs.set('hover', true);
        if (frame === 90) animator.inputs.fire('poke');
        if (frame === 180) animator.inputs.set('hover', false);
        animator.update(1 / 60);
      }
      if (frame % 20 === 0) expect(nodes(fromJson)).toEqual(nodes(code.world));
    }
  });
});
