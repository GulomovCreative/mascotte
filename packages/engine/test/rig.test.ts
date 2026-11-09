import { describe, expect, it } from 'vitest';
import {
  Animator,
  type BehaviorSet,
  bindClip,
  type Clip,
  findProperty,
  Node,
  Rig,
  Scene,
  type Target,
} from '../src/index.ts';
import { lookupTarget, resolveTarget, targetName } from '../src/rig/rig.ts';

/** `position.x` of `target` held at `x`. */
function holdX(target: Target, x: number): Clip {
  return {
    duration: 1,
    loop: 'once',
    tracks: [{ target, property: 'position', keys: [{ time: 0, value: { x, y: 0, z: 0 } }] }],
  };
}

/** A mascot `body` → `head` → `eye-left`, `eye-right`, with a rig binding slots to them. */
function setup() {
  const scene = new Scene();
  const root = new Node({ id: 'mascot', bone: true });
  const head = new Node({ id: 'head-node', bone: true });
  const eyeL = new Node({ id: 'eye-left' });
  const eyeR = new Node({ id: 'eye-right' });
  head.add(eyeL);
  head.add(eyeR);
  root.add(head);
  scene.root.add(root);
  const rig = new Rig(root, { head: 'head-node', 'eye.L': 'eye-left', 'eye.R': 'eye-right' });
  return { scene, root, head, eyeL, eyeR, rig };
}

describe('bones', () => {
  it('a node is not a bone by default; the flag comes from the options and the setter', () => {
    expect(new Node().bone).toBe(false);
    expect(new Node({ bone: true }).bone).toBe(true);
    const scene = new Scene();
    const node = new Node();
    scene.root.add(node);
    const version = scene.changeVersion;
    node.bone = false;
    expect(scene.changeVersion).toBe(version);
    node.bone = true;
    expect(node.bone).toBe(true);
    expect(scene.changeVersion).toBe(version + 1);
  });

  it('the flag is in the registry and not animatable', () => {
    expect(findProperty(Node, 'bone')).toMatchObject({
      type: 'bool',
      animatable: false,
      default: false,
    });
    const { scene, rig } = setup();
    const animator = new Animator(scene, { rig });
    const layer = animator.addLayer();
    const clip: Clip = {
      duration: 1,
      loop: 'once',
      tracks: [{ target: { slot: 'head' }, property: 'bone', keys: [{ time: 0, value: false }] }],
    };
    expect(() => layer.play(clip)).toThrow('Track [head].bone: the property is not animatable.');
  });

  it('the rig lists the bones of its subtree depth-first, the root included', () => {
    const { scene, root, head, eyeL, eyeR, rig } = setup();
    const jaw = new Node({ id: 'jaw', bone: true });
    eyeL.add(new Node({ id: 'lid', bone: true }));
    head.add(jaw);
    scene.root.add(new Node({ id: 'other', bone: true }));
    expect(rig.bones.map((node) => node.id)).toEqual(['mascot', 'head-node', 'lid', 'jaw']);
    root.bone = false;
    eyeR.bone = true;
    expect(rig.bones.map((node) => node.id)).toEqual(['head-node', 'lid', 'eye-right', 'jaw']);
    expect(rig.bones).not.toBe(rig.bones);
  });
});

