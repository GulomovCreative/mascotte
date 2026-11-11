import {
  Animator,
  type Behavior,
  bindClip,
  Camera,
  type Clip,
  DepthSorter,
  GLCollector,
  HitTester,
  Node,
  Rig,
  Scene,
} from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { allocatedBytesPerCall } from '../src/allocations.ts';
import { buildBenchmark, engineScenes, referenceScenes } from '../src/index.ts';

/*
 * Allocations in the frame loop. The V8 heap profiler also counts objects that were already
 * collected, so every allocation is visible; on a short run its noise is up to a hundred bytes.
 *
 * When the scene does not change, WebGL2 does not rebuild the frame at all (see the browser
 * tests); here the build itself is checked. For an unchanged scene it allocates a fraction of
 * a byte per shape: only the floating-point numbers that V8 boxes in non-inlined calls remain
 * (for example, the perspective scale). With animation the world matrices are recomputed,
 * about 2 KB per frame of 6000 shapes. How many numbers V8 boxes depends on its inlining
 * decisions and varies between machines (in CI the hit test allocated 5 KB versus 2 KB
 * locally), so the thresholds have headroom. They catch growth: the benchmark build used to
 * allocate about 50 KB per frame.
 */

const bench = buildBenchmark();
const scene = new Scene(bench.root);

function clipWorld() {
  const world = new Scene();
  const tracks: Clip['tracks'][number][] = [];
  for (let i = 0; i < 20; i++) {
    world.root.add(new Node({ id: `n${i}` }));
    tracks.push(
      {
        target: `n${i}`,
        property: 'rotation',
        keys: [
          { time: 0, value: { x: 0, y: 0, z: 0, w: 1 }, easing: 'sineInOut' },
          { time: 1, value: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } },
        ],
      },
      {
        target: `n${i}`,
        property: 'position',
        keys: [
          { time: 0, value: { x: 0, y: 0, z: 0 } },
          { time: 1, value: { x: i, y: 1, z: 2 } },
        ],
      },
      {
        target: `n${i}`,
        property: 'opacity',
        keys: [
          { time: 0, value: 1 },
          { time: 1, value: 0.2 },
        ],
      },
    );
  }
  return { world, tracks };
}

describe('benchmark', () => {
  it('20 mascots with 300 drawable nodes each', () => {
    expect(bench.drawables).toBe(6000);
  });
});

