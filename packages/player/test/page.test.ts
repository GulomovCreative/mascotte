import { type FrameScheduler, Ticker } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { bindTickerToPage, pauseWhenOffscreen } from '../src/index.ts';

const idle: FrameScheduler = { request: () => 0, cancel: () => {} };

/** Event source that can be fired manually. */
function emitter() {
  const listeners = new Set<() => void>();
  return {
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    emit: () => {
      for (const listener of listeners) listener();
    },
    get size() {
      return listeners.size;
    },
  };
}

function fakePage(hidden: boolean, reduced: boolean) {
  const doc = { ...emitter(), visibilityState: hidden ? 'hidden' : 'visible' } as {
    visibilityState: DocumentVisibilityState;
  } & ReturnType<typeof emitter>;
  const query = { ...emitter(), matches: reduced };
  return {
    doc,
    query,
    env: {
      document: doc as unknown as Document,
      matchMedia: () => query as unknown as MediaQueryList,
    },
  };
}

describe('bindTickerToPage', () => {
  it('a hidden tab pauses the ticker, a visible one resumes it', () => {
    const ticker = new Ticker({ scheduler: idle });
    const page = fakePage(false, false);
    const dispose = bindTickerToPage(ticker, {}, page.env);
    expect(ticker.paused).toBe(false);
    page.doc.visibilityState = 'hidden';
    page.doc.emit();
    expect(ticker.paused).toBe(true);
    page.doc.visibilityState = 'visible';
    page.doc.emit();
    expect(ticker.paused).toBe(false);
    dispose();
    expect(page.doc.size).toBe(0);
    // After unbinding, page events do not touch the ticker.
    page.doc.visibilityState = 'hidden';
    page.doc.emit();
    expect(ticker.paused).toBe(false);
  });

  it('tab already hidden and reduced motion at bind time pause immediately', () => {
    const ticker = new Ticker({ scheduler: idle });
    const page = fakePage(true, false);
    const dispose = bindTickerToPage(ticker, {}, page.env);
    expect(ticker.paused).toBe(true);
    dispose();
    expect(ticker.paused).toBe(false);
  });

  it('prefers-reduced-motion pauses unless told to ignore it', () => {
    const page = fakePage(false, true);
    const ticker = new Ticker({ scheduler: idle });
    const dispose = bindTickerToPage(ticker, {}, page.env);
    expect(ticker.paused).toBe(true);
    page.query.matches = false;
    page.query.emit();
    expect(ticker.paused).toBe(false);
    dispose();
    expect(page.query.size).toBe(0);
    page.query.matches = true;
    page.query.emit();
    expect(ticker.paused).toBe(false);

    const ignoring = new Ticker({ scheduler: idle });
    bindTickerToPage(ignoring, { reducedMotion: 'ignore' }, fakePage(false, true).env);
    expect(ignoring.paused).toBe(false);
  });

  it('unbinding removes its own pauses and leaves others alone', () => {
    const ticker = new Ticker({ scheduler: idle });
    ticker.pause('user');
    const dispose = bindTickerToPage(ticker, {}, fakePage(true, true).env);
    dispose();
    ticker.resume('user');
    expect(ticker.paused).toBe(false);
  });

  it('without document and matchMedia (Node, worker) does nothing', () => {
    const ticker = new Ticker({ scheduler: idle });
    bindTickerToPage(ticker, {}, {})();
    expect(ticker.paused).toBe(false);
  });
});

describe('pauseWhenOffscreen', () => {
  it('the subscription stays paused while the element is off screen', () => {
    const ticker = new Ticker({ scheduler: idle });
    const subscription = ticker.add(() => {});
    let report = null as ((entries: { isIntersecting: boolean }[]) => void) | null;
    let disconnected = false;
    const dispose = pauseWhenOffscreen(subscription, {} as Element, (callback) => {
      report = callback;
      return {
        observe: () => {},
        disconnect: () => {
          disconnected = true;
        },
      };
    });
    report?.([{ isIntersecting: false }]);
    expect(subscription.paused).toBe(true);
    report?.([{ isIntersecting: false }, { isIntersecting: true }]);
    expect(subscription.paused).toBe(false);
    report?.([{ isIntersecting: false }]);
    dispose();
    expect([disconnected, subscription.paused]).toEqual([true, false]);
  });

  it('without IntersectionObserver the subscription is untouched', () => {
    const ticker = new Ticker({ scheduler: idle });
    const subscription = ticker.add(() => {});
    pauseWhenOffscreen(subscription, {} as Element, undefined)();
    expect(subscription.paused).toBe(false);
  });
});
