import { Ticker } from '@mascotte/engine';
import { DocumentError } from '@mascotte/format';
import { Player, type PlayerCanvas } from '@mascotte/player';
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { pip, pipDocument } from '../src/index.ts';

/** A canvas laid out at `cssWidth`×`cssHeight` CSS pixels, drawn by @napi-rs/canvas. */
function fakeCanvas(cssWidth = pip.width, cssHeight = pip.height) {
  const surface = createCanvas(1, 1);
  const events = new EventTarget();
  const canvas = {
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    get width() {
      return surface.width;
    },
    set width(value: number) {
      surface.width = value;
    },
    get height() {
      return surface.height;
    },
    set height(value: number) {
      surface.height = value;
    },
    getContext: (kind: string) => (kind === '2d' ? surface.getContext('2d') : null),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    getBoundingClientRect: () =>
      ({ left: 0, top: 0, width: canvas.clientWidth, height: canvas.clientHeight }) as DOMRect,
    setPointerCapture: () => {},
    style: { touchAction: '' } as CSSStyleDeclaration,
  };
  const pointer = (type: string, x: number, y: number) =>
    events.dispatchEvent(
      Object.assign(new Event(type), { clientX: x, clientY: y, button: 0, pointerId: 1 }),
    );
  /** RGBA of the pixel at CSS point (x, y). */
  const pixel = (x: number, y: number) => {
    const ratio = surface.width / canvas.clientWidth;
    const data = surface.getContext('2d').getImageData(x * ratio, y * ratio, 1, 1).data;
    return [...data];
  };
  return { canvas: canvas as unknown as PlayerCanvas & typeof canvas, pointer, pixel };
}

/** A ticker whose frames come when the test steps it. */
function manualTicker() {
  let pending: ((now: number) => void) | null = null;
  let now = 0;
  const ticker = new Ticker({
    scheduler: {
      request: (callback) => {
        pending = callback;
        return 1;
      },
      cancel: () => {
        pending = null;
      },
    },
  });
  const step = (seconds: number, frames = Math.round(seconds * 60)) => {
    for (let i = 0; i < frames; i++) {
      now += 1000 / 60;
      const callback = pending;
      pending = null;
      callback?.(now);
    }
  };
  return { ticker, step };
}

const json = () => JSON.stringify(pipDocument());
const yellow = [0xff, 0xd5, 0x4a, 255];
const sky = [0xe6, 0xf0, 0xff, 255];

