/**
 * Функция плавности: время клипа от 0 до 1 → доля пройденного пути. Именованные
 * кривые и `cubicBezier` возвращают ровно 0 при t = 0 и ровно 1 при t = 1. Исключение —
 * `steps` в режимах `start` и `both`: там скачок происходит уже в начале. Кривые `back`,
 * `elastic` и `cubicBezier` с y вне [0, 1] выходят за [0, 1] посередине.
 */
export type Easing = (t: number) => number;

export const linear: Easing = (t) => t;

// ----- стандартные кривые ----- //

/** Отражает кривую: из разгона получается торможение и наоборот, `g(t) = 1 − f(1 − t)`. */
function mirror(curve: Easing): Easing {
  return (t) => 1 - curve(1 - t);
}

/** Из кривой разгона строит разгон и торможение, симметричные относительно середины. */
function easeInOut(easeIn: Easing): Easing {
  return (t) => (t < 0.5 ? easeIn(t * 2) / 2 : 1 - easeIn((1 - t) * 2) / 2);
}

const BACK = 1.70158;
const ELASTIC_PERIOD = (2 * Math.PI) / 3;

export const quadIn: Easing = (t) => t * t;
export const cubicIn: Easing = (t) => t * t * t;
export const quartIn: Easing = (t) => t * t * t * t;
export const quintIn: Easing = (t) => t * t * t * t * t;
// Кривые с неточной арифметикой на конце явно возвращают 1 при t ≥ 1.
export const sineIn: Easing = (t) => (t >= 1 ? 1 : 1 - Math.cos((t * Math.PI) / 2));
export const expoIn: Easing = (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10));
export const circIn: Easing = (t) => 1 - Math.sqrt(1 - Math.min(1, t * t));
/** Сначала немного отходит назад, потом разгоняется. */
export const backIn: Easing = (t) => (t >= 1 ? 1 : (BACK + 1) * t * t * t - BACK * t * t);
/** Колебания, как у пружины: нарастают к концу (`elasticOut` затухает). */
export const elasticIn: Easing = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ELASTIC_PERIOD);
/** Отскок, как у падающего мяча. */
export const bounceOut: Easing = (t) => {
  const n = 7.5625;
  const d = 2.75;
  if (t >= 1) return 1;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t - 1.5 / d) ** 2 + 0.75;
  if (t < 2.5 / d) return n * (t - 2.25 / d) ** 2 + 0.9375;
  return n * (t - 2.625 / d) ** 2 + 0.984375;
};
export const bounceIn: Easing = mirror(bounceOut);

export const quadOut = mirror(quadIn);
export const cubicOut = mirror(cubicIn);
export const quartOut = mirror(quartIn);
export const quintOut = mirror(quintIn);
export const sineOut = mirror(sineIn);
export const expoOut = mirror(expoIn);
export const circOut = mirror(circIn);
export const backOut = mirror(backIn);
export const elasticOut = mirror(elasticIn);

export const quadInOut = easeInOut(quadIn);
export const cubicInOut = easeInOut(cubicIn);
export const quartInOut = easeInOut(quartIn);
export const quintInOut = easeInOut(quintIn);
export const sineInOut = easeInOut(sineIn);
export const expoInOut = easeInOut(expoIn);
export const circInOut = easeInOut(circIn);
export const backInOut = easeInOut(backIn);
export const elasticInOut = easeInOut(elasticIn);
export const bounceInOut = easeInOut(bounceIn);

// ----- cubic-bezier ----- //