describe('rig slots', () => {
  it('binds slot names to node ids and resolves them to nodes of the subtree', () => {
    const { root, head, eyeL, rig } = setup();
    expect([...rig.slots]).toEqual([
      ['head', 'head-node'],
      ['eye.L', 'eye-left'],
      ['eye.R', 'eye-right'],
    ]);
    expect(rig.node('head')).toBe(head);
    expect(rig.node('eye.L')).toBe(eyeL);
    expect(rig.node('mouth')).toBeNull();
    rig.setSlot('body', 'mascot');
    expect(rig.node('body')).toBe(root);
  });

  it('accepts dotted names of letters, digits and _, and rejects others', () => {
    const root = new Node();
    const rig = new Rig(root);
    for (const name of ['head', 'eye.L', 'arm_upper.R', 'finger.1.L', 'A9']) {
      expect(() => rig.setSlot(name, 'x'), name).not.toThrow();
    }
    for (const name of ['', '1eye', '.L', 'eye.', 'eye..L', 'eye L', 'eye-L', 'eye/L', '_eye']) {
      expect(() => rig.setSlot(name, 'x'), JSON.stringify(name)).toThrow(RangeError);
      expect(() => new Rig(root, { [name]: 'x' }), JSON.stringify(name)).toThrow(RangeError);
    }
    expect(() => rig.setSlot('head', '')).toThrow('Slot head: the node id must be');
    expect(() => new Rig(root, { head: '' })).toThrow(RangeError);
  });

  it('counts changes of the slots in its version', () => {
    const { rig } = setup();
    // Slots given to the constructor are not changes.
    expect(rig.version).toBe(0);
    const version = rig.version;
    rig.setSlot('head', 'head-node');
    expect(rig.version).toBe(version);
    rig.setSlot('head', 'eye-left');
    expect(rig.version).toBe(version + 1);
    rig.setSlot('mouth', 'head-node');
    expect(rig.version).toBe(version + 2);
    expect(rig.removeSlot('mouth')).toBe(true);
    expect(rig.version).toBe(version + 3);
    expect(rig.removeSlot('mouth')).toBe(false);
    expect(rig.version).toBe(version + 3);
    expect(rig.slots.has('mouth')).toBe(false);
  });

  it('gives a copy of its slots, so they change only through setSlot and removeSlot', () => {
    const { rig } = setup();
    const slots = rig.slots;
    expect(rig.slots).toBe(slots);
    (slots as Map<string, string>).set('head', 'eye-left');
    expect(rig.slotId('head')).toBe('head-node');
    expect(rig.node('head')?.id).toBe('head-node');
    rig.setSlot('mouth', 'head-node');
    expect(rig.slots).not.toBe(slots);
    expect(rig.slots.get('mouth')).toBe('head-node');
    expect(rig.slotId('nose')).toBeUndefined();
  });

  it('checks its root and slots', () => {
    expect(() => new Rig({} as Node)).toThrow(new TypeError('Rig root must be a Node.'));
    expect(() => new Rig(new Node(), null as unknown as Record<string, string>)).toThrow(
      'Rig slots must be an object mapping slot names to node ids.',
    );
  });

  it('does not resolve to nodes outside the subtree or no longer in the scene', () => {
    const { scene, head, eyeL, rig } = setup();
    scene.root.add(new Node({ id: 'outside' }));
    rig.setSlot('away', 'outside');
    expect(rig.node('away')).toBeNull();
    rig.setSlot('ghost', 'nobody');
    expect(rig.node('ghost')).toBeNull();
    eyeL.destroy();
    expect(rig.node('eye.L')).toBeNull();
    const replacement = new Node({ id: 'eye-left' });
    head.add(replacement);
    expect(rig.node('eye.L')).toBe(replacement);
  });

  it('resolves inside a subtree that is not in a scene', () => {
    const root = new Node({ id: 'loose' });
    const child = new Node({ id: 'loose-child' });
    root.add(child);
    const rig = new Rig(root, { body: 'loose', head: 'loose-child' });
    expect(rig.node('body')).toBe(root);
    expect(rig.node('head')).toBe(child);
  });
});

