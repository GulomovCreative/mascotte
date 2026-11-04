import { clamp } from './common.ts';

/**
 * Цвет в sRGB: компоненты и непрозрачность от 0 до 1, без предумножения на альфу.
 * Так цвет задаётся в документе и передаётся в canvas. Для смешивания цвета
 * переводятся в OKLab, где интерполяция выглядит равномерной на глаз.
 */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Цвет в OKLab: светлота `l` от 0 до 1, оси `a` (зелёный–красный) и `b` (синий–жёлтый).
 * Здесь `a` — это ось цвета, а непрозрачность хранится в `alpha`, в отличие от `Color.a`.
 */
export interface Oklab {
  l: number;
  a: number;
  b: number;
  alpha: number;
}

/*
 * Все операции пишут результат в `out` и возвращают его. `out` может совпадать
 * с любым из аргументов.
 */

export function create(r = 0, g = 0, b = 0, a = 1): Color {
  return { r, g, b, a };
}

export function clone(c: Readonly<Color>): Color {
  return { r: c.r, g: c.g, b: c.b, a: c.a };
}

export function set(out: Color, r: number, g: number, b: number, a = 1): Color {
  out.r = r;
  out.g = g;
  out.b = b;
  out.a = a;
  return out;
}

export function copy(out: Color, c: Readonly<Color>): Color {
  return set(out, c.r, c.g, c.b, c.a);
}

export function equals(x: Readonly<Color>, y: Readonly<Color>, epsilon = 1 / 512): boolean {
  return (
    Math.abs(x.r - y.r) <= epsilon &&
    Math.abs(x.g - y.g) <= epsilon &&
    Math.abs(x.b - y.b) <= epsilon &&
    Math.abs(x.a - y.a) <= epsilon
  );
}

// ----- sRGB ↔ линейный RGB ↔ OKLab ----- //

/** Компонента sRGB → линейная яркость. */
export function srgbToLinear(value: number): number {
  const abs = Math.abs(value);
  const linear = abs <= 0.04045 ? abs / 12.92 : ((abs + 0.055) / 1.055) ** 2.4;
  return value < 0 ? -linear : linear;
}

/** Линейная яркость → компонента sRGB. */
export function linearToSrgb(value: number): number {
  const abs = Math.abs(value);
  const srgb = abs <= 0.0031308 ? abs * 12.92 : 1.055 * abs ** (1 / 2.4) - 0.055;
  return value < 0 ? -srgb : srgb;
}

export function createOklab(l = 0, a = 0, b = 0, alpha = 1): Oklab {
  return { l, a, b, alpha };
}

/** sRGB → OKLab (матрицы из описания OKLab, Björn Ottosson, 2020). */
export function toOklab(out: Oklab, c: Readonly<Color>): Oklab {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out.alpha = c.a;
  out.l = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out.a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out.b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return out;
}

/** OKLab → sRGB. Цвета вне охвата sRGB обрезаются до [0, 1] по каждой компоненте. */
export function fromOklab(out: Color, lab: Readonly<Oklab>): Color {
  const l = (lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
  const m = (lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
  const s = (lab.l - 0.0894841775 * lab.a - 1.291485548 * lab.b) ** 3;
  const alpha = lab.alpha;
  out.r = clamp(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), 0, 1);
  out.g = clamp(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), 0, 1);
  out.b = clamp(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), 0, 1);
  out.a = clamp(alpha, 0, 1);
  return out;
}

/**
 * Интерполяция в OKLab с предумножением на альфу, как в CSS `color-mix`.
 * Поэтому переход из прозрачного цвета не темнеет и не сереет.
 *
 * При `t` вне [0, 1] (недолёт и перелёт кривых `back`, `elastic`) компоненты
 * продолжаются линейно без предумножения, а альфа обрезается до [0, 1]: деление
 * на почти нулевую альфу раздуло бы цвет.
 */
export function mixOklab(out: Oklab, x: Readonly<Oklab>, y: Readonly<Oklab>, t: number): Oklab {
  const xa = x.alpha;
  const ya = y.alpha;
  const alpha = xa + (ya - xa) * t;
  if (t < 0 || t > 1 || alpha <= 0) {
    out.l = x.l + (y.l - x.l) * t;
    out.a = x.a + (y.a - x.a) * t;
    out.b = x.b + (y.b - x.b) * t;
    out.alpha = clamp(alpha, 0, 1);
    return out;
  }
  const inv = 1 / alpha;
  out.l = (x.l * xa + (y.l * ya - x.l * xa) * t) * inv;
  out.a = (x.a * xa + (y.a * ya - x.a * xa) * t) * inv;
  out.b = (x.b * xa + (y.b * ya - x.b * xa) * t) * inv;
  out.alpha = alpha;
  return out;
}

