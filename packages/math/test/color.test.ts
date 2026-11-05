import { describe, expect, it } from 'vitest';
import { type Color, color, type Oklab } from '../src/index.ts';
import { expectClose, random } from './helpers.ts';

function parsed(input: string): Color {
  return color.parseOrThrow(input);
}

describe('color: CSS parsing', () => {
  it('hex of all lengths', () => {
    expect(color.toHex(parsed('#f80'))).toBe('#ff8800');
    expect(color.toHex(parsed('#f808'))).toBe('#ff880088');
    expect(color.toHex(parsed('#E0861A'))).toBe('#e0861a');
    expect(parsed('#e0861a80').a).toBeCloseTo(128 / 255);
  });

  it('rgb with commas, spaces, percentages and alpha', () => {
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

  it('oklab and oklch', () => {
    expect(color.toHex(parsed('oklab(0.627955 0.224863 0.125846)'))).toBe('#ff0000');
    expect(color.toHex(parsed('oklab(62.7955% 56.2% 31.5%)'))).toBe('#ff0000');
    expect(color.toHex(parsed('oklch(0.627955 0.25768 29.2339)'))).toBe('#ff0000');
    expect(color.toHex(parsed('oklch(1 0 0 / 0.25)'))).toBe('#ffffff40');
  });

  it('angle units and exponents', () => {
    expect(color.toHex(parsed('hsl(133.3333grad 100% 50%)'))).toBe('#00ff00');
    expect(color.toHex(parsed(`hsl(${Math.PI}rad 100% 50%)`))).toBe('#00ffff');
    expect(color.toHex(parsed('rgb(2.55e2 0 0)'))).toBe('#ff0000');
    expect(color.toHex(parsed('RGB(1E2% 0% 0%)'))).toBe('#ff0000');
  });

  it('none in the modern syntax is treated as zero', () => {
    expect(color.toHex(parsed('rgb(none 128 255)'))).toBe('#0080ff');
    expect(color.toHex(parsed('oklch(1 0 none)'))).toBe('#ffffff');
    expect(color.toHex(parsed('rgb(255 0 0 / none)'))).toBe('#ff000000');
  });

  it('hsl in the modern syntax accepts numbers, s and l are clamped', () => {
    expect(color.toHex(parsed('hsl(120 100 50)'))).toBe('#00ff00');
    expect(color.toHex(parsed('hsl(0 150% 50%)'))).toBe(color.toHex(parsed('hsl(0 100% 50%)')));
  });

  it('oklab and oklch clamp L and negative chroma, chroma in percent', () => {
    expect(color.toHex(parsed('oklab(1.5 0 0)'))).toBe('#ffffff');
    const gray = parsed('oklch(0.5 -0.1 0)');
    expect(gray.r).toBeCloseTo(gray.g, 6);
    expect(gray.g).toBeCloseTo(gray.b, 6);
    expect(color.toHex(parsed('oklch(0.627955 64.42% 29.2339)'))).toBe('#ff0000');
  });

  it('out is unchanged on failure', () => {
    const out = color.create(0.1, 0.2, 0.3, 0.4);
    for (const input of ['rgb(1 2 / 0.5)', 'hsl(1e999 50% 50%)', 'nope', '#12345']) {
      expect(color.parse(input, out)).toBeNull();
      expect(out).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 0.4 });
    }
  });

  it('transparent', () => {
    expect(parsed('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('unparsable strings give null, parseOrThrow throws', () => {
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
      'hsl(10, 20, 30)',
      'rgb(1 2 3 / 4 / 5)',
      'cmyk(0 0 0 0)',
      'rgb(1 2 / 0.5)',
      'rgb(1 2 3 0.5)',
      'rgb(1,2,3,)',
      'rgb(1 2 3 /)',
      'rgb(1e 0 0)',
      'rgb(. 0 0)',
      'rgb(10%, 20, 30)',
      'rgb(none, 0, 0)',
      'hsl(1e999 50% 50%)',
      'oklab(1e999 0 0)',
      'oklab(0.5, 0.1, 0.1)',
      'oklch(0.5, 0.1, 10)',
    ]) {
      expect(color.parse(input), input).toBeNull();
    }
    expect(() => color.parseOrThrow('red')).toThrow(SyntaxError);
  });

  it('parse writes to the given out', () => {
    const out = color.create();
    expect(color.parse('#fff', out)).toBe(out);
  });
});

