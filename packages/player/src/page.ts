import type { Ticker, TickSubscription } from '@mascotte/engine';

/** What is needed from the page: document visibility and media queries. */
export interface PageEnvironment {
  readonly document?: Pick<
    Document,
    'visibilityState' | 'addEventListener' | 'removeEventListener'
  >;
  readonly matchMedia?: (
    query: string,
  ) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
}

export interface PageBindingOptions {
  /**
   * What to do when the user asks for reduced motion (`prefers-reduced-motion:
   * reduce`): `'pause'` stops the loop (default), `'ignore'` disregards it.
   */
  reducedMotion?: 'pause' | 'ignore';
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function browser(): PageEnvironment {
  const doc = typeof document !== 'undefined' ? { document } : {};
  const media =
    typeof matchMedia === 'function'
      ? { matchMedia: (query: string) => globalThis.matchMedia(query) }
      : {};
  return { ...doc, ...media };
}

/**
 * Binds a ticker to the page: pause `'hidden'` while the tab is hidden, and pause
 * `'reduced-motion'` while the user asks for reduced motion. Returns a function
 * that removes the listeners and the `'hidden'` and `'reduced-motion'` pauses, whoever
 * set them: pause reasons are a set, not a counter, so a ticker needs only one binding.
 */
export function bindTickerToPage(
  ticker: Ticker,
  options: PageBindingOptions = {},
  env: PageEnvironment = browser(),
): () => void {
  const disposers: (() => void)[] = [];
  const doc = env.document;
  if (doc) {
    const sync = () => {
      if (doc.visibilityState === 'hidden') ticker.pause('hidden');
      else ticker.resume('hidden');
    };
    sync();
    doc.addEventListener('visibilitychange', sync);
    disposers.push(() => {
      doc.removeEventListener('visibilitychange', sync);
      ticker.resume('hidden');
    });
  }
  if ((options.reducedMotion ?? 'pause') === 'pause' && env.matchMedia) {
    const query = env.matchMedia(REDUCED_MOTION);
    const sync = () => {
      if (query.matches) ticker.pause('reduced-motion');
      else ticker.resume('reduced-motion');
    };
    sync();
    query.addEventListener('change', sync);
    disposers.push(() => {
      query.removeEventListener('change', sync);
      ticker.resume('reduced-motion');
    });
  }
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}

/** What is needed from `IntersectionObserver`. */
export type IntersectionObserverFactory = (
  callback: (entries: readonly Pick<IntersectionObserverEntry, 'isIntersecting'>[]) => void,
) => Pick<IntersectionObserver, 'observe' | 'disconnect'>;

function browserObserver(): IntersectionObserverFactory | undefined {
  if (typeof IntersectionObserver !== 'function') return undefined;
  return (callback) => new IntersectionObserver((entries) => callback(entries));
}

/**
 * Pauses a subscription with `'offscreen'` while the element is out of view: a mascot
 * past the screen edge does not spend frames. Does nothing without `IntersectionObserver`.
 * Returns a function that stops observing and removes the pause. A subscription needs
 * only one such observer: a second one would remove the first one's pause.
 */
export function pauseWhenOffscreen(
  subscription: TickSubscription,
  element: Element,
  createObserver: IntersectionObserverFactory | undefined = browserObserver(),
): () => void {
  if (!createObserver) return () => {};
  const observer = createObserver((entries) => {
    const entry = entries.at(-1);
    if (!entry) return;
    if (entry.isIntersecting) subscription.resume('offscreen');
    else subscription.pause('offscreen');
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
    subscription.resume('offscreen');
  };
}
