import {
  Camera,
  CanvasRenderer,
  type Viewport as Frame,
  Scene,
  WebGLRenderer,
} from '@mascotte/engine';
import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { state } from './store.ts';

/** Draws `scene` from `camera` in `frame`, anew. */
type Draw = (scene: Scene, camera: Camera, frame: Frame) => void;

/**
 * A renderer for the canvas: WebGL2, or Canvas 2D where the browser has no WebGL2. A canvas that
 * gives a WebGL2 context cannot give a 2D one afterwards, so a WebGL renderer that fails to start
 * there is an error, not a fallback.
 */
function rendererFor(canvas: HTMLCanvasElement): { draw: Draw; destroy: () => void } {
  const probe = document.createElement('canvas').getContext('webgl2');
  if (probe) {
    probe.getExtension('WEBGL_lose_context')?.loseContext();
    let gl: WebGLRenderer;
    try {
      gl = new WebGLRenderer(canvas);
    } catch (error) {
      throw new Error('The viewport could not start WebGL2.', { cause: error });
    }
    return {
      draw: (scene, camera, frame) => {
        // A canvas given its size again is cleared: the frame must be drawn anew.
        gl.invalidate();
        gl.render(scene, camera, frame);
      },
      destroy: () => gl.destroy(),
    };
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The viewport has neither WebGL2 nor a 2D context.');
  const canvas2d = new CanvasRenderer();
  return {
    draw: (scene, camera, frame) => canvas2d.render(ctx, scene, camera, frame),
    destroy: () => {},
  };
}

/**
 * The viewport: the open document's scene (the last that built), drawn by the engine through
 * the document's camera, centered in the panel and fitted to it; redrawn when the document
 * changes. The orbit camera, picking and the debug view come with #88.
 */
export function Viewport() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = rendererFor(canvas);
    const empty = new Scene();
    const fallback = new Camera();
    const fit = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      // Not laid out (or gone): nothing to draw on.
      if (!(width > 0 && height > 0)) return;
      const ratio = devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.round(width * ratio));
      const pixelHeight = Math.max(1, Math.round(height * ratio));
      // Sized only when the size changes: sizing clears and reallocates the canvas.
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      const built = state.peek().scene;
      // The built scene's view: validated, unlike the document while it has issues.
      const background = built?.built.view.background;
      renderer.draw(built?.scene ?? empty, built?.built.camera ?? fallback, {
        width,
        height,
        pixelRatio: ratio,
        ...(background === undefined ? {} : { background }),
      });
    };
    // Redrawn whenever the state changes (a new scene, an edit).
    const stop = effect(() => {
      void state.value;
      fit();
    });
    // It also fires once on observing: the first fit.
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    // Moved to a screen of another pixel ratio, the canvas keeps its size: fit it again.
    let ratio: MediaQueryList | null = null;
    const watchRatio = () => {
      ratio?.removeEventListener('change', onRatio);
      ratio = matchMedia(`(resolution: ${devicePixelRatio || 1}dppx)`);
      ratio.addEventListener('change', onRatio);
    };
    const onRatio = () => {
      watchRatio();
      fit();
    };
    watchRatio();
    return () => {
      stop();
      observer.disconnect();
      ratio?.removeEventListener('change', onRatio);
      renderer.destroy();
    };
  }, []);
  return <canvas ref={ref} class="viewport" />;
}
