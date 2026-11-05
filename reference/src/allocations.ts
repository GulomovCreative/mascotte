// Measures allocations in Node with the V8 heap profiler. Do not import into browser code.
import { Session } from 'node:inspector/promises';

export interface AllocationOptions {
  /** Calls before measuring, so V8 can optimize the hot code. Defaults to 5000. */
  warmup?: number;
  /** Calls while measuring. Defaults to 500. */
  runs?: number;
}

/**
 * Average bytes allocated by one call of `fn` in steady state. Objects already collected by
 * the garbage collector are counted too. The profiler samples, but with a 16-byte interval it
 * sees almost every allocation; its own overhead is, in practice, tens of bytes for the whole
 * measurement, a fraction of a byte per call.
 */
export async function allocatedBytesPerCall(
  fn: () => void,
  { warmup = 5000, runs = 500 }: AllocationOptions = {},
): Promise<number> {
  const session = new Session();
  session.connect();
  try {
    await session.post('HeapProfiler.enable');
    for (let i = 0; i < warmup; i++) fn();
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 16,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    for (let i = 0; i < runs; i++) fn();
    const { profile } = await session.post('HeapProfiler.stopSampling');
    let total = 0;
    const walk = (node: { selfSize: number; children: unknown[] }) => {
      total += node.selfSize;
      for (const child of node.children) walk(child as typeof node);
    };
    walk(profile.head as unknown as { selfSize: number; children: unknown[] });
    return total / runs;
  } finally {
    session.disconnect();
  }
}
