import type { PointerHandler } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { bindPointer, type PointerElement } from '../src/index.ts';

const EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'pointerleave',
  'lostpointercapture',
];

/** An element 200×100 CSS pixels at (10, 20) that shows a 100×50 frame. */
function fakeElement() {
  const target = new EventTarget();
  const captured: number[] = [];
  const box = { left: 10, top: 20, width: 200, height: 100 };
  const element = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    getBoundingClientRect: () => ({ ...box }) as DOMRect,
    setPointerCapture: (id: number) => captured.push(id),
    style: { touchAction: 'auto' } as CSSStyleDeclaration,
  } satisfies PointerElement;
  const fire = (
    type: string,
    clientX = 0,
    clientY = 0,
    options: { button?: number; id?: number } = {},
  ) =>
    target.dispatchEvent(
      Object.assign(new Event(type), {
        clientX,
        clientY,
        button: options.button ?? 0,
        pointerId: options.id ?? 7,
      }),
    );
  return { element, box, captured, fire };
}

function recorder() {
  const calls: string[] = [];
  const handler: PointerHandler = {
    down: (x, y) => calls.push(`down ${x} ${y}`),
    move: (x, y) => calls.push(`move ${x} ${y}`),
    up: (x, y) => calls.push(`up ${x} ${y}`),
    leave: () => calls.push('leave'),
  };
  return { calls, handler };
}

describe('bindPointer', () => {
  it('forwards events to every handler in frame units and captures a press', () => {
    const { element, captured, fire } = fakeElement();
    const a = recorder();
    const b = recorder();
    const unbind = bindPointer(element, { width: 100, height: 50 }, a.handler, b.handler);
    expect(element.style.touchAction).toBe('none');
    fire('pointermove', 110, 70);
    fire('pointerdown', 210, 120);
    fire('pointerup', 10, 20);
    fire('lostpointercapture'); // after a release: nothing to end
    fire('pointerdown', 10, 20, { button: 2 }); // not the main button
    fire('pointercancel');
    fire('pointerleave');
    expect(a.calls).toEqual(['move 50 25', 'down 100 50', 'up 0 0', 'leave', 'leave']);
    expect(b.calls).toEqual(a.calls);
    expect(captured).toEqual([7]);
    unbind();
    for (const type of EVENTS) fire(type, 110, 70);
    expect(a.calls).toHaveLength(5);
    expect(element.style.touchAction).toBe('auto');
  });

  it('follows one pointer while a press is held', () => {
    const { element, fire } = fakeElement();
    const a = recorder();
    bindPointer(element, { width: 200, height: 100 }, a.handler);
    fire('pointerdown', 10, 20, { id: 1 });
    fire('pointerdown', 50, 20, { id: 2 });
    fire('pointermove', 60, 20, { id: 2 });
    fire('pointerup', 60, 20, { id: 2 });
    fire('pointerleave', 60, 20, { id: 2 });
    fire('pointermove', 20, 20, { id: 1 });
    fire('pointerup', 20, 20, { id: 1 });
    fire('pointermove', 30, 20, { id: 2 }); // no press held: any pointer hovers
    expect(a.calls).toEqual(['down 0 0', 'move 10 0', 'up 10 0', 'move 20 0']);
  });

  it('a lost capture during a press ends it like a leave', () => {
    const { element, fire } = fakeElement();
    const a = recorder();
    bindPointer(element, { width: 200, height: 100 }, a.handler);
    fire('pointerdown', 10, 20);
    fire('lostpointercapture');
    fire('pointerup', 10, 20, { id: 3 }); // a new pointer is followed again
    expect(a.calls).toEqual(['down 0 0', 'leave', 'up 0 0']);
  });

  it('while the element has no size events end the gesture with a leave', () => {
    const { element, box, captured, fire } = fakeElement();
    const a = recorder();
    bindPointer(element, { width: 200, height: 100 }, a.handler);
    fire('pointerdown', 10, 20);
    box.width = 0;
    fire('pointermove', 30, 20);
    fire('pointerdown', 30, 20);
    expect(a.calls).toEqual(['down 0 0', 'leave', 'leave']);
    expect(captured).toEqual([7]);
  });
});
