import {
  Animator,
  type Camera,
  CanvasRenderer,
  Scene,
  SvgRenderer,
  WebGLRenderer,
} from '@mascotte/engine';
import { buildDocument, type MascotDocument } from '@mascotte/format';

/** How to export a frame. */
export interface FrameOptions {
  /** `png` (the default) or `svg`. */
  readonly format?: 'png' | 'svg';
  /** Canvas pixels per CSS pixel of the document's frame; 1 by default. */
  readonly pixelRatio?: number;
}

/** How to export a sequence of frames, for a video. */
export interface FramesOptions extends FrameOptions {
  /** How long the sequence plays, in seconds, from the document's start (one frame at least). */
  readonly duration: number;
  /** Frames per second; 30 by default. */
  readonly fps?: number;
}

/** What draws an exported frame. */
export type ExportRenderer = 'webgl' | 'canvas';

/** The frame's size and background, from the document. */
function viewport(document: MascotDocument, pixelRatio: number) {
  const { width, height, background } = document.view;
  return background === undefined
    ? { width, height, pixelRatio }
    : { width, height, pixelRatio, background };
}

function check(name: string, value: number): number {
  if (!(value > 0 && Number.isFinite(value))) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}.`);
  }
  return value;
}

/** A canvas element of `width` × `height` pixels (a browser's: PNG export needs one). */
function canvasOf(width: number, height: number): HTMLCanvasElement {
  if (typeof globalThis.document === 'undefined') {
    throw new Error('Frame export: PNG needs a browser canvas; use the "svg" format elsewhere.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function png(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else {
        reject(
          new Error(
            `Frame export: the ${canvas.width}×${canvas.height} frame could not be encoded as PNG.`,
          ),
        );
      }
    }, 'image/png');
  });
}

/**
 * Draws frames for export with one renderer of the player's kind: PNG through a canvas of its
 * own (WebGL's frame is copied to a 2D canvas right after it is drawn, as its buffer is not kept),
 * SVG through `SvgRenderer`, which draws what Canvas 2D does. `dispose` frees the renderer.
 */
function frameMaker(document: MascotDocument, kind: ExportRenderer, options: FrameOptions) {
  const format = options.format ?? 'png';
  const view = viewport(document, check('pixelRatio', options.pixelRatio ?? 1));
  const width = view.width * view.pixelRatio;
  const height = view.height * view.pixelRatio;
  if (format === 'svg') {
    const svg = new SvgRenderer();
    return {
      make: async (scene: Scene, camera: Camera) =>
        new Blob([svg.render(scene, camera, view)], { type: 'image/svg+xml' }),
      dispose: () => {},
    };
  }
  const out = canvasOf(width, height);
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error(`Frame export: no 2D context for a ${out.width}×${out.height} PNG.`);
  if (kind === 'canvas') {
    const renderer = new CanvasRenderer();
    return {
      make: (scene: Scene, camera: Camera) => {
        renderer.render(ctx, scene, camera, view);
        return png(out);
      },
      dispose: () => {},
    };
  }
  const gl = canvasOf(width, height);
  const renderer = new WebGLRenderer(gl);
  const buffer = renderer.gl;
  if (buffer.drawingBufferWidth !== gl.width || buffer.drawingBufferHeight !== gl.height) {
    renderer.destroy();
    throw new Error(
      `Frame export: WebGL draws at most ${buffer.drawingBufferWidth}×${buffer.drawingBufferHeight} here, not ${gl.width}×${gl.height}; use a smaller pixelRatio.`,
    );
  }
  return {
    make: (scene: Scene, camera: Camera) => {
      // A frame like the last is skipped by the renderer, but the buffer is not kept between
      // frames: draw every one. A lost context draws nothing.
      renderer.invalidate();
      if (!renderer.render(scene, camera, view)) {
        throw new Error('Frame export: the WebGL context is lost, the frame was not drawn.');
      }
      ctx.clearRect(0, 0, out.width, out.height);
      ctx.drawImage(gl, 0, 0);
      return png(out);
    },
    dispose: () => renderer.destroy(),
  };
}

/** One frame of `scene` as it stands, as PNG or SVG. */
export async function exportFrame(
  document: MascotDocument,
  scene: Scene,
  camera: Camera,
  kind: ExportRenderer,
  options: FrameOptions = {},
): Promise<Blob> {
  const maker = frameMaker(document, kind, options);
  try {
    return await maker.make(scene, camera);
  } finally {
    maker.dispose();
  }
}

/**
 * A sequence of frames of `document` from its start, `fps` a second for `duration` seconds, on a
 * mascot built apart (with `params` and `palette`), so nothing the page shows changes. Inputs
 * stay at their defaults: the sequence shows what the document plays with them.
 */
export async function exportFrames(
  document: MascotDocument,
  build: { readonly params: Readonly<Record<string, number>>; readonly palette?: string },
  kind: ExportRenderer,
  options: FramesOptions,
): Promise<Blob[]> {
  const fps = check('fps', options.fps ?? 30);
  const count = Math.max(1, Math.round(check('duration', options.duration) * fps));
  const built = buildDocument(
    document,
    build.palette === undefined
      ? { params: build.params }
      : { params: build.params, palette: build.palette },
  );
  const scene = new Scene(built.root);
  const animator = new Animator(scene, { rig: built.rig });
  built.animate(animator);
  animator.evaluate();
  const maker = frameMaker(document, kind, options);
  const frames: Blob[] = [];
  try {
    for (let i = 0; i < count; i++) {
      if (i > 0) animator.update(1 / fps);
      frames.push(await maker.make(scene, built.camera));
    }
  } finally {
    maker.dispose();
  }
  return frames;
}
