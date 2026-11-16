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
  let listening = 0;
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
    addEventListener: (type: string, listener: EventListener) => {
      listening++;
      events.addEventListener(type, listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listening--;
      events.removeEventListener(type, listener);
    },
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
  return {
    canvas: canvas as unknown as PlayerCanvas & typeof canvas,
    pointer,
    pixel,
    surface,
    listening: () => listening,
  };
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

  it('falls back to Canvas 2D without WebGL2, and says so', () => {
    const { canvas, pixel } = fakeCanvas();
    const { ticker } = manualTicker();
    const player = new Player(canvas, json(), { ticker });
    expect(player.renderer).toBe('canvas');
    expect(pixel(150, 100)).toEqual(yellow);
    player.destroy();
    expect(() => new Player(canvas, json(), { renderer: 'webgl', ticker })).toThrow(/WebGL2/);
  });

  it('pauses on an error in a frame or a pointer event, and plays again on play()', () => {
    const { canvas, pointer } = fakeCanvas();
    const { ticker, step } = manualTicker();
    const errors: unknown[] = [];
    const player = new Player(canvas, json(), {
      renderer: 'canvas',
      ticker,
      pointer: { hover: 'hover' },
      onError: (error) => errors.push(error),
    });
    const animator = player.animator;
    const update = animator.update.bind(animator);
    animator.update = () => {
      throw new Error('broken frame');
    };
    step(0.1);
    expect(errors.map(String)).toEqual(['Error: broken frame']);
    expect(player.playing).toBe(false);
    animator.update = update;
    const time = animator.layers[0]?.time ?? 0;
    player.play();
    step(0.5);
    expect(animator.layers[0]?.time).toBeGreaterThan(time + 0.4);
    // A throwing pointer step is reported the same way, not lost in the event listener.
    const inputs = player.inputs;
    const set = inputs.set.bind(inputs);
    inputs.set = () => {
      throw new Error('broken hover');
    };
    // A press tests hover at once, inside the event listener.
    pointer('pointerdown', 120, 120);
    expect(errors.map(String)).toEqual(['Error: broken frame', 'Error: broken hover']);
    step(0.1);
    expect(errors).toHaveLength(2);
    expect(player.playing).toBe(false);
    inputs.set = set;
    player.destroy();
  });

  it('after destroy no frame runs, no listener is left and every call but destroy throws', () => {
    const { canvas, pointer, listening } = fakeCanvas();
    const { ticker, step } = manualTicker();
    let disconnected = 0;
    const player = new Player(canvas, json(), {
      renderer: 'canvas',
      ticker,
      pointer: { hover: 'hover' },
      createObserver: () => ({ observe: () => {}, disconnect: () => disconnected++ }),
    });
    expect(listening()).toBe(6);
    expect(canvas.style.touchAction).toBe('none');
    const animator = player.animator;
    let frames = 0;
    const update = animator.update.bind(animator);
    animator.update = (dt) => {
      frames++;
      update(dt);
    };
    player.destroy();
    player.destroy();
    step(1);
    pointer('pointermove', 120, 120);
    expect(frames).toBe(0);
    expect(ticker.running).toBe(false);
    expect(animator.inputs.get('hover')).toBe(false);
    expect(listening()).toBe(0);
    expect(canvas.style.touchAction).toBe('');
    expect(disconnected).toBe(1);
    for (const call of [
      () => player.render(),
      () => player.play(),
      () => player.pause(),
      () => player.load(json()),
    ]) {
      expect(call).toThrow(/destroyed/);
    }
  });

  it('a constructor that fails leaves nothing bound', () => {
    const { canvas, surface, listening } = fakeCanvas();
    const { ticker } = manualTicker();
    // The first draw fails, after the loop and the pointer are bound.
    const context = surface.getContext('2d');
    context.clearRect = () => {
      throw new Error('no drawing');
    };
    canvas.getContext = (() => context) as never;
    expect(() => new Player(canvas, json(), { renderer: 'canvas', ticker })).toThrow('no drawing');
    expect(ticker.running).toBe(false);
    expect(listening()).toBe(0);
    expect(canvas.style.touchAction).toBe('');
  });

  it('pauses offscreen, apart from play() and pause()', () => {
    const { canvas } = fakeCanvas();
    const { ticker, step } = manualTicker();
    let report: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const observed: unknown[] = [];
    const player = new Player(canvas, json(), {
      renderer: 'canvas',
      ticker,
      createObserver: (callback) => {
        report = callback;
        return { observe: (element) => observed.push(element), disconnect: () => {} };
      },
    });
    expect(observed).toEqual([canvas]);
    const time = () => player.animator.layers[0]?.time ?? 0;
    report([{ isIntersecting: false }]);
    step(0.5);
    expect(time()).toBe(0);
    player.pause();
    player.play();
    step(0.5);
    expect(time()).toBe(0);
    report([{ isIntersecting: true }]);
    step(0.5);
    expect(time()).toBeGreaterThan(0.4);
    player.destroy();
  });

  it('draws and hit-tests in frame units at a device pixel ratio of 2 and on a wide canvas', () => {
    globalThis.devicePixelRatio = 2;
    try {
      const { canvas, pixel, pointer } = fakeCanvas(480, 240);
      const { ticker, step } = manualTicker();
      const player = new Player(canvas, json(), {
        renderer: 'canvas',
        ticker,
        pointer: { hover: 'hover' },
      });
      expect([canvas.width, canvas.height]).toEqual([960, 480]);
      expect(pixel(270, 100)).toEqual(yellow);
      // The sky at the side is not Pip; the middle is.
      pointer('pointermove', 20, 120);
      step(0.2);
      expect(player.inputs.get('hover')).toBe(false);
      pointer('pointermove', 240, 120);
      step(0.2);
      expect(player.inputs.get('hover')).toBe(true);
      player.destroy();
    } finally {
      delete (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
    }
  });

  it('turns the gaze towards the pointer side', () => {
    const { canvas, pointer } = fakeCanvas();
    const { ticker, step } = manualTicker();
    const player = new Player(canvas, json(), { renderer: 'canvas', ticker, gaze: 'gaze' });
    const gaze = player.constraints.get('gaze') as { point: { x: number } | null };
    pointer('pointermove', 40, 120);
    step(1);
    const left = gaze.point?.x ?? 0;
    pointer('pointermove', 200, 120);
    step(1);
    const right = gaze.point?.x ?? 0;
    expect(left).toBeLessThan(0);
    expect(right).toBeGreaterThan(0);
    player.destroy();
  });

  it('loads while paused: draws the new document at once and stays paused', () => {
    const { canvas, pixel } = fakeCanvas();
    const { ticker, step } = manualTicker();
    const player = new Player(canvas, json(), { renderer: 'canvas', ticker, autoplay: false });
    const day = pipDocument();
    player.load({ ...day, view: { ...day.view, background: '#102030' } });
    expect(pixel(5, 5)).toEqual([0x10, 0x20, 0x30, 255]);
    expect(player.playing).toBe(false);
    step(0.5);
    expect(player.animator.layers[0]?.time).toBe(0);
    player.destroy();
  });

  it('shows the frame at its own size on a canvas with no layout size', () => {
    const { canvas, pixel } = fakeCanvas(0, 0);
    const player = new Player(canvas, json(), {
      renderer: 'canvas',
      ticker: manualTicker().ticker,
    });
    expect([canvas.width, canvas.height]).toEqual([240, 240]);
    canvas.clientWidth = 240;
    canvas.clientHeight = 240;
    expect(pixel(150, 100)).toEqual(yellow);
    player.destroy();
  });

  it('refuses pointer inputs and gazes the document does not have, and keeps the running one', () => {
    const { canvas } = fakeCanvas();
    const { ticker } = manualTicker();
    expect(
      () =>
        new Player(canvas, json(), { renderer: 'canvas', ticker, pointer: { hover: 'hovered' } }),
    ).toThrow(/no input "hovered" for the pointer/);
    const day = pipDocument();
    const following = {
      ...day,
      constraints: [{ name: 'gaze', kind: 'aim', target: { slot: 'head' }, at: 'body' }],
    };
    expect(
      () =>
        new Player(canvas, JSON.stringify(following), { renderer: 'canvas', ticker, gaze: 'gaze' }),
    ).toThrow(/must be an aim or lookAt aimed at a point; it follows a node/);
    const player = new Player(canvas, json(), { renderer: 'canvas', ticker, gaze: 'gaze' });
    const running = player.document;
    expect(() => player.load({ ...day, constraints: [] })).toThrow(/no constraint "gaze"/);
    expect(player.document).toBe(running);
    player.destroy();
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

  it('builds the document with the shape parameters it is given', () => {
    const { canvas } = fakeCanvas();
    const day = pipDocument();
    const sized = {
      ...day,
      params: { size: { default: 1, min: 0.5, max: 2 } },
      root: {
        ...day.root,
        props: { ...day.root.props, scale: { param: 'size', times: { x: 1, y: 1, z: 1 } } },
      },
    };
    const options = { renderer: 'canvas', ticker: manualTicker().ticker } as const;
    const plain = new Player(canvas, JSON.stringify(sized), options);
    expect(plain.scene.root.scale.x).toBe(1);
    plain.destroy();
    const big = new Player(canvas, JSON.stringify(sized), { ...options, params: { size: 1.5 } });
    expect(big.scene.root.scale.x).toBe(1.5);
    // A swap keeps the parameters.
    big.load(JSON.stringify(sized));
    expect(big.scene.root.scale.y).toBe(1.5);
    big.destroy();
  });
});