const mixX = createOklab();
const mixY = createOklab();

/**
 * Смешивает цвета в OKLab. Для анимации, где концы не меняются, выгоднее один раз
 * перевести их через `toOklab` и вызывать `mixOklab` и `fromOklab`.
 */
export function mix(out: Color, x: Readonly<Color>, y: Readonly<Color>, t: number): Color {
  toOklab(mixX, x);
  toOklab(mixY, y);
  return fromOklab(out, mixOklab(mixX, mixX, mixY, t));
}

// ----- разбор и вывод CSS ----- //

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTION = /^(rgba?|hsla?|oklab|oklch)\(\s*(.*?)\s*\)$/i;

/**
 * Разбирает цвет CSS и возвращает `null`, если строку разобрать нельзя. В этом случае
 * `out` не меняется.
 *
 * Поддерживается:
 * - `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` и `transparent`;
 * - `rgb()`/`rgba()` и `hsl()`/`hsla()` в старом синтаксисе через запятые (без `none`,
 *   каналы `rgb` либо все числами, либо все в процентах);
 * - `rgb()`, `hsl()`, `oklab()`, `oklch()` в новом синтаксисе через пробелы, с альфой
 *   через `/` и ключевым словом `none` (считается нулём);
 * - проценты, числа с экспонентой, единицы угла `deg`, `grad`, `rad`, `turn`.
 *
 * Других именованных цветов, кроме `transparent`, нет: редактор пишет hex.
 */
export function parse(input: string, out: Color = create()): Color | null {
  const text = input.trim().toLowerCase();
  if (text === 'transparent') return set(out, 0, 0, 0, 0);

  const hex = HEX.exec(text)?.[1];
  if (hex) return parseHex(out, hex);

  const match = FUNCTION.exec(text);
  if (!match) return null;
  const name = match[1] ?? '';
  const isRgb = name.startsWith('rgb');
  const isHsl = name.startsWith('hsl');
  const body = match[2] ?? '';
  const legacy = body.includes(',');
  if (legacy && !isRgb && !isHsl) return null;
  const args = legacy ? splitLegacy(body) : splitModern(body);
  if (!args) return null;
  const [first = '', second = '', third = '', fourth] = args;
  const alpha = fourth === undefined ? 1 : parseAlpha(fourth, legacy);
  if (alpha === null) return null;

  if (isRgb) {
    if (legacy && new Set(args.slice(0, 3).map((arg) => arg.endsWith('%'))).size > 1) return null;
    const r = parseChannel(first, legacy);
    const g = parseChannel(second, legacy);
    const b = parseChannel(third, legacy);
    if (r === null || g === null || b === null) return null;
    return set(out, r, g, b, alpha);
  }
  if (isHsl) {
    const h = parseHue(first, legacy);
    // В старом синтаксисе s и l обязаны быть процентами, в новом допускаются числа 0–100.
    const s = legacy ? parsePercent(second) : parseNumberOrPercent(second, 100, legacy);
    const l = legacy ? parsePercent(third) : parseNumberOrPercent(third, 100, legacy);
    if (h === null || s === null || l === null) return null;
    const scale = legacy ? 1 : 1 / 100;
    return hslToRgb(out, h, clamp(s * scale, 0, 1), clamp(l * scale, 0, 1), alpha);
  }
  const l = parseNumberOrPercent(first, 1, legacy);
  if (l === null) return null;
  const lightness = clamp(l, 0, 1);
  if (name === 'oklab') {
    const a = parseNumberOrPercent(second, 0.4, legacy);
    const b = parseNumberOrPercent(third, 0.4, legacy);
    if (a === null || b === null) return null;
    return fromOklab(out, { l: lightness, a, b, alpha });
  }
  const chroma = parseNumberOrPercent(second, 0.4, legacy);
  const hue = parseHue(third, legacy);
  if (chroma === null || hue === null) return null;
  const c = Math.max(0, chroma);
  const angle = (hue / 180) * Math.PI;
  return fromOklab(out, { l: lightness, a: c * Math.cos(angle), b: c * Math.sin(angle), alpha });
}

