import type { HitViewport, PointerHandler } from '@mascotte/engine';

/** What is needed from the element: its pointer events, its box and pointer capture. */
export type PointerElement = Pick<
  HTMLElement,
  | 'addEventListener'
  | 'removeEventListener'
  | 'getBoundingClientRect'
  | 'setPointerCapture'
  | 'style'
>;

/**
 * Forwards the pointer events of an element that shows a frame (a canvas) to handlers, in
 * frame units from its top left corner (`frame` is the frame size, the element may be scaled).
 * A press captures the pointer, so a drag goes on outside the element; `touch-action: none` is
 * set while bound, so a touch drags the mascot instead of scrolling the page. Returns a function
 * that removes the listeners and restores `touch-action`.
 */
export function bindPointer(
  element: PointerElement,
  frame: HitViewport,
  ...handlers: PointerHandler[]
): () => void {
  const touchAction = element.style.touchAction;
  element.style.touchAction = 'none';
  const forward = (
    event: PointerEvent,
    call: (handler: PointerHandler, x: number, y: number) => void,
  ) => {
    const box = element.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return;
    const x = ((event.clientX - box.left) * frame.width) / box.width;
    const y = ((event.clientY - box.top) * frame.height) / box.height;
    for (const handler of handlers) call(handler, x, y);
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    element.setPointerCapture(event.pointerId);
    forward(event, (handler, x, y) => handler.down(x, y));
  };
  const move = (event: PointerEvent) => forward(event, (handler, x, y) => handler.move(x, y));
  const up = (event: PointerEvent) => forward(event, (handler, x, y) => handler.up(x, y));
  const leave = () => {
    for (const handler of handlers) handler.leave();
  };
  const listeners = [
    ['pointerdown', down],
    ['pointermove', move],
    ['pointerup', up],
    ['pointercancel', leave],
    ['pointerleave', leave],
  ] as const;
  for (const [type, listener] of listeners) element.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of listeners) element.removeEventListener(type, listener);
    element.style.touchAction = touchAction;
  };
}