describe('allocations in the frame loop', () => {
  it('sorting an unchanged scene allocates almost nothing', async () => {
    const sorter = new DepthSorter();
    const bytes = await allocatedBytesPerCall(() => sorter.sort(scene, bench.camera), {
      warmup: 500,
      runs: 100,
    });
    expect(bytes, `${Math.round(bytes)} bytes`).toBeLessThan(256);
  }, 60_000);

  it('building a WebGL2 frame of an unchanged scene allocates almost nothing', async () => {
    const collector = new GLCollector();
    const bytes = await allocatedBytesPerCall(() => collector.collect(scene, bench.camera), {
      warmup: 300,
      runs: 60,
    });
    expect(bytes, `${Math.round(bytes)} bytes`).toBeLessThan(256);
  }, 60_000);

  it('building reference scenes and new-engine scenes allocates almost nothing', async () => {
    const cases = [
      ...referenceScenes.map((s) => {
        const root = s.engine.build();
        s.engine.pose(root, 0);
        return { id: s.id, scene: new Scene(root), camera: new Camera({ zoom: s.zoom }) };
      }),
      ...engineScenes.map((s) => {
        const { root, camera } = s.build();
        s.pose(root, camera, 0.7);
        return { id: s.id, scene: new Scene(root), camera };
      }),
    ];
    for (const { id, scene, camera } of cases) {
      const collector = new GLCollector();
      const bytes = await allocatedBytesPerCall(() => collector.collect(scene, camera), {
        warmup: 3000,
        runs: 300,
      });
      // Small scenes: a few boxed numbers per shape; how many depends on inlining on the
      // machine (in CI "Mascot in 3D" gave 287 bytes versus ~100 locally).
      expect(bytes, `${id}: ${Math.round(bytes)} bytes`).toBeLessThan(1024);
    }
  }, 120_000);

  it('animation: pose, sort and frame build allocate at most 8 KB per frame', async () => {
    const collector = new GLCollector();
    let time = 0;
    const bytes = await allocatedBytesPerCall(
      () => {
        time += 1 / 60;
        bench.pose(time);
        collector.collect(scene, bench.camera);
      },
      { warmup: 300, runs: 60 },
    );
    expect(bytes, `${Math.round(bytes)} bytes`).toBeLessThan(8192);
  }, 60_000);

  it('hit test over 6000 shapes allocates at most 16 KB', async () => {
    const tester = new HitTester();
    const bytes = await allocatedBytesPerCall(
      () => tester.hitTest(scene, bench.camera, bench, bench.width / 2, bench.height / 2),
      { warmup: 100, runs: 30 },
    );
    expect(bytes, `${Math.round(bytes)} bytes`).toBeLessThan(16384);
  }, 60_000);

  it('applying a clip with number, vector and quaternion tracks', async () => {
    const { world, tracks } = clipWorld();
    const binding = bindClip({ duration: 1, loop: 'pingpong', tracks }, world);
    let time = 0;
    const bytes = await allocatedBytesPerCall(
      () => {
        time += 1 / 60;
        binding.apply(time);
      },
      { warmup: 3000, runs: 300 },
    );
    // About 20–55 bytes per track: numbers boxed at polymorphic calls (the easing result and
    // the value passed to the property setter). Vectors and quaternions are copied without
    // allocating. The threshold of 100 bytes per track catches real per-frame allocations.
    expect(bytes, `${Math.round(bytes)} bytes for ${tracks.length} tracks`).toBeLessThan(
      tracks.length * 100,
    );
  }, 60_000);

  it('animation layers: override with a crossfade and an additive layer', async () => {
    const { world, tracks } = clipWorld();
    const animator = new Animator(world);
    const base = animator.addLayer();
    const walk: Clip = { duration: 1, loop: 'loop', tracks };
    const run: Clip = { duration: 1, loop: 'pingpong', tracks };
    base.play(walk);
    const breathe = animator.addLayer({ mode: 'additive', weight: 0.5 });
    breathe.play({ duration: 1.5, loop: 'loop', tracks });
    let frame = 0;
    const bytes = await allocatedBytesPerCall(
      () => {
        // A crossfade between the two clips every second.
        if (++frame % 60 === 0) base.play(frame % 120 === 0 ? walk : run, { fade: 0.5 });
        animator.update(1 / 60);
      },
      { warmup: 3000, runs: 300 },
    );
    // Three layers' worth of tracks (two while not fading) with the same boxed numbers as
    // `apply`, and the playing state allocated by `play` once a second.
    expect(bytes, `${Math.round(bytes)} bytes for ${tracks.length} tracks`).toBeLessThan(
      tracks.length * 200,
    );
  }, 60_000);

  it('animation layers without new clips: an override and an additive layer', async () => {
    const { world, tracks } = clipWorld();
    const animator = new Animator(world);
    animator.addLayer().play({ duration: 1, loop: 'loop', tracks });
    animator
      .addLayer({ mode: 'additive', weight: 0.5 })
      .play({ duration: 1.5, loop: 'loop', tracks });
    const bytes = await allocatedBytesPerCall(() => animator.update(1 / 60), {
      warmup: 3000,
      runs: 300,
    });
    // Two layers sample every track: about 45 bytes per track and layer, the boxed numbers of
    // `apply`. Reallocating the sample buffers per frame would go over the threshold.
    expect(bytes, `${Math.round(bytes)} bytes for ${tracks.length} tracks`).toBeLessThan(
      tracks.length * 2 * 75,
    );
  }, 60_000);

  it('procedural behaviors on an additive layer', async () => {
    const world = new Scene();
    const behaviors: Behavior[] = [];
    for (let i = 0; i < 20; i++) {
      world.root.add(new Node({ id: `n${i}` }));
      behaviors.push(
        {
          kind: 'oscillate',
          target: `n${i}`,
          property: 'scale',
          from: { x: 1, y: 1, z: 1 },
          to: { x: 1.05, y: 0.97, z: 1.05 },
          period: 3,
        },
        {
          kind: 'blink',
          target: `n${i}`,
          property: 'opacity',
          from: 1,
          to: 0,
          duration: 0.2,
          minInterval: 0.5,
          maxInterval: 1,
          seed: i,
        },
        {
          kind: 'noise',
          target: `n${i}`,
          property: 'rotation',
          from: { x: 0, y: -0.1, z: 0, w: 1 },
          to: { x: 0, y: 0.1, z: 0, w: 1 },
          frequency: 1,
          seed: i,
        },
      );
    }
    const animator = new Animator(world);
    animator.addLayer({ mode: 'additive' }).play({ behaviors });
    const bytes = await allocatedBytesPerCall(() => animator.update(1 / 60), {
      warmup: 3000,
      runs: 300,
    });
    // Like clip tracks: boxed numbers at polymorphic calls, no buffers.
    expect(bytes, `${Math.round(bytes)} bytes for ${behaviors.length} behaviors`).toBeLessThan(
      behaviors.length * 75,
    );
  }, 60_000);

  it('springs on a swaying chain', async () => {
    const world = new Scene();
    let parent = world.root;
    for (let i = 0; i < 20; i++) {
      const node = new Node({ id: `s${i}`, position: { x: 0, y: 5, z: 0 } });
      parent.add(node);
      parent = node;
    }
    const animator = new Animator(world);
    for (let i = 0; i < 20; i++) animator.addSpring({ target: `s${i}`, tip: { x: 0, y: 5, z: 0 } });
    const top = world.getById('s0');
    let time = 0;
    const bytes = await allocatedBytesPerCall(
      () => {
        time += 1 / 60;
        if (top) top.position.x = Math.sin(time * 3) * 10;
        animator.update(1 / 60);
      },
      { warmup: 3000, runs: 300 },
    );
    // The pose and the spring both write the rotation, each like a steady clip track (boxed
    // numbers at polymorphic calls; about 57 to 74 bytes per spring, depending on the JIT).
    expect(bytes, `${Math.round(bytes)} bytes for 20 springs`).toBeLessThan(20 * 2 * 75);
  }, 60_000);

  it('springs whose nodes were destroyed and not replaced', async () => {
    const world = new Scene();
    const root = new Node({ id: 'mascot' });
    world.root.add(root);
    const rig = new Rig(root);
    const animator = new Animator(world, { rig });
    for (let i = 0; i < 20; i++) {
      root.add(new Node({ id: `ear${i}` }));
      rig.setSlot(`ear.${i}`, `ear${i}`);
      // Half by id, half by slot: each way of looking for a replacement is measured.
      const target = i % 2 ? `ear${i}` : { slot: `ear.${i}` };
      animator.addSpring({ target, tip: { x: 0, y: 5, z: 0 } });
    }
    for (let i = 0; i < 20; i++) world.getById(`ear${i}`)?.destroy();
    const bytes = await allocatedBytesPerCall(() => animator.update(1 / 60), {
      warmup: 3000,
      runs: 300,
    });
    // Only the owned rotations are written (boxed numbers, about 95 bytes per spring): looking
    // for a replacement every frame builds no error messages, which took about 100 more.
    expect(bytes, `${Math.round(bytes)} bytes for 20 orphaned springs`).toBeLessThan(20 * 140);
  }, 60_000);

  it('constraints: aim, lookAt, two-bone IK, copy and limit', async () => {
    const world = new Scene();
    const head = new Node({ id: 'head' });
    const twin = new Node({ id: 'twin' });
    const upper = new Node({ id: 'upper', position: { x: 0, y: -10, z: 0 } });
    const lower = new Node({ id: 'lower', position: { x: 0, y: 10, z: 0 } });
    upper.add(lower);
    world.root.add(head);
    world.root.add(twin);
    world.root.add(upper);
    const animator = new Animator(world);
    const aim = animator.addConstraint({
      kind: 'aim',
      target: 'head',
      point: { x: 1, y: 0, z: 5 },
    });
    animator.addConstraint({ kind: 'limitRotation', target: 'head', max: { y: 0.3 } });
    animator.addConstraint({ kind: 'lookAt', target: 'twin', point: { x: -3, y: 2, z: 5 } });
    const ik = animator.addConstraint({
      kind: 'twoBoneIK',
      target: 'upper',
      mid: 'lower',
      tip: { x: 0, y: 8, z: 0 },
      point: { x: 9, y: 0, z: 4 },
    });
    animator.addConstraint({ kind: 'copyTransform', target: 'twin', from: 'head', scale: false });
    const goal = { x: 0, y: 0, z: 5 };
    let time = 0;
    const bytes = await allocatedBytesPerCall(
      () => {
        time += 1 / 60;
        goal.x = Math.sin(time) * 5;
        aim.point = goal;
        ik.point = goal;
        animator.update(1 / 60);
      },
      { warmup: 3000, runs: 300 },
    );
    // About 1300 bytes: an update with one owned rotation and no constraint at work already
    // takes about 300 (boxed numbers at polymorphic calls when channels are written), and each
    // constraint adds its written channels and a few boxed numbers more, 50 to 200 bytes.
    expect(bytes, `${Math.round(bytes)} bytes for 5 constraints`).toBeLessThan(2000);
  }, 60_000);

  it('state machines with a blend, stepping and changing states', async () => {
    const world = new Scene();
    for (let i = 0; i < 4; i++) world.root.add(new Node({ id: `n${i}` }));
    const animator = new Animator(world);
    animator.addLayer({ name: 'body' });
    animator.addLayer({ name: 'face' });
    const hold = (id: string, x: number, duration: number): Clip => ({
      duration,
      loop: 'loop',
      tracks: [
        {
          target: id,
          property: 'position',
          keys: [
            { time: 0, value: { x: 0, y: 0, z: 0 } },
            { time: duration, value: { x, y: 0, z: 0 } },
          ],
        },
      ],
    });
    animator.addStateMachine({
      layer: 'body',
      inputs: [{ name: 'poke', type: 'trigger' }],
      states: [
        { name: 'a', motion: hold('n0', 5, 1) },
        { name: 'b', motion: hold('n1', 5, 0.5) },
      ],
      transitions: [
        { from: 'a', to: 'b', conditions: [{ input: 'poke' }], duration: 0.2 },
        { from: 'b', to: 'a', exitTime: 1, duration: 0.2 },
      ],
    });
    animator.addStateMachine({
      layer: 'face',
      inputs: [
        { name: 'mood', type: 'number' },
        { name: 'level', type: 'number' },
      ],
      states: [
        {
          name: 'calm',
          motion: {
            input: 'mood',
            blend: [
              { at: 0, motion: hold('n2', 1, 1) },
              { at: 1, motion: hold('n3', 2, 1) },
            ],
          },
        },
      ],
    });
    let frame = 0;
    const bytes = await allocatedBytesPerCall(
      () => {
        frame++;
        animator.inputs.set('mood', (frame % 100) / 100);
        if (frame % 90 === 0) animator.inputs.fire('poke');
        animator.update(1 / 60);
      },
      { warmup: 3000, runs: 300 },
    );
    // Writing the four position channels (boxed numbers) and, now and then, a transition that
    // pushes a fade entry and a playing state with its buffers.
    expect(bytes, `${Math.round(bytes)} bytes for 2 machines`).toBeLessThan(1500);
  }, 60_000);
});
