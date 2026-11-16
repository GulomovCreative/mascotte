// Embedding the player in a page. See docs/PLAN.md, sections 5.9, 5.11, 7 and stage 4.

export {
  bindTickerToPage,
  type IntersectionObserverFactory,
  type PageBindingOptions,
  type PageEnvironment,
  pauseWhenOffscreen,
} from './page.ts';
export {
  Player,
  type PlayerCanvas,
  type PlayerOptions,
  type PointerSpec,
} from './player.ts';
export { bindPointer, type PointerElement } from './pointer.ts';
