import {
  Animator,
  bindClip,
  Camera,
  type Clip,
  DepthSorter,
  GLCollector,
  HitTester,
  Node,
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
});
