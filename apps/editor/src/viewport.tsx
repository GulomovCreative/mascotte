import { Camera, CanvasRenderer, Scene, WebGLRenderer } from '@mascotte/engine';
import { useEffect, useRef } from 'preact/hooks';

/** Draws `scene` from `camera` on a canvas of `width` × `height` CSS pixels. */
type Draw = (scene: Scene, camera: Camera, width: number, height: number) => void;

/** A renderer for the canvas: WebGL2, or Canvas 2D where WebGL2 cannot start. */
function rendererFor(canvas: HTMLCanvasElement): { draw: Draw; destroy: () => void } {
  try {
    const gl = new WebGLRenderer(canvas);
    return {
      draw: (scene, camera, width, height) =>
        gl.render(scene, camera, { width, height, pixelRatio: devicePixelRatio || 1 }),
      destroy: () => gl.destroy(),
    };
  } catch {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('The viewport has neither WebGL2 nor a 2D context.');
    const canvas2d = new CanvasRenderer();
    return {
      draw: (scene, camera, width, height) =>
        canvas2d.render(ctx, scene, camera, { width, height, pixelRatio: devicePixelRatio || 1 }),
      destroy: () => {},
    };
  }
}

/**
 * The viewport: the scene being edited, drawn by the engine and fitted to the panel. Empty
 * until a document is open.
 */
export function Viewport() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const renderer = rendererFor(canvas);
    const scene = new Scene();
    const camera = new Camera();
    const fit = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      // Not laid out (or gone): nothing to draw on.
      if (!(width > 0 && height > 0)) return;
      const ratio = devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      renderer.draw(scene, camera, width, height);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    fit();
    return () => {
      observer.disconnect();
      renderer.destroy();
    };
  }, []);
  return <canvas ref={ref} class="viewport" />;
}