describe('targets', () => {
  it('names ids as they are and slots in brackets', () => {
    expect(targetName('head')).toBe('head');
    expect(targetName({ slot: 'eye.L' })).toBe('[eye.L]');
    // Malformed targets from JSON are named readably in errors.
    expect(targetName({ id: 'head' } as unknown as Target)).toBe('{"id":"head"}');
    expect(targetName(undefined as unknown as Target)).toBe('undefined');
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(targetName(cyclic as unknown as Target)).toBe('[object Object]');
  });

  it('looks up ids in the scene and slots through the rig, or says why it cannot', () => {
    const { scene, head, rig } = setup();
    const scope = { scene, rig };
    expect(lookupTarget('head-node', { scene, rig: null })).toBe(head);
    expect(lookupTarget({ slot: 'head' }, scope)).toBe(head);
    expect(lookupTarget('nobody', scope)).toBe('no node with id "nobody" in the scene.');
    expect(lookupTarget({ slot: 'head' }, { scene, rig: null })).toBe('slot "head" needs a rig.');
    expect(lookupTarget({ slot: 'tail' }, scope)).toBe(
      'the rig has no slot "tail" (slots: head, eye.L, eye.R).',
    );
    expect(lookupTarget({ slot: 'tail' }, { scene, rig: new Rig(new Node({ id: 'loose' })) })).toBe(
      'the rig\'s root "loose" is not in the scene.',
    );
    const empty = new Rig(new Node({ id: 'bare' }));
    scene.root.add(empty.root);
    expect(lookupTarget({ slot: 'tail' }, { scene, rig: empty })).toBe(
      'the rig has no slot "tail" (slots: none).',
    );
    scene.root.add(new Node({ id: 'outside' }));
    rig.setSlot('away', 'outside');
    expect(lookupTarget({ slot: 'away' }, scope)).toBe(
      'slot "away" is bound to "outside", which is outside the rig\'s root "mascot".',
    );
    rig.setSlot('tail', 'nobody');
    expect(lookupTarget({ slot: 'tail' }, scope)).toBe(
      'slot "tail" is bound to "nobody", but there is no node with that id.',
    );
    expect(lookupTarget({ slot: 'head' }, { scene: new Scene(), rig })).toBe(
      'the rig\'s root "mascot" is not in the scene.',
    );
    for (const bad of [null, 7, {}, { slot: 3 }, { id: 'head' }]) {
      expect(lookupTarget(bad as unknown as Target, scope), String(bad)).toBe(
        'the target must be a node id or a slot reference { slot }.',
      );
    }
  });

  it('resolves exactly what it looks up, without messages', () => {
    const { scene, rig } = setup();
    scene.root.add(new Node({ id: 'outside' }));
    rig.setSlot('away', 'outside').setSlot('ghost', 'nobody');
    const targets = ['head-node', 'nobody', 'outside', 'head', 'away', 'ghost', 'eye.L', 'tail'];
    const scopes = [
      { scene, rig },
      { scene, rig: null },
      { scene: new Scene(), rig },
    ];
    for (const scope of scopes) {
      for (const name of targets) {
        for (const target of [name, { slot: name }] as Target[]) {
          const found = lookupTarget(target, scope);
          expect(resolveTarget(target, scope), targetName(target)).toBe(
            typeof found === 'string' ? null : found,
          );
        }
      }
    }
  });
});

