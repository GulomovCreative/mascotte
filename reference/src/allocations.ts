// Измерение выделений памяти в Node через профилировщик кучи V8. Не импортировать в браузерный код.
import { Session } from 'node:inspector/promises';

export interface AllocationOptions {
  /** Вызовов до измерения: V8 должен успеть оптимизировать горячий код. По умолчанию 5000. */
  warmup?: number;
  /** Вызовов под измерением. По умолчанию 500. */
  runs?: number;
}

/**
 * Сколько байт в среднем выделяет один вызов `fn` в установившемся режиме. Считаются
 * и объекты, которые сборщик мусора уже убрал. Профилировщик выборочный, но с шагом
 * в 16 байт он видит почти каждое выделение; его собственные расходы, по опыту, —
 * десятки байт на всё измерение, то есть доли байта на вызов.
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
