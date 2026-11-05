import type { Ticker, TickSubscription } from '@mascotte/engine';

/** Что нужно от страницы: видимость документа и медиазапросы. */
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
   * Что делать, если пользователь просит меньше движения (`prefers-reduced-motion:
   * reduce`): `'pause'` — остановить цикл (по умолчанию), `'ignore'` — не учитывать.
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
 * Связывает тикер со страницей: пауза `'hidden'`, пока вкладка скрыта, и пауза
 * `'reduced-motion'`, пока пользователь просит меньше движения. Возвращает функцию,
 * которая снимает обработчики и паузы `'hidden'` и `'reduced-motion'`, кто бы их ни
 * поставил: причины пауз — множество, а не счётчик, поэтому на тикер нужна одна привязка.
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

/** Что нужно от `IntersectionObserver`. */
export type IntersectionObserverFactory = (
  callback: (entries: readonly Pick<IntersectionObserverEntry, 'isIntersecting'>[]) => void,
) => Pick<IntersectionObserver, 'observe' | 'disconnect'>;

function browserObserver(): IntersectionObserverFactory | undefined {
  if (typeof IntersectionObserver !== 'function') return undefined;
  return (callback) => new IntersectionObserver((entries) => callback(entries));
}

/**
 * Ставит подписку на паузу `'offscreen'`, пока элемент вне области видимости: маскот
 * за краем экрана не тратит кадры. Без `IntersectionObserver` ничего не делает.
 * Возвращает функцию, которая перестаёт следить и снимает паузу. На подписку нужен
 * один такой наблюдатель: второй снял бы паузу первого.
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