/** Разбирает цвет CSS и бросает ошибку, если это не удалось. */
export function parseOrThrow(input: string, out: Color = create()): Color {
  const result = parse(input, out);
  if (!result) throw new SyntaxError(`Не удалось разобрать цвет «${input}».`);
  return result;
}

function parseHex(out: Color, hex: string): Color {
  const short = hex.length <= 4;
  const digit = (i: number) =>
    short
      ? Number.parseInt(hex.charAt(i).repeat(2), 16)
      : Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const alpha = hex.length === 4 || hex.length === 8 ? digit(3) / 255 : 1;
  return set(out, digit(0) / 255, digit(1) / 255, digit(2) / 255, alpha);
}

/** Старый синтаксис: `1, 2, 3` или `1, 2, 3, 0.5`. */
function splitLegacy(body: string): string[] | null {
  if (body.includes('/')) return null;
  const parts = body.split(',').map((part) => part.trim());
  return parts.length === 3 || parts.length === 4 ? parts : null;
}

/** Новый синтаксис: ровно три компонента через пробелы и, возможно, `/ альфа`. */
function splitModern(body: string): string[] | null {
  const [main = '', alpha, extra] = body.split('/');
  if (extra !== undefined) return null;
  const parts = main.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  if (alpha !== undefined) parts.push(alpha.trim());
  return parts;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/;

function parseNumber(text: string): number | null {
  if (!NUMBER.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function parsePercent(text: string): number | null {
  if (!text.endsWith('%')) return null;
  const value = parseNumber(text.slice(0, -1));
  return value === null ? null : value / 100;
}

/** Число, процент (100% соответствует `full`) или `none` в новом синтаксисе. */
function parseNumberOrPercent(text: string, full: number, legacy: boolean): number | null {
  if (text === 'none') return legacy ? null : 0;
  if (text.endsWith('%')) {
    const percent = parsePercent(text);
    return percent === null ? null : percent * full;
  }
  return parseNumber(text);
}

/** Канал rgb: число 0–255 или процент. */
function parseChannel(text: string, legacy: boolean): number | null {
  if (text.endsWith('%')) {
    const percent = parsePercent(text);
    return percent === null ? null : clamp(percent, 0, 1);
  }
  const value = parseNumberOrPercent(text, 1, legacy);
  return value === null ? null : clamp(value / 255, 0, 1);
}

function parseAlpha(text: string, legacy: boolean): number | null {
  const value = parseNumberOrPercent(text, 1, legacy);
  return value === null ? null : clamp(value, 0, 1);
}

const HUE_UNITS: readonly (readonly [string, number])[] = [
  ['deg', 1],
  // `grad` проверяется раньше `rad`: строка с `grad` тоже оканчивается на `rad`.
  ['grad', 0.9],
  ['rad', 180 / Math.PI],
  ['turn', 360],
];

/** Угол в градусах: число, `deg`, `grad`, `rad`, `turn` или `none` в новом синтаксисе. */
function parseHue(text: string, legacy: boolean): number | null {
  if (text === 'none') return legacy ? null : 0;
  for (const [unit, factor] of HUE_UNITS) {
    if (text.endsWith(unit)) {
      const value = parseNumber(text.slice(0, -unit.length));
      return value === null ? null : value * factor;
    }
  }
  return parseNumber(text);
}

function hslToRgb(out: Color, hue: number, s: number, l: number, alpha: number): Color {
  const h = (((hue % 360) + 360) % 360) / 30;
  const k = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const p = (n + h) % 12;
    return l - k * Math.max(-1, Math.min(p - 3, 9 - p, 1));
  };
  return set(out, channel(0), channel(8), channel(4), alpha);
}

const HEX_DIGITS = '0123456789abcdef';

function hexByte(value: number): string {
  const byte = Math.round(clamp(value, 0, 1) * 255);
  return HEX_DIGITS.charAt(byte >> 4) + HEX_DIGITS.charAt(byte & 15);
}

/** Цвет в виде `#rrggbb` или `#rrggbbaa`, если альфа после округления до байта меньше `ff`. */
export function toHex(c: Readonly<Color>): string {
  const hex = `#${hexByte(c.r)}${hexByte(c.g)}${hexByte(c.b)}`;
  const alpha = hexByte(c.a);
  return alpha === 'ff' ? hex : hex + alpha;
}