describe('color: conversions', () => {
  it('sRGB ↔ linear, including values outside [0, 1]', () => {
    expect(color.srgbToLinear(-0.5)).toBe(-color.srgbToLinear(0.5));
    expect(color.linearToSrgb(-0.2)).toBe(-color.linearToSrgb(0.2));
    expect(color.linearToSrgb(color.srgbToLinear(1.2))).toBeCloseTo(1.2, 12);
    expect(color.srgbToLinear(0.5)).toBeCloseTo(0.214041, 6);
    expect(color.linearToSrgb(color.srgbToLinear(0.3))).toBeCloseTo(0.3, 12);
    expect(color.srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 12);
  });

  it('OKLab for reference colours', () => {
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

  it('OKLab round trip preserves the colour', () => {
    const next = random(11);
    const lab = color.createOklab();
    for (let i = 0; i < 200; i++) {
      const c = color.create(next(), next(), next(), next());
      // OKLab matrix coefficients have 10 digits. For dark colours the sRGB curve
      // amplifies this error 12.92 times, to ~1e-6: far below the 1/255 step.
      expectClose(color.fromOklab(color.create(), color.toOklab(lab, c)), c, 5);
    }
  });

  it('fromOklab clamps colours outside the sRGB gamut', () => {
    const out = color.fromOklab(color.create(), { l: 0.9, a: 0.4, b: 0.4, alpha: 2 });
    for (const value of [out.r, out.g, out.b, out.a]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('color: mixing', () => {
  it('ends and midpoint of black and white', () => {
    const black = color.create(0, 0, 0);
    const white = color.create(1, 1, 1);
    expect(color.toHex(color.mix(color.create(), black, white, 0))).toBe('#000000');
    expect(color.toHex(color.mix(color.create(), black, white, 1))).toBe('#ffffff');
    // The OKLab midpoint is lighter than the sRGB midpoint: L = 0.5 → #636363.
    expect(color.toHex(color.mix(color.create(), black, white, 0.5))).toBe('#636363');
  });

  it('colour does not darken when mixing from transparent', () => {
    const red = parsed('#ff0000');
    const half = color.mix(color.create(), parsed('transparent'), red, 0.5);
    expect(color.toHex(half)).toBe('#ff000080');
  });

  it('fully transparent ends give a transparent colour without NaN', () => {
    const out = color.mix(color.create(), color.create(1, 0, 0, 0), color.create(0, 0, 1, 0), 0.5);
    expect(out.a).toBe(0);
    expect(Number.isNaN(out.r)).toBe(false);
  });

  it('mix allows out = argument', () => {
    const a = parsed('#e0861a');
    const b = parsed('#27a');
    const expected = color.mix(color.create(), a, b, 0.3);
    expect(color.mix(a, a, b, 0.3)).toEqual(expected);
  });

  it('mixOklab outside [0, 1] extrapolates linearly and does not blow up the colour', () => {
    const x = color.createOklab(0.2, 0, 0, 1);
    const y = color.createOklab(0.6, 0, 0, 1);
    expect(color.mixOklab(color.createOklab(), x, y, 1.5).l).toBeCloseTo(0.8, 12);
    const faint = color.createOklab(0.5, 0.1, 0, 0.1);
    const solid = color.createOklab(0.6, 0, 0.1, 1);
    const under = color.mixOklab(color.createOklab(), faint, solid, -0.11);
    expect(under.l).toBeCloseTo(0.489, 12);
    expect(under.alpha).toBeCloseTo(0.001, 12);
    const beyond = color.mixOklab(color.createOklab(), faint, solid, -1);
    expect(beyond.alpha).toBe(0);
    expect(Number.isNaN(beyond.l)).toBe(false);
  });

  it('mixOklab allows out = argument', () => {
    const x = color.toOklab(color.createOklab(), parsed('#c25'));
    const y = color.toOklab(color.createOklab(), parsed('#3a8c'));
    const expected = color.mixOklab(color.createOklab(), x, y, 0.6);
    expect(color.mixOklab(y, x, y, 0.6)).toEqual(expected);
  });
});

describe('color: misc', () => {
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

  it('toHex rounds and clamps', () => {
    expect(color.toHex(color.create(1.2, -0.1, 0.5))).toBe('#ff0080');
    expect(color.toHex(color.create(0, 0, 0, 0))).toBe('#00000000');
    expect(color.toHex(color.create(1, 0, 0, 0.999))).toBe('#ff0000');
    expect(color.toHex(color.create(1, 0, 0, 0.99))).toBe('#ff0000fc');
  });

  it('createOklab defaults', () => {
    expect(color.createOklab()).toEqual({ l: 0, a: 0, b: 0, alpha: 1 });
  });

  it('Color and Oklab are not interchangeable', () => {
    const c: Color = color.create();
    const lab: Oklab = color.createOklab();
    // @ts-expect-error Oklab is not a Color.
    const asColor: Color = lab;
    // @ts-expect-error Color is not an Oklab.
    const asLab: Oklab = c;
    expect(asColor).toBe(lab);
    expect(asLab).toBe(c);
  });
});
