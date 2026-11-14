import type { PointerHandler } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { bindPointer, type PointerElement } from '../src/index.ts';

/** An element 200×100 CSS pixels at (10, 20) that shows a 100×50 frame. */
function fakeElement() {
  const target = new EventTarget();
  const captured: number[] = [];
  const element = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) as DOMRect,
    setPointerCapture: (id: number) => captured.push(id),
    style: { touchAction: 'auto' } as CSSStyleDeclaration,
  } satisfies PointerElement;
  const fire = (type: string, clientX = 0, clientY = 0, button = 0) =>
    target.dispatchEvent(
      Object.assign(new Event(type), { clientX, clientY, button, pointerId: 7 }),
    );
  return { element, captured, fire };
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
    fire('pointerdown', 10, 20, 2); // not the main button
    fire('pointerup', 10, 20);
    fire('pointercancel');
    fire('pointerleave');
    expect(a.calls).toEqual(['move 50 25', 'down 100 50', 'up 0 0', 'leave', 'leave']);
    expect(b.calls).toEqual(a.calls);
    expect(captured).toEqual([7]);
    unbind();
    fire('pointermove', 110, 70);
    expect(a.calls).toHaveLength(5);
    expect(element.style.touchAction).toBe('auto');
  });
});