describe('Player', () => {
  it('reads a document, draws it at once and plays it on its ticker', () => {
    const { canvas, pixel } = fakeCanvas();
    const { ticker, step } = manualTicker();
    const player = new Player(canvas, json(), { renderer: 'canvas', ticker });
    // The frame fits the canvas: 240×240 CSS pixels at ratio 1, Pip's body in the middle.
    expect([canvas.width, canvas.height]).toEqual([240, 240]);
    expect(pixel(5, 5)).toEqual(sky);
    expect(pixel(150, 100)).toEqual(yellow);
    const emotion = player.machines[0];
    player.inputs.set('hover', true);
    step(0.5);
    expect(emotion?.state).toBe('happy');
    player.inputs.fire('poke');
    step(0.1);
    expect(emotion?.state).toBe('surprised');
    player.destroy();
  });

  it('fits the frame into any canvas size, centered and whole', () => {
    const { canvas, pixel } = fakeCanvas(480, 240);
    const player = new Player(canvas, json(), {
      renderer: 'canvas',
      ticker: manualTicker().ticker,
    });
    expect([canvas.width, canvas.height]).toEqual([480, 240]);
    // The extra width is background on both sides; the body stays in the middle.
    expect(pixel(10, 120)).toEqual(sky);
    expect(pixel(270, 100)).toEqual(yellow);
    canvas.clientWidth = 120;
    canvas.clientHeight = 120;
    player.render();
    expect([canvas.width, canvas.height]).toEqual([120, 120]);
    expect(pixel(75, 50)).toEqual(yellow);
    player.destroy();
  });

  it('lets the pointer cheer it up, poke it, turn its head and its body', () => {
    const { canvas, pointer } = fakeCanvas();
    const { ticker, step } = manualTicker();
    const player = new Player(canvas, json(), {
      renderer: 'canvas',
      ticker,
      pointer: { hover: 'hover', click: 'poke' },
      gaze: 'gaze',
      turn: { settle: 0.5 },
    });
    const emotion = player.machines[0];
    const gaze = player.constraints.get('gaze');
    const root = player.scene.root;
    const rest = root.rotation.y;
    pointer('pointermove', 120, 120);
    step(0.5);
    expect(emotion?.state).toBe('happy');
    expect(gaze?.weight).toBeGreaterThan(0.9);
    pointer('pointerdown', 120, 120);
    pointer('pointerup', 120, 120);
    step(0.1);
    expect(emotion?.state).toBe('surprised');
    pointer('pointerdown', 120, 120);
    pointer('pointermove', 180, 120);
    expect(root.rotation.y).not.toBeCloseTo(rest);
    pointer('pointerup', 180, 120);
    pointer('pointerleave', 0, 0);
    step(5);
    expect(emotion?.state).toBe('calm');
    expect(gaze?.weight).toBeLessThan(0.01);
    expect(root.rotation.y).toBeCloseTo(rest, 3);
    player.destroy();
  });

  it('pauses and plays, and a click while paused pokes nothing', () => {
    const { canvas, pointer } = fakeCanvas();
    const { ticker, step } = manualTicker();
    const player = new Player(canvas, json(), {
      renderer: 'canvas',
      ticker,
      pointer: { click: 'poke' },
      autoplay: false,
    });
    expect(player.playing).toBe(false);
    pointer('pointerdown', 120, 120);
    pointer('pointerup', 120, 120);
    step(0.5);
    expect(player.animator.layers[0]?.time).toBe(0);
    player.play();
    step(0.5);
    expect(player.machines[0]?.state).toBe('calm');
    expect(player.animator.layers[0]?.time).toBeGreaterThan(0.4);
    player.destroy();
  });

  it('swaps the document in place, and keeps the running one when the new one is bad', () => {
    const { canvas, pixel, pointer } = fakeCanvas();
    const { ticker, step } = manualTicker();
    const player = new Player(canvas, json(), {
      renderer: 'canvas',
      ticker,
      pointer: { hover: 'hover' },
    });
    const day = pipDocument();
    player.load({ ...day, view: { ...day.view, background: '#102030' } });
    expect(pixel(5, 5)).toEqual([0x10, 0x20, 0x30, 255]);
    // The pointer, inputs and loop now drive the new document.
    pointer('pointermove', 120, 120);
    step(0.5);
    expect(player.machines[0]?.state).toBe('happy');
    const running = player.document;
    expect(() => player.load('{"format": "mascotte", "version": 1}')).toThrow(DocumentError);
    expect(player.document).toBe(running);
    player.destroy();
  });

  it('falls back to Canvas 2D without WebGL2, stops on a frame error and is gone after destroy', () => {
    const { canvas, pointer } = fakeCanvas();
    const { ticker, step } = manualTicker();
    const errors: unknown[] = [];
    const player = new Player(canvas, json(), {
      ticker,
      pointer: { hover: 'hover' },
      onError: (error) => errors.push(error),
    });
    const spring = player.animator;
    const update = spring.update.bind(spring);
    spring.update = () => {
      throw new Error('broken frame');
    };
    step(0.1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/broken frame/);
    spring.update = update;
    player.destroy();
    player.destroy();
    pointer('pointermove', 120, 120);
    expect(() => player.render()).toThrow(/destroyed/);
    expect(() => new Player(canvas, json(), { renderer: 'webgl', ticker })).toThrow();
  });

  it('refuses a gaze the document does not have', () => {
    const { canvas } = fakeCanvas();
    expect(
      () =>
        new Player(canvas, json(), {
          renderer: 'canvas',
          ticker: manualTicker().ticker,
          gaze: 'eyes',
        }),
    ).toThrow(/no constraint "eyes"/);
  });
});
