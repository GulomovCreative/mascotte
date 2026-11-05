import type { SnapshotResult } from '../src/snapshot.ts';

declare module 'vitest/browser' {
  interface BrowserCommands {
    matchGLSnapshot: (name: string, dataUrl: string) => Promise<SnapshotResult>;
  }
}
