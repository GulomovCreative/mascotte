import { describe, expect, it } from 'vitest';
import { type Color, color } from '../src/index.ts';
import { expectClose, random } from './helpers.ts';

function parsed(input: string): Color {
  return color.parseOrThrow(input);
}

describe('color: разбор CSS', () => {
  it('hex всех длин', () => {
    expect(color.toHex(parsed('#f80'))).toBe('#ff8800');
    expect(color.toHex(parsed('#f808'))).toBe('#ff880088');
    expect(color.toHex(parsed('#E0861A'))).toBe('#e0861a');
    expect(parsed('#e0861a80').a).toBeCloseTo(128 / 255);
  });

  it('rgb через запятые, пробелы, проценты и альфу', () => {
    expect(color.toHex(parsed('rgb(255, 136, 0)'))).toBe('#ff8800');
    expect(color.toHex(parsed('rgba(255,136,0,0.5)'))).toBe('#ff880080');
    expect(color.toHex(parsed('rgb(255 136 0 / 50%)'))).toBe('#ff880080');
    expect(color.toHex(parsed('rgb(100% 0% 50%)'))).toBe('#ff0080');
    expect(color.toHex(parsed('  RGB( 300 -5 0 ) '))).toBe('#ff0000');
  });

  it('hsl', () => {
    expect(color.toHex(parsed('hsl(120, 100%, 50%)'))).toBe('#00ff00');
    expect(color.toHex(parsed('hsl(0 100% 25%)'))).toBe('#800000');
    expect(color.toHex(parsed('hsla(0.5turn 100% 50% / 0.5)'))).toBe('#00ffff80');
    expect(color.toHex(parsed('hsl(-120deg 100% 50%)'))).toBe('#0000ff');
  });

  it('oklab и oklch', () => {
    expect(color.toHex(parsed('oklab(0.627955 0.224863 0.125846)'))).toBe('#ff0000');
    expect(color.toHex(parsed('oklab(62.7955% 56.2% 31.5%)'))).toBe('#ff0000');
    expect(color.toHex(parsed('oklch(0.627955 0.25768 29.2339)'))).toBe('#ff0000');
    expect(color.toHex(parsed('oklch(1 0 0 / 0.25)'))).toBe('#ffffff40');
  });

  it('transparent', () => {
    expect(parsed('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('неразборчивые строки дают null, parseOrThrow бросает', () => {
    for (const input of [
      '',
      'red',
      '#12',
      '#12345',
      '#ggg',
      'rgb(1, 2)',
      'rgb(1 2 3 4 5)',
      'rgb(1, 2, 3 / 4)',
      'rgb(a b c)',
      'hsl(10 20 30)',
      'rgb(1 2 3 / 4 / 5)',
      'cmyk(0 0 0 0)',
    ]) {
      expect(color.parse(input), input).toBeNull();
    }
    expect(() => color.parseOrThrow('red')).toThrow(SyntaxError);
  });

  it('parse пишет в переданный out', () => {
    const out = color.create();
    expect(color.parse('#fff', out)).toBe(out);
  });
});

describe('color: преобразования', () => {
  it('sRGB ↔ линейный', () => {
    expect(color.srgbToLinear(0.5)).toBeCloseTo(0.214041, 6);
    expect(color.linearToSrgb(color.srgbToLinear(0.3))).toBeCloseTo(0.3, 12);
    expect(color.srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 12);
  });

  it('OKLab для опорных цветов', () => {
    const lab = color.createOklab();
    expectClose(color.toOklab(lab, color.create(1, 1, 1)), { l: 1, a: 0, b: 0, alpha: 1 }, 5);
    expectClose(
      color.toOklab(lab, color.create(1, 0, 0)),
      { l: 0.627955, a: 0.224863, b: 0.125846, alpha: 1 },
      5,
    );
    expectClose(
      color.toOklab(lab, color.create(0, 0, 1, 0.5)),
      { l: 0.452014, a: -0.032457, b: -0.311528, alpha: 0.5 },
      5,
    );
  });

  it('OKLab туда и обратно сохраняет цвет', () => {
    const next = random(11);
    const lab = color.createOklab();
    for (let i = 0; i < 200; i++) {
      const c = color.create(next(), next(), next(), next());
      // Коэффициенты матриц OKLab даны с 10 знаками. У тёмных цветов кривая sRGB
      // усиливает эту ошибку в 12.92 раза, до ~1e-6: это намного меньше шага 1/255.
      expectClose(color.fromOklab(color.create(), color.toOklab(lab, c)), c, 5);
    }
  });

  it('fromOklab обрезает цвета вне охвата sRGB', () => {
    const out = color.fromOklab(color.create(), { l: 0.9, a: 0.4, b: 0.4, alpha: 2 });
    for (const value of [out.r, out.g, out.b, out.a]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('color: смешивание', () => {
  it('концы и середина чёрного и белого', () => {
    const black = color.create(0, 0, 0);
    const white = color.create(1, 1, 1);
    expect(color.toHex(color.mix(color.create(), black, white, 0))).toBe('#000000');
    expect(color.toHex(color.mix(color.create(), black, white, 1))).toBe('#ffffff');
    // Середина по OKLab светлее середины sRGB: L = 0.5 → #636363.
    expect(color.toHex(color.mix(color.create(), black, white, 0.5))).toBe('#636363');
  });

  it('из прозрачного цвет не темнеет', () => {
    const red = parsed('#ff0000');
    const half = color.mix(color.create(), parsed('transparent'), red, 0.5);
    expect(color.toHex(half)).toBe('#ff000080');
  });

  it('полностью прозрачные концы дают прозрачный цвет без NaN', () => {
    const out = color.mix(color.create(), color.create(1, 0, 0, 0), color.create(0, 0, 1, 0), 0.5);
    expect(out.a).toBe(0);
    expect(Number.isNaN(out.r)).toBe(false);
  });

  it('mix допускает out = аргумент', () => {
    const a = parsed('#e0861a');
    const b = parsed('#27a');
    const expected = color.mix(color.create(), a, b, 0.3);
    expect(color.mix(a, a, b, 0.3)).toEqual(expected);
  });

  it('mixOklab допускает out = аргумент', () => {
    const x = color.toOklab(color.createOklab(), parsed('#c25'));
    const y = color.toOklab(color.createOklab(), parsed('#3a8c'));
    const expected = color.mixOklab(color.createOklab(), x, y, 0.6);
    expect(color.mixOklab(y, x, y, 0.6)).toEqual(expected);
  });
});

describe('color: прочее', () => {
  it('create, clone, set, copy, equals', () => {
    expect(color.create()).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    const c = color.set(color.create(), 0.1, 0.2, 0.3, 0.4);
    const d = color.clone(c);
    d.r = 1;
    expect(c.r).toBe(0.1);
    expect(color.copy(color.create(), c)).toEqual(c);
    expect(color.equals(c, color.create(0.1, 0.2, 0.3 + 1e-4, 0.4))).toBe(true);
    expect(color.equals(c, color.create(0.1, 0.2, 0.31, 0.4))).toBe(false);
  });

  it('toHex округляет и обрезает', () => {
    expect(color.toHex(color.create(1.2, -0.1, 0.5))).toBe('#ff0080');
    expect(color.toHex(color.create(0, 0, 0, 0))).toBe('#00000000');
  });
});
