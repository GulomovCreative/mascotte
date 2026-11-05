import { Scene, WebGLRenderer } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { buildBenchmark } from '../src/index.ts';

/*
 * Allocations in the WebGL2 frame loop in a real browser: the Chrome heap profiler over CDP,
 * counting already collected objects. Talking to the profiler allocates memory itself, so the
 * same measurement of an empty function is subtracted.
 */

interface SamplingNode {
  selfSize: number;
  children: SamplingNode[];
}

async function sampledBytes(fn: () => void, runs: number): Promise<number> {
  const session = cdp();
  await session.send('HeapProfiler.enable');
  await session.send('HeapProfiler.startSampling', {
    samplingInterval: 16,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < runs; i++) fn();
  const { profile } = (await session.send('HeapProfiler.stopSampling')) as {
    profile: { head: SamplingNode };
  };
  let total = 0;
  const walk = (node: SamplingNode) => {
    total += node.selfSize;
    for (const child of node.children) walk(child);
  };
  walk(profile.head);
  return total;
}

/** Average bytes allocated by a call of `fn` beyond an empty call. */
async function bytesPerCall(fn: () => void, warmup: number, runs: number): Promise<number> {
  for (let i = 0; i < warmup; i++) fn();
  const empty = await sampledBytes(() => {}, runs);
  const used = await sampledBytes(fn, runs);
  return Math.max(0, used - empty) / runs;
}

const bench = buildBenchmark();
const scene = new Scene(bench.root);

function renderer(): { renderer: WebGLRenderer; draw: () => boolean } {
  const canvas = document.createElement('canvas');
  canvas.width = bench.width;
  canvas.height = bench.height;
  const instance = new WebGLRenderer(canvas, { supersample: 1 });
  const viewport = { width: bench.width, height: bench.height, background: bench.background };
  return { renderer: instance, draw: () => instance.render(scene, bench.camera, viewport) };
}

describe('WebGL2 allocations', () => {
  it('at rest the frame is not rebuilt and allocates nothing', async () => {
    const { renderer: instance, draw } = renderer();
    expect(draw()).toBe(true);
    expect(draw()).toBe(false);
    // Background browser work occasionally lands in the sample, so it is averaged over many
    // calls. A broken frame skip would rebuild the frame and allocate kilobytes per call.
    const bytes = await bytesPerCall(draw, 200, 2000);
    expect(bytes, `${bytes} bytes per call`).toBeLessThan(32);
    // After a scene change the frame is drawn again, and after invalidate too.
    bench.pose(1);
    expect(draw()).toBe(true);
    expect(draw()).toBe(false);
    instance.invalidate();
    expect(draw()).toBe(true);
    instance.destroy();
  }, 60_000);

  it('an animated benchmark frame allocates at most 8 KB', async () => {
    const { renderer: instance, draw } = renderer();
    let time = 0;
    const frame = () => {
      time += 1 / 60;
      bench.pose(time);
      draw();
    };
    // Currently 3–7 KB per frame of 6000 shapes: recomputing world matrices and the browser's
    // own WebGL calls. The threshold catches growth: a subarray per draw call gave ~10 KB, and
    // before the rework one frame build took ~50 KB.
    const bytes = await bytesPerCall(frame, 60, 30);
    expect(bytes, `${Math.round(bytes)} bytes per frame`).toBeLessThan(8192);
    instance.destroy();
  }, 120_000);
});