describe('animation by slots', () => {
  it('a bound clip writes the node of a slot, and needs a rig for it', () => {
    const { scene, eyeL, rig } = setup();
    bindClip(holdX({ slot: 'eye.L' }, 5), scene, { rig }).apply(0);
    expect(eyeL.position.x).toBe(5);
    expect(() => bindClip(holdX({ slot: 'eye.L' }, 5), scene)).toThrow(
      'Track [eye.L].position: slot "eye.L" needs a rig.',
    );
    expect(() => bindClip(holdX({ slot: 'nose' }, 5), scene, { rig })).toThrow(
      'Track [nose].position: the rig has no slot "nose" (slots: head, eye.L, eye.R).',
    );
  });

  it('clips and behaviors on layers address slots', () => {
    const { scene, head, eyeR, rig } = setup();
    const animator = new Animator(scene, { rig });
    expect(animator.rig).toBe(rig);
    animator.addLayer().play(holdX({ slot: 'head' }, 3));
    const wink: BehaviorSet = {
      behaviors: [
        {
          kind: 'oscillate',
          target: { slot: 'eye.R' },
          property: 'opacity',
          from: 1,
          to: 0,
          period: 2,
        },
      ],
    };
    animator.addLayer().play(wink);
    animator.update(0.5);
    expect(head.position.x).toBe(3);
    expect(eyeR.opacity).toBeCloseTo(0.5, 12);
    expect(new Animator(scene).rig).toBeNull();
    expect(() => new Animator(scene).addLayer().play(wink)).toThrow(
      'Behavior [eye.R].opacity: slot "eye.R" needs a rig.',
    );
  });

  it('the same motion follows a slot bound to another node', () => {
    const { scene, eyeL, eyeR, rig } = setup();
    const animator = new Animator(scene, { rig });
    const layer = animator.addLayer();
    const look = holdX({ slot: 'eye.L' }, 4);
    layer.play(look);
    animator.evaluate();
    expect(eyeL.position.x).toBe(4);
    rig.setSlot('eye.L', 'eye-right');
    layer.play(look);
    animator.evaluate();
    expect(eyeR.position.x).toBe(4);
    // The animator still owns the left eye's position, which returns to rest.
    expect(eyeL.position.x).toBe(0);
  });

  it('a layer mask can be a slot', () => {
    const { scene, root, head, eyeL, rig } = setup();
    const animator = new Animator(scene, { rig });
    const layer = animator.addLayer({ mask: { slot: 'head' } });
    expect(layer.mask).toEqual({ slot: 'head' });
    layer.play({
      duration: 1,
      loop: 'once',
      tracks: [
        { target: 'mascot', property: 'opacity', keys: [{ time: 0, value: 0.5 }] },
        { target: { slot: 'eye.L' }, property: 'opacity', keys: [{ time: 0, value: 0.25 }] },
      ],
    });
    animator.evaluate();
    expect(root.opacity).toBe(1);
    expect(eyeL.opacity).toBe(0.25);
    expect(head.opacity).toBe(1);
    expect(() => animator.addLayer({ mask: { slot: 'tail' } })).toThrow(
      'Layer mask [tail]: the rig has no slot "tail" (slots: head, eye.L, eye.R).',
    );
    expect(() => {
      layer.mask = { slot: 'tail' };
    }).toThrow('Layer mask [tail]:');
    expect(layer.mask).toEqual({ slot: 'head' });
  });

  it('a spring can hang on a slot and moves with it when its node is replaced', () => {
    const { scene, head, eyeL, rig } = setup();
    const animator = new Animator(scene, { rig });
    const spring = animator.addSpring({ target: { slot: 'eye.L' }, tip: { x: 0, y: 10, z: 0 } });
    expect(spring.node).toBe(eyeL);
    expect(spring.target).toEqual({ slot: 'eye.L' });
    expect(() =>
      animator.addSpring({ target: { slot: 'eye.L' }, tip: { x: 0, y: 1, z: 0 } }),
    ).toThrow('Spring [eye.L]: the node already has a spring.');
    expect(() =>
      animator.addSpring({ target: { slot: 'tail' }, tip: { x: 0, y: 1, z: 0 } }),
    ).toThrow('Spring [tail]: the rig has no slot "tail" (slots: head, eye.L, eye.R).');
    expect(() =>
      animator.addSpring({ target: { slot: 'head' }, tip: { x: 0, y: 1, z: 0 }, damping: -1 }),
    ).toThrow('Spring [head]: damping must be');
    // A new eye under another id; the slot is bound to it before the old one goes.
    const eye = new Node({ id: 'eye-new' });
    head.add(eye);
    rig.setSlot('eye.L', 'eye-new');
    eyeL.destroy();
    animator.update(1 / 60);
    expect(spring.node).toBe(eye);
  });

  it('compiles a motion once, and again on the next play after the slots change', () => {
    const { scene, rig } = setup();
    const animator = new Animator(scene, { rig });
    const layer = animator.addLayer();
    let reads = 0;
    const base = holdX({ slot: 'head' }, 1);
    const clip: Clip = {
      duration: base.duration,
      loop: base.loop,
      get tracks() {
        reads++;
        return base.tracks;
      },
    };
    layer.play(clip);
    layer.play(clip);
    expect(reads).toBe(1);
    rig.setSlot('mouth', 'head-node');
    layer.play(clip);
    expect(reads).toBe(2);
  });

  it('a playing motion keeps its node after a rebind until it is played again', () => {
    const { scene, eyeL, eyeR, rig } = setup();
    const animator = new Animator(scene, { rig });
    const layer = animator.addLayer();
    const look = holdX({ slot: 'eye.L' }, 4);
    layer.play(look);
    rig.setSlot('eye.L', 'eye-right');
    animator.update(0.1);
    expect(eyeL.position.x).toBe(4);
    expect(eyeR.position.x).toBe(0);
    rig.removeSlot('eye.L');
    expect(() => layer.play(look)).toThrow(
      'Track [eye.L].position: the rig has no slot "eye.L" (slots: head, eye.R).',
    );
    // The failed play leaves the layer as it was.
    expect(layer.motion).toBe(look);
    animator.update(0.1);
    expect(eyeL.position.x).toBe(4);
    rig.setSlot('eye.L', 'eye-right');
    layer.play(look);
    animator.update(0.1);
    expect(eyeR.position.x).toBe(4);
    expect(eyeL.position.x).toBe(0);
  });

  it('a slot mask moves to a rebound node together with the motions, on the next play', () => {
    const { scene, eyeL, eyeR, rig } = setup();
    rig.setSlot('face', 'eye-left');
    const animator = new Animator(scene, { rig });
    const layer = animator.addLayer({ mask: { slot: 'face' } });
    const dim: Clip = {
      duration: 1,
      loop: 'once',
      tracks: ['eye-left', 'eye-right'].map((target) => ({
        target,
        property: 'opacity',
        keys: [{ time: 0, value: 0.5 }],
      })),
    };
    layer.play(dim);
    animator.evaluate();
    expect([eyeL.opacity, eyeR.opacity]).toEqual([0.5, 1]);
    rig.setSlot('face', 'eye-right');
    // Another layer adds channels, which recomputes the flags: still the old node.
    animator.addLayer().play(holdX('mascot', 2));
    animator.evaluate();
    expect([eyeL.opacity, eyeR.opacity]).toEqual([0.5, 1]);
    layer.play(dim);
    animator.evaluate();
    expect([eyeL.opacity, eyeR.opacity]).toEqual([1, 0.5]);
    // A mask that does not resolve fails the play like a motion target, and changes nothing.
    rig.removeSlot('face');
    expect(() => layer.play(holdX('eye-left', 1))).toThrow(
      'Layer mask [face]: the rig has no slot "face"',
    );
    expect(layer.motion).toBe(dim);
    animator.evaluate();
    expect([eyeL.opacity, eyeR.opacity, eyeL.position.x]).toEqual([1, 0.5, 0]);
  });

  it('a destroyed masked node lets its layer affect nothing, without errors', () => {
    const { scene, head, eyeL, rig } = setup();
    const animator = new Animator(scene, { rig });
    const layer = animator.addLayer({ mask: { slot: 'eye.L' } });
    layer.play(holdX('head-node', 3));
    animator.evaluate();
    expect(head.position.x).toBe(0);
    eyeL.destroy();
    animator.addLayer().play(holdX('mascot', 2));
    expect(() => animator.evaluate()).not.toThrow();
    expect(head.position.x).toBe(0);
  });

  it('masks and springs keep copies of their slot references', () => {
    const { scene, eyeL, rig } = setup();
    const animator = new Animator(scene, { rig });
    const ref = { slot: 'head' };
    const layer = animator.addLayer({ mask: ref });
    const springRef = { slot: 'eye.L' };
    const spring = animator.addSpring({ target: springRef, tip: { x: 0, y: 10, z: 0 } });
    ref.slot = 'nose';
    springRef.slot = 'nose';
    expect(layer.mask).toEqual({ slot: 'head' });
    expect(spring.target).toEqual({ slot: 'eye.L' });
    expect(Object.isFrozen(layer.mask)).toBe(true);
    layer.play(holdX({ slot: 'head' }, 1));
    expect(spring.node).toBe(eyeL);
  });

  it('a spring stays on its node when its slot is rebound, and one node keeps one spring', () => {
    const { scene, head, eyeL, eyeR, rig } = setup();
    const animator = new Animator(scene, { rig });
    const a = animator.addSpring({ target: { slot: 'eye.L' }, tip: { x: 0, y: 10, z: 0 } });
    rig.setSlot('eye.L', 'eye-right');
    animator.update(1 / 60);
    expect(a.node).toBe(eyeL);
    const eye = new Node({ id: 'eye-new' });
    head.add(eye);
    const b = animator.addSpring({ target: 'eye-new', tip: { x: 0, y: 10, z: 0 } });
    rig.setSlot('eye.L', 'eye-new');
    eyeL.destroy();
    animator.update(1 / 60);
    // The slot's node already has a spring, so `a` stays where it was.
    expect(a.node).toBe(eyeL);
    expect(b.node).toBe(eye);
    expect(animator.springs.filter((spring) => spring.node === eye)).toHaveLength(1);
    expect(eyeR.destroyed).toBe(false);
  });

  it('a spring left without a node looks again when the tree or the slots change', () => {
    const { scene, head, eyeL, eyeR, rig } = setup();
    const animator = new Animator(scene, { rig });
    const spring = animator.addSpring({ target: { slot: 'eye.L' }, tip: { x: 0, y: 10, z: 0 } });
    eyeL.destroy();
    animator.update(1 / 60);
    expect(spring.node).toBe(eyeL);
    // Only the slots change: the right eye exists already.
    rig.setSlot('eye.L', 'eye-right');
    animator.update(1 / 60);
    expect(spring.node).toBe(eyeR);
    eyeR.destroy();
    animator.update(1 / 60);
    expect(spring.node).toBe(eyeR);
    // Only the tree changes: a node appears under the bound id.
    const eye = new Node({ id: 'eye-right' });
    head.add(eye);
    animator.update(1 / 60);
    expect(spring.node).toBe(eye);
  });

  it('a rig whose root is in another scene does not resolve for the animator', () => {
    const { rig } = setup();
    const animator = new Animator(new Scene(), { rig });
    expect(() => animator.addLayer().play(holdX({ slot: 'head' }, 1))).toThrow(
      'Track [head].position: the rig\'s root "mascot" is not in the scene.',
    );
  });
});