/**
 * Кривая Безье как в CSS `cubic-bezier(x1, y1, x2, y2)`: концы в (0, 0) и (1, 1),
 * `x1` и `x2` обязаны лежать в [0, 1], `y` может выходить за пределы.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  if (!(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1)) {
    throw new RangeError(`cubic-bezier: x1 и x2 должны быть в [0, 1], получено ${x1}, ${x2}.`);
  }
  if (!(Number.isFinite(y1) && Number.isFinite(y2))) {
    throw new RangeError(`cubic-bezier: y1 и y2 должны быть конечными, получено ${y1}, ${y2}.`);
  }
  // Прямая линия: возвращается общая функция `linear`.
  if (x1 === y1 && x2 === y2) return linear;

  // Коэффициенты многочлена B(s) = ((a·s + b)·s + c)·s.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  /** Параметр кривой `s`, при котором x(s) = x. Ньютон, а при плохой сходимости — деление пополам. */
  const solve = (x: number) => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(s) - x;
      if (Math.abs(error) < 1e-7) return s;
      const slope = slopeX(s);
      if (Math.abs(slope) < 1e-6) break;
      s -= error / slope;
    }
    let low = 0;
    let high = 1;
    s = x;
    for (let i = 0; i < 40; i++) {
      const value = sampleX(s);
      if (Math.abs(value - x) < 1e-7) return s;
      if (value < x) low = s;
      else high = s;
      s = (low + high) / 2;
    }
    return s;
  };

  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solve(t));
  };
}

/** Кривые CSS по умолчанию. */
export const cssEase = cubicBezier(0.25, 0.1, 0.25, 1);
export const cssEaseIn = cubicBezier(0.42, 0, 1, 1);
export const cssEaseOut = cubicBezier(0, 0, 0.58, 1);
export const cssEaseInOut = cubicBezier(0.42, 0, 0.58, 1);

/** Все именованные кривые. По этим именам плавность будет храниться в документе. */
export const named = {
  linear,
  quadIn,
  quadOut,
  quadInOut,
  cubicIn,
  cubicOut,
  cubicInOut,
  quartIn,
  quartOut,
  quartInOut,
  quintIn,
  quintOut,
  quintInOut,
  sineIn,
  sineOut,
  sineInOut,
  expoIn,
  expoOut,
  expoInOut,
  circIn,
  circOut,
  circInOut,
  backIn,
  backOut,
  backInOut,
  elasticIn,
  elasticOut,
  elasticInOut,
  bounceIn,
  bounceOut,
  bounceInOut,
  cssEase,
  cssEaseIn,
  cssEaseOut,
  cssEaseInOut,
} as const satisfies Record<string, Easing>;

export type EasingName = keyof typeof named;

export function isEasingName(value: string): value is EasingName {
  return Object.hasOwn(named, value);
}

// ----- ступеньки ----- //

/** Где находятся скачки, как в CSS `steps()`: в начале, в конце, на обоих концах или нигде. */
export type StepPosition = 'start' | 'end' | 'both' | 'none';

/**
 * Ступенчатая функция как в CSS `steps(count, position)`. Например, `steps(4)` даёт
 * 0, 0.25, 0.5, 0.75 и 1 только в самом конце. Время вне [0, 1] обрезается.
 */
export function steps(count: number, position: StepPosition = 'end'): Easing {
  const minimum = position === 'none' ? 2 : 1;
  if (!Number.isInteger(count) || count < minimum) {
    throw new RangeError(`steps: число ступенек должно быть целым и не меньше ${minimum}.`);
  }
  const jumps = position === 'both' ? count + 1 : position === 'none' ? count - 1 : count;
  const shift = position === 'start' || position === 'both' ? 1 : 0;
  return (t) => {
    const time = Math.min(1, Math.max(0, t));
    const step = Math.min(jumps, Math.floor(time * count) + shift);
    return step / jumps;
  };
}

// ----- описание кривой в документе ----- //

/** Как плавность записывается в документе: имя кривой или параметры. */
export type EasingSpec =
  | EasingName
  | {
      readonly type: 'cubicBezier';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    }
  | { readonly type: 'steps'; readonly count: number; readonly position?: StepPosition };

/**
 * Функция плавности по описанию из документа. Вызывается при загрузке, а не в каждом
 * кадре. Бросает `RangeError` для неизвестного имени или недопустимых параметров.
 */
export function resolve(spec: EasingSpec): Easing {
  if (typeof spec === 'string') {
    if (!isEasingName(spec)) throw new RangeError(`Неизвестная кривая плавности «${spec}».`);
    return named[spec];
  }
  switch (spec.type) {
    case 'cubicBezier':
      return cubicBezier(spec.x1, spec.y1, spec.x2, spec.y2);
    case 'steps':
      return steps(spec.count, spec.position);
    default:
      throw new RangeError(`Неизвестный тип плавности «${(spec as { type: unknown }).type}».`);
  }
}
