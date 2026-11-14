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
 * Only the main button presses. One pointer at a time: while a press is held, other pointers
 * (a second finger) are ignored; without a press every pointer hovers. A press captures the
 * pointer, so a drag goes on outside the element, and losing the capture ends it like a leave.
 * While the element has no size, events end the gesture with a leave. `touch-action: none` is
 * set while bound, so a touch drag goes to the handlers instead of scrolling the page. Returns
 * a function that removes the listeners and restores `touch-action`.
 */
export function bindPointer(
  element: PointerElement,
  frame: HitViewport,
  ...handlers: PointerHandler[]
): () => void {
  const touchAction = element.style.touchAction;
  element.style.touchAction = 'none';
  // The pointer whose press is held, or null.
  let active: number | null = null;
  const leave = () => {
    active = null;
    for (const handler of handlers) handler.leave();
  };
  const forward = (
    event: PointerEvent,
    call: (handler: PointerHandler, x: number, y: number) => void,
  ) => {
    const box = element.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) {
      leave();
      return;
    }
    const x = ((event.clientX - box.left) * frame.width) / box.width;
    const y = ((event.clientY - box.top) * frame.height) / box.height;
    for (const handler of handlers) call(handler, x, y);
  };
  const mine = (event: PointerEvent) => active === null || event.pointerId === active;
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || active !== null) return;
    active = event.pointerId;
    forward(event, (handler, x, y) => handler.down(x, y));
    if (active !== null) element.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (mine(event)) forward(event, (handler, x, y) => handler.move(x, y));
  };
  const up = (event: PointerEvent) => {
    if (!mine(event)) return;
    active = null;
    forward(event, (handler, x, y) => handler.up(x, y));
  };
  const end = (event: PointerEvent) => {
    if (mine(event)) leave();
  };
  // After a normal release `active` is already null; otherwise the press was cut off.
  const lost = (event: PointerEvent) => {
    if (active !== null && event.pointerId === active) leave();
  };
  const listeners = [
    ['pointerdown', down],
    ['pointermove', move],
    ['pointerup', up],
    ['pointercancel', end],
    ['pointerleave', end],
    ['lostpointercapture', lost],
  ] as const;
  for (const [type, listener] of listeners) element.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of listeners) element.removeEventListener(type, listener);
    element.style.touchAction = touchAction;
  };
}
