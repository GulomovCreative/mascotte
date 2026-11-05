// Команды браузерных тестов WebGL: выполняются в Node. Не импортировать в браузерный код.
import { join } from 'node:path';
import type { BrowserCommand } from 'vitest/node';
import { diffDir, matchSnapshot, type SnapshotResult, snapshotDir } from './snapshot.ts';

/** Папка снимков WebGL: кадры WebGL и Canvas 2D различаются сглаживанием и перекрытиями. */
export const glSnapshotDir = join(snapshotDir, 'gl');
export const glDiffDir = join(diffDir, 'gl');

/**
 * Сравнивает кадр из браузера (data URL PNG) со снимком `reference/snapshots/gl/<name>.png`.
 * Обновление — как у остальных снимков, только в режиме `UPDATE_SNAPSHOTS=1`.
 */
export const matchGLSnapshot: BrowserCommand<[name: string, dataUrl: string]> = (
  _context,
  name,
  dataUrl,
): SnapshotResult => {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error(`Ожидался data URL PNG для снимка ${name}.`);
  }
  const png = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  // SwiftShader детерминирован: повторный прогон на той же версии Chromium (её задаёт
  // playwright в pnpm-lock.yaml) даёт тот же кадр. Обновление Chromium может сдвинуть
  // сглаживание краёв — тогда снимки пересоздаются. Допуск 0,05 % оставлен на мелкие
  // различия; пропавшие зрачки маскота отличались на 0,19 % кадра.
  return matchSnapshot(name, png, {
    snapshotDir: glSnapshotDir,
    diffDir: glDiffDir,
    maxDiffRatio: 0.0005,
    updateCommand: 'pnpm snapshots:update:gl',
  });
};

export const glCommands = { matchGLSnapshot };
