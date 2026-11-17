import { color as colorMath } from '@mascotte/math';
import type { Camera } from '../../scene/camera.ts';
import type { Scene } from '../../scene/scene.ts';
import type { Viewport } from '../canvas.ts';
import {
  type Bucket,
  GLCollector,
  type GLFrame,
  OBJECT_STRIDE,
  type PrimitiveKind,
  STRIDE,
} from './collect.ts';
import {
  capsuleProgram,
  coneProgram,
  cylinderProgram,
  fillProgram,
  hemisphereProgram,
  sphereProgram,
} from './shaders.ts';

interface ProgramSource {
  vertex: string;
  fragment: string;
  attributes: readonly (readonly [string, number])[];
}

interface Program {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  uniforms: Record<string, WebGLUniformLocation | null>;
  instanced: boolean;
}

const SOURCES: Record<PrimitiveKind, ProgramSource> = {
  capsule: capsuleProgram,
  sphere: sphereProgram,
  hemisphere: hemisphereProgram,
  cylinder: cylinderProgram,
  cone: coneProgram,
  fill: fillProgram,
};

/** Drawing order of kinds within a bucket. */
const ORDER: readonly PrimitiveKind[] = [
  'fill',
  'cylinder',
  'cone',
  'hemisphere',
  'sphere',
  'capsule',
];

export interface WebGLRendererOptions {
  /**
   * How many times larger the internal frame is than the canvas along each axis (supersampling),
   * from 1 to 4. Depth is written for the whole pixel, so shape intersection lines are antialiased
   * only this way. Defaults to 2: together with 4 MSAA samples this gives 16 samples per pixel.
   * This is an upper bound: on large canvases the factor is lowered so that the internal frame fits
   * the GPU limits and `PIXEL_BUDGET`, see `supersample`.
   */
  supersample?: number;
}

/**
 * Largest number of pixels in the internal frame. Each pixel is 4 samples of 8 bytes
 * (color, depth and stencil): about 256 MB of video memory.
 */
export const PIXEL_BUDGET = 2 ** 23;

/*
 * Stencil: the lower 7 bits are the decal anchor number in the layer (and for translucent shapes,
 * the shape number), the high bit means "opaque here". At the end of the frame it is used to set
 * the alpha of covered samples to 1: opaque passes do not write alpha, otherwise the
 * alpha-to-coverage coverage would be counted twice.
 */
const COVERED = 0x80;
const ID_BITS = 0x7f;

/**
 * Internal frame buffers: a multisampled one for drawing and a regular one for downsampling; for
 * outlines, the object numbers with their depth (`ids`), and which blocks of `BLOCK` pixels have
 * an edge between objects (`blocks`).
 */
interface Targets {
  width: number;
  height: number;
  factor: number;
  msaa: WebGLFramebuffer;
  resolve: WebGLFramebuffer;
  color: WebGLTexture;
  ids: WebGLFramebuffer;
  idColor: WebGLTexture;
  idDepth: WebGLTexture;
  blocks: WebGLFramebuffer;
  blockColor: WebGLTexture;
  spread: WebGLFramebuffer;
  spreadColor: WebGLTexture;
  renderbuffers: WebGLRenderbuffer[];
}

/** The side of a block of internal pixels the outline pass skips when it has no edge. */
const BLOCK = 8;
/** The widest outline in internal pixels: a wider one is drawn this wide. */
const MAX_OUTLINE = 32;
/** Texels per row of the object table (two per object: color, width). */
const OBJECT_ROW = 1024;

/** WebGL objects that are recreated after a context loss. */
interface Resources {
  programs: Record<PrimitiveKind, Program>;
  corners: WebGLBuffer;
  emptyVao: WebGLVertexArrayObject;
  /** Program that sets alpha to 1 in covered samples. */
  cover: WebGLProgram;
  /** Marks the blocks with an edge between objects. */
  blocks: { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
  /** Draws the outlines over the resolved frame. */
  outline: { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
  /** Spreads the edge marks to the blocks within an outline's reach. */
  spread: { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
  /** The frame's object table (`GLFrame.objects`), RGBA float texels, and its rows. */
  objects: { texture: WebGLTexture; rows: number };
  /** Downsampling programs keyed by factor, created as needed. */
  downsample: Map<number, { program: WebGLProgram; color: WebGLUniformLocation }>;
  shaders: WebGLShader[];
  targets: Targets | null;
}

/**
 * Scene rendering through WebGL2 with per-pixel depth: occlusions and intersections of shapes are
 * exact and continuous. Spheres, capsules and surfaces are impostor rectangles whose shape and
 * depth are computed per pixel; fills are triangles.
 *
 * The frame is drawn into an internal multisampled buffer `supersample` times larger than the
 * canvas (edges are antialiased with alpha-to-coverage and MSAA, intersection lines with
 * supersampling), then downsampled with averaging. Sort layers are drawn one after another, depth
 * is tested only within a layer. The stencil keeps decals on the visible pixels of their anchor.
 *
 * After a context loss frames are skipped; after restoration the WebGL objects are created again.
 * When rendering is no longer needed, call `destroy()`.
 */
export class WebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly #canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly #collector = new GLCollector();
  readonly #maxSupersample: number;
  #res: Resources | null = null;
  // What was drawn in the last frame: if none of this has changed, the frame is the same.
  readonly #last = {
    scene: null as Scene | null,
    change: -1,
    camera: null as Camera | null,
    cameraWorld: -1,
    cameraProjection: -1,
    width: 0,
    height: 0,
    ratio: 0,
    background: undefined as string | undefined,
    bufferWidth: 0,
    bufferHeight: 0,
  };
  #lost = false;
  #destroyed = false;
  #halfX = 0;
  #halfY = 0;
  #px = 1;
  // Parsed background color: parsed again only when the string changes.
  #backgroundCss: string | undefined = undefined;
  #backgroundParsed = false;
  readonly #backgroundRgba = new Float64Array(4);
  #supersample = 1;

  readonly #onLost = (event: Event) => {
    // Without preventDefault the browser will not restore the context.
    event.preventDefault();
    this.#lost = true;
    this.#res = null;
    this.invalidate();
  };

  readonly #onRestored = () => {
    this.#lost = false;
    this.invalidate();
    try {
      this.#res = this.#createResources();
    } catch (error) {
      // Event handler: there is nowhere to throw, frames will just keep being skipped.
      console.error('Failed to restore WebGL objects after a context loss.', error);
    }
  };

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options: WebGLRendererOptions = {}) {
    const factor = options.supersample ?? 2;
    if (!(Number.isInteger(factor) && factor >= 1 && factor <= 4)) {
      throw new RangeError(`supersample must be an integer from 1 to 4, got ${factor}.`);
    }
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      stencil: false,
      depth: false,
      premultipliedAlpha: true,
      alpha: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available.');
    this.gl = gl;
    this.#canvas = canvas;
    this.#maxSupersample = factor;
    try {
      this.#res = this.#createResources();
    } catch (error) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      throw error;
    }
    canvas.addEventListener('webglcontextlost', this.#onLost);
    canvas.addEventListener('webglcontextrestored', this.#onRestored);
  }

  /** Supersampling factor of the last frame: no larger than the one set in the options. */
  get supersample(): number {
    return this.#supersample;
  }

  /** The context is lost: frames are skipped until the browser restores it. */
  get contextLost(): boolean {
    return this.#lost || this.gl.isContextLost();
  }

  /** Forget the last frame: the next `render` draws it again even if nothing has changed. */
  invalidate(): void {
    this.#last.scene = null;
  }

  /** Releases the WebGL objects and the context itself. The renderer is not used after the call. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#canvas.removeEventListener('webglcontextlost', this.#onLost);
    this.#canvas.removeEventListener('webglcontextrestored', this.#onRestored);
    const res = this.#res;
    this.#res = null;
    if (res && !this.gl.isContextLost()) this.#deleteResources(res);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /**
   * Draws a frame. Without a background the frame is transparent: alpha reflects shape coverage
   * exactly.
   *
   * If since the previous frame neither the scene (`Scene.changeVersion`), nor the camera, nor the
   * frame and canvas size, nor the background color has changed, does nothing: the canvas keeps the
   * previous frame. This way there is no work and no memory allocation at rest. Assigning the same
   * size to the canvas clears it but does not change the inputs, so after such an assignment
   * `invalidate()` is needed. Also does nothing while the context is lost. Returns `true` if the
   * frame was drawn.
   */
  render(scene: Scene, camera: Camera, viewport: Viewport): boolean {
    if (this.#destroyed) throw new Error('Renderer is destroyed.');
    const ratio = viewport.pixelRatio ?? 1;
    if (!(viewport.width > 0 && viewport.height > 0 && ratio > 0 && Number.isFinite(ratio))) {
      throw new RangeError('Frame size and pixelRatio must be positive.');
    }
    const res = this.#res;
    if (!res || this.contextLost) return false;
    const gl = this.gl;
    if (this.#sameAsLast(scene, camera, viewport, ratio)) return false;
    const frame = this.#collector.collect(scene, camera);
    const targets = this.#ensureTargets(res, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const factor = targets.factor;
    this.#supersample = factor;
    const px = ratio * factor;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.msaa);
    gl.viewport(0, 0, targets.width, targets.height);
    const bg = this.#background(viewport.background);
    const r = bg[0] as number;
    const g = bg[1] as number;
    const b = bg[2] as number;
    const a = bg[3] as number;
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.clearColor(r * a, g * a, b * a, a);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.depthFunc(gl.LESS);
    // Translucent content is blended with the already premultiplied frame.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Half of the frame and the pixel density are in fields, so as not to create an array per
    // frame.
    this.#halfX = viewport.width / 2;
    this.#halfY = viewport.height / 2;
    this.#px = px;

    let first = true;
    for (const layer of frame.layers) {
      if (!first) {
        // A new layer is drawn on top: depth and anchor numbers start from a clean slate.
        gl.depthMask(true);
        gl.stencilMask(ID_BITS);
        gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      }
      first = false;

      // Opaque: depth, anchor number and the coverage bit in the stencil, smoothing through
      // alpha-to-coverage. Frame alpha is not written (the coverage pass sets it).
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.colorMask(true, true, true, false);
      gl.stencilMask(0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      for (const bucket of layer.opaque) {
        gl.stencilFunc(gl.ALWAYS, bucket.stencil | COVERED, 0xff);
        this.#draw(res, bucket, frame, false);
      }

      // Decals: only on the visible pixels of their anchor, in sort order and without
      // a depth test, since the anchor is already covered by everything in front of it.
      gl.disable(gl.DEPTH_TEST);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      for (const bucket of layer.decals) {
        gl.stencilFunc(gl.EQUAL, bucket.stencil, ID_BITS);
        if (bucket.blend) {
          gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
          gl.enable(gl.BLEND);
          gl.colorMask(true, true, true, true);
        } else {
          gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
          gl.disable(gl.BLEND);
          gl.colorMask(true, true, true, false);
        }
        this.#draw(res, bucket, frame, false);
      }

      // Translucent: in order, blended, without depth writes. Each shape
      // gets its own stencil number and is blended into a pixel once, otherwise
      // overlapping stroke capsules would produce dark beads.
      if (layer.transparent.length > 0) {
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        gl.enable(gl.BLEND);
        gl.colorMask(true, true, true, true);
        gl.stencilMask(ID_BITS);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        let id = ID_BITS;
        for (const bucket of layer.transparent) {
          if (id === ID_BITS) {
            gl.clear(gl.STENCIL_BUFFER_BIT);
            id = 0;
          }
          id++;
          gl.stencilFunc(gl.NOTEQUAL, id, ID_BITS);
          this.#draw(res, bucket, frame, true);
          this.#draw(res, bucket, frame, false);
        }
      }
    }

    // Alpha 1 in all samples under opaque content.
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.colorMask(false, false, false, true);
    gl.stencilFunc(gl.EQUAL, COVERED, COVERED);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.useProgram(res.cover);
    gl.bindVertexArray(res.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.disable(gl.STENCIL_TEST);

    // Multisampled buffer → regular texture (→ outlines) → canvas with block averaging.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, targets.msaa);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.resolve);
    gl.blitFramebuffer(
      0,
      0,
      targets.width,
      targets.height,
      0,
      0,
      targets.width,
      targets.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    );
    this.#outlines(res, targets, frame);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    const downsample = this.#downsample(res, factor);
    gl.useProgram(downsample.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.color);
    gl.uniform1i(downsample.color, 0);
    gl.bindVertexArray(res.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    // Only a drawn frame is remembered: after an error the next call draws again.
    this.#remember(scene, camera, viewport, ratio);
    return true;
  }

  /**
   * Outlines, drawn over the resolved frame `targets.color`. The opaque shapes and decals are
   * drawn once more as object numbers, whole pixels at the internal resolution (antialiased by
   * the downsampling only); numbers go in sort order, so a later layer and a later shape have
   * larger ones. Then a pixel within an object's outline width of it takes the outline of the
   * nearest such object drawn later than the pixel's own (or than the background): at an edge
   * between two shapes the line is the later one's, as Canvas 2D's draw order gives, so a feature
   * sunk a little into a body (an eye, a cheek) leaves no crescent of the body's outline. A
   * decal's outline stays on its anchor, as Canvas 2D clips it.
   *
   * упрощение: полупрозрачные фигуры не дают номеров: они не обводятся и не закрывают обводки,
   * которые рисуются поверх всего кадра; вернуться, если понадобятся обводки у полупрозрачного.
   * упрощение: обводка шире `MAX_OUTLINE` внутренних пикселей рисуется этой ширины (у пикселя у
   * края перебор квадрата радиуса); вернуться к поиску ближайшего края проходами (jump flood),
   * если понадобятся толстые обводки крупным планом.
   */
  #outlines(res: Resources, targets: Targets, frame: GLFrame): void {
    const objects = frame.objects;
    const count = objects.length / OBJECT_STRIDE;
    let widest = 0;
    for (let i = 1; i < count; i++) {
      const width = objects.data[i * OBJECT_STRIDE + 4] as number;
      if (width > widest) widest = width;
    }
    if (!(widest > 0)) return;
    const gl = this.gl;
    const radius = Math.min(MAX_OUTLINE, Math.ceil(widest * this.#px) + 1);

    // The object numbers: each layer over the one before, as in the frame.
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.ids);
    gl.viewport(0, 0, targets.width, targets.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.depthFunc(gl.LESS);
    for (const layer of frame.layers) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      for (const bucket of layer.opaque) {
        gl.stencilFunc(gl.ALWAYS, bucket.stencil, 0xff);
        this.#draw(res, bucket, frame, false, true);
      }
      gl.disable(gl.DEPTH_TEST);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      for (const bucket of layer.decals) {
        if (bucket.blend) continue;
        gl.stencilFunc(gl.EQUAL, bucket.stencil, 0xff);
        this.#draw(res, bucket, frame, false, true);
      }
    }
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);

    // The object table: two texels per object, in rows of `OBJECT_ROW`; the texture grows only.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, res.objects.texture);
    const texels = count * 2;
    const rows = Math.ceil(texels / OBJECT_ROW);
    if (rows > res.objects.rows) {
      res.objects.rows = Math.max(rows, res.objects.rows * 2);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        OBJECT_ROW,
        res.objects.rows,
        0,
        gl.RGBA,
        gl.FLOAT,
        null,
      );
    }
    const full = Math.floor(texels / OBJECT_ROW);
    if (full > 0) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        OBJECT_ROW,
        full,
        gl.RGBA,
        gl.FLOAT,
        objects.data,
        0,
      );
    }
    const rest = texels - full * OBJECT_ROW;
    if (rest > 0) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        full,
        rest,
        1,
        gl.RGBA,
        gl.FLOAT,
        objects.data,
        full * OBJECT_ROW * 4,
      );
    }

    // The blocks with an edge, then spread to those within the outline's reach.
    const blocksWide = Math.ceil(targets.width / BLOCK);
    const blocksHigh = Math.ceil(targets.height / BLOCK);
    gl.bindVertexArray(res.emptyVao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.blocks);
    gl.viewport(0, 0, blocksWide, blocksHigh);
    gl.useProgram(res.blocks.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.idColor);
    gl.uniform1i(res.blocks.uniforms.uIds ?? null, 0);
    gl.uniform1i(res.blocks.uniforms.uBlock ?? null, BLOCK);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.spread);
    gl.useProgram(res.spread.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targets.blockColor);
    gl.uniform1i(res.spread.uniforms.uBlocks ?? null, 1);
    gl.uniform1i(res.spread.uniforms.uReach ?? null, Math.ceil(radius / BLOCK));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // The outlines over the frame.
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.resolve);
    gl.viewport(0, 0, targets.width, targets.height);
    const u = res.outline.uniforms;
    gl.useProgram(res.outline.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, targets.spreadColor);
    gl.uniform1i(u.uIds ?? null, 0);
    gl.uniform1i(u.uBlocks ?? null, 1);
    gl.uniform1i(u.uObjects ?? null, 2);
    gl.uniform1i(u.uBlock ?? null, BLOCK);
    gl.uniform1i(u.uRadius ?? null, radius);
    gl.uniform1f(u.uPx ?? null, this.#px);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Background color as RGBA 0–1; without a background or with an unparsable color, transparent.
   */
  #background(css: string | undefined): Float64Array {
    const out = this.#backgroundRgba;
    if (!this.#backgroundParsed || css !== this.#backgroundCss) {
      this.#backgroundParsed = true;
      this.#backgroundCss = css;
      const c = css ? colorMath.parse(css) : null;
      out[0] = c ? c.r : 0;
      out[1] = c ? c.g : 0;
      out[2] = c ? c.b : 0;
      out[3] = c ? c.a : 0;
    }
    return out;
  }

  /** Whether the frame is the same as the one drawn last time. */
  #sameAsLast(scene: Scene, camera: Camera, viewport: Viewport, ratio: number): boolean {
    const last = this.#last;
    const gl = this.gl;
    return (
      last.scene === scene &&
      last.change === scene.changeVersion &&
      last.camera === camera &&
      last.cameraWorld === camera.worldVersion &&
      last.cameraProjection === camera.projectionVersion &&
      last.width === viewport.width &&
      last.height === viewport.height &&
      last.ratio === ratio &&
      last.background === viewport.background &&
      last.bufferWidth === gl.drawingBufferWidth &&
      last.bufferHeight === gl.drawingBufferHeight
    );
  }

  #remember(scene: Scene, camera: Camera, viewport: Viewport, ratio: number): void {
    const last = this.#last;
    const gl = this.gl;
    const cameraWorld = camera.worldVersion;
    last.scene = scene;
    last.change = scene.changeVersion;
    last.camera = camera;
    last.cameraWorld = cameraWorld;
    last.cameraProjection = camera.projectionVersion;
    last.width = viewport.width;
    last.height = viewport.height;
    last.ratio = ratio;
    last.background = viewport.background;
    last.bufferWidth = gl.drawingBufferWidth;
    last.bufferHeight = gl.drawingBufferHeight;
  }

  #createResources(): Resources {
    const gl = this.gl;
    const shaders: WebGLShader[] = [];
    const res: Partial<Resources> = { shaders, downsample: new Map(), targets: null };
    try {
      const emptyVao = gl.createVertexArray();
      const corners = gl.createBuffer();
      if (!emptyVao || !corners) throw new Error('Failed to create WebGL objects.');
      res.emptyVao = emptyVao;
      res.corners = corners;
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      res.cover = link(gl, FULLSCREEN_VERTEX, COVER_FRAGMENT, 'cover', shaders);
      res.blocks = fullscreen(gl, BLOCKS_FRAGMENT, 'blocks', shaders, ['uIds', 'uBlock']);
      res.spread = fullscreen(gl, SPREAD_FRAGMENT, 'spread', shaders, ['uBlocks', 'uReach']);
      res.outline = fullscreen(gl, OUTLINE_FRAGMENT, 'outline', shaders, [
        'uIds',
        'uObjects',
        'uBlocks',
        'uBlock',
        'uRadius',
        'uPx',
      ]);
      const objects = gl.createTexture();
      if (!objects) throw new Error('Failed to create WebGL objects.');
      res.objects = { texture: objects, rows: 0 };
      gl.bindTexture(gl.TEXTURE_2D, objects);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const programs = {} as Record<PrimitiveKind, Program>;
      res.programs = programs;
      for (const kind of Object.keys(SOURCES) as PrimitiveKind[]) {
        programs[kind] = this.#createProgram(kind, SOURCES[kind], corners, shaders);
      }
      return res as Resources;
    } catch (error) {
      this.#deleteResources(res);
      throw error;
    }
  }

  #deleteResources(res: Partial<Resources>): void {
    const gl = this.gl;
    for (const program of Object.values(res.programs ?? {})) {
      gl.deleteProgram(program.program);
      gl.deleteVertexArray(program.vao);
      gl.deleteBuffer(program.buffer);
    }
    if (res.cover) gl.deleteProgram(res.cover);
    if (res.blocks) gl.deleteProgram(res.blocks.program);
    if (res.outline) gl.deleteProgram(res.outline.program);
    if (res.spread) gl.deleteProgram(res.spread.program);
    if (res.objects) gl.deleteTexture(res.objects.texture);
    for (const { program } of res.downsample?.values() ?? []) gl.deleteProgram(program);
    for (const shader of res.shaders ?? []) gl.deleteShader(shader);
    if (res.corners) gl.deleteBuffer(res.corners);
    if (res.emptyVao) gl.deleteVertexArray(res.emptyVao);
    if (res.targets) deleteTargets(gl, res.targets);
  }

  #downsample(
    res: Resources,
    factor: number,
  ): { program: WebGLProgram; color: WebGLUniformLocation } {
    let entry = res.downsample.get(factor);
    if (!entry) {
      const gl = this.gl;
      const program = link(
        gl,
        FULLSCREEN_VERTEX,
        downsampleFragment(factor),
        'downsample',
        res.shaders,
      );
      const color = gl.getUniformLocation(program, 'uColor');
      if (!color) throw new Error('The frame downsampling program has no uColor.');
      entry = { program, color };
      res.downsample.set(factor, entry);
    }
    return entry;
  }

  /**
   * Internal buffers for a `width × height` canvas; recreated only when the size
   * changes. The factor is the largest at which the frame fits the limits.
   */
  #ensureTargets(res: Resources, width: number, height: number): Targets {
    const gl = this.gl;
    const limit = Math.min(
      gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    );
    const factor = supersampleFor(width, height, this.#maxSupersample, limit);
    const w = width * factor;
    const h = height * factor;
    const current = res.targets;
    if (current && current.width === w && current.height === h) return current;
    if (current) deleteTargets(gl, current);
    res.targets = null;
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    const msaa = gl.createFramebuffer();
    const resolve = gl.createFramebuffer();
    const color = gl.createTexture();
    const colorBuffer = gl.createRenderbuffer();
    const depthBuffer = gl.createRenderbuffer();
    const ids = gl.createFramebuffer();
    const idColor = gl.createTexture();
    const idDepth = gl.createTexture();
    const blocks = gl.createFramebuffer();
    const blockColor = gl.createTexture();
    const spread = gl.createFramebuffer();
    const spreadColor = gl.createTexture();
    if (
      !spread ||
      !spreadColor ||
      !msaa ||
      !resolve ||
      !color ||
      !colorBuffer ||
      !depthBuffer ||
      !ids ||
      !idColor ||
      !idDepth ||
      !blocks ||
      !blockColor
    ) {
      throw new Error('Failed to create WebGL frame buffers.');
    }
    const targets: Targets = {
      width: w,
      height: h,
      factor,
      msaa,
      resolve,
      color,
      ids,
      idColor,
      idDepth,
      blocks,
      blockColor,
      spread,
      spreadColor,
      renderbuffers: [colorBuffer, depthBuffer],
    };
    const texture = (target: WebGLTexture, format: number, tw: number, th: number) => {
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texStorage2D(gl.TEXTURE_2D, 1, format, tw, th);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    };
    texture(idColor, gl.RGBA8, w, h);
    texture(idDepth, gl.DEPTH24_STENCIL8, w, h);
    texture(blockColor, gl.R8, Math.ceil(w / BLOCK), Math.ceil(h / BLOCK));
    texture(spreadColor, gl.R8, Math.ceil(w / BLOCK), Math.ceil(h / BLOCK));
    gl.bindFramebuffer(gl.FRAMEBUFFER, ids);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, idColor, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, idDepth, 0);
    const idStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, blocks);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, blockColor, 0);
    let blockStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, spread);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, spreadColor, 0);
    if (blockStatus === gl.FRAMEBUFFER_COMPLETE)
      blockStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (idStatus !== gl.FRAMEBUFFER_COMPLETE || blockStatus !== gl.FRAMEBUFFER_COMPLETE) {
      deleteTargets(gl, targets);
      throw new Error(
        `Outline buffers ${w}×${h} were not created: status ${idStatus}, ${blockStatus}.`,
      );
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, colorBuffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorBuffer);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      depthBuffer,
    );
    const msaaStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolve);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    const resolveStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (msaaStatus !== gl.FRAMEBUFFER_COMPLETE || resolveStatus !== gl.FRAMEBUFFER_COMPLETE) {
      deleteTargets(gl, targets);
      throw new Error(
        `Frame buffer ${w}×${h} (${samples} samples) was not created: status ${msaaStatus}, ${resolveStatus}.`,
      );
    }
    res.targets = targets;
    return targets;
  }

  /**
   * `solid` is the first pass of a translucent shape: only fully covered pixels. `ids` draws
   * object numbers (`#outlines`) instead of colors.
   */
  #draw(res: Resources, bucket: Bucket, frame: GLFrame, solid: boolean, ids = false): void {
    const gl = this.gl;
    for (let k = 0; k < ORDER.length; k++) {
      const kind = ORDER[k] as PrimitiveKind;
      const count = bucket.count(kind);
      if (count === 0) continue;
      const program = res.programs[kind];
      gl.useProgram(program.program);
      const u = program.uniforms;
      gl.uniform2f(u.uHalf ?? null, this.#halfX, this.#halfY);
      gl.uniform2f(u.uDepth ?? null, frame.zMin, frame.zMax);
      gl.uniform1f(u.uPx ?? null, this.#px);
      gl.uniform1f(u.uRayZ ?? null, frame.zMax + 10);
      gl.uniform1f(u.uSolid ?? null, solid ? 1 : 0);
      gl.uniform3f(u.uLight ?? null, frame.light.x, frame.light.y, frame.light.z);
      gl.uniform1f(u.uIdPass ?? null, ids ? 1 : 0);
      gl.bindVertexArray(program.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, program.buffer);
      const data = bucket.data[kind];
      // The WebGL2 variant with offset and length: no subarray per call.
      gl.bufferData(gl.ARRAY_BUFFER, data.data, gl.DYNAMIC_DRAW, 0, data.length);
      if (program.instanced) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      else gl.drawArrays(gl.TRIANGLES, 0, count);
    }
    gl.bindVertexArray(null);
  }

  #createProgram(
    kind: PrimitiveKind,
    source: ProgramSource,
    corners: WebGLBuffer,
    shaders: WebGLShader[],
  ): Program {
    const gl = this.gl;
    const program = link(gl, source.vertex, source.fragment, kind, shaders);
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error('Failed to create WebGL objects.');
    const instanced = kind !== 'fill';
    gl.bindVertexArray(vao);
    if (instanced) {
      const corner = gl.getAttribLocation(program, 'aCorner');
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.enableVertexAttribArray(corner);
      gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = STRIDE[kind] * 4;
    let offset = 0;
    for (const [name, size] of [
      ...source.attributes,
      ['aColor', 4] as const,
      ['aId', 1] as const,
    ]) {
      const location = gl.getAttribLocation(program, name);
      if (location >= 0) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
        if (instanced) gl.vertexAttribDivisor(location, 1);
      }
      offset += size * 4;
    }
    gl.bindVertexArray(null);
    // The compiler drops a variable unused in the shader; its location is null.
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of ['uHalf', 'uDepth', 'uPx', 'uRayZ', 'uSolid', 'uLight', 'uIdPass']) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    if (!uniforms.uHalf) throw new Error(`Program ${kind} has no uHalf.`);
    // Without its light a shaded program would mix its tones evenly, without a word.
    if ((kind === 'sphere' || kind === 'capsule') && !uniforms.uLight) {
      throw new Error(`Program ${kind} has no uLight.`);
    }
    return { program, vao, buffer, uniforms, instanced };
  }
}

/**
 * Supersampling factor for a `width × height` canvas: the largest one no larger than `max` at which
 * the sides of the internal frame do not exceed `limit` and the pixel count does not exceed
 * `PIXEL_BUDGET`.
 */
export function supersampleFor(width: number, height: number, max: number, limit: number): number {
  if (width > limit || height > limit) {
    throw new RangeError(`Canvas ${width}×${height} exceeds the GPU limit ${limit}.`);
  }
  let factor = max;
  while (
    factor > 1 &&
    (width * factor > limit ||
      height * factor > limit ||
      width * height * factor * factor > PIXEL_BUDGET)
  ) {
    factor--;
  }
  return factor;
}

function deleteTargets(gl: WebGL2RenderingContext, targets: Targets): void {
  gl.deleteFramebuffer(targets.msaa);
  gl.deleteFramebuffer(targets.resolve);
  gl.deleteTexture(targets.color);
  gl.deleteFramebuffer(targets.ids);
  gl.deleteTexture(targets.idColor);
  gl.deleteTexture(targets.idDepth);
  gl.deleteFramebuffer(targets.blocks);
  gl.deleteTexture(targets.blockColor);
  gl.deleteFramebuffer(targets.spread);
  gl.deleteTexture(targets.spreadColor);
  for (const buffer of targets.renderbuffers) gl.deleteRenderbuffer(buffer);
}

const FULLSCREEN_VERTEX = `#version 300 es
void main() {
  // One triangle over the whole frame.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const COVER_FRAGMENT = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, 1.0); }
`;

/** A fullscreen program with the uniforms `names`. */
function fullscreen(
  gl: WebGL2RenderingContext,
  fragment: string,
  kind: string,
  shaders: WebGLShader[],
  names: readonly string[],
): { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> } {
  const program = link(gl, FULLSCREEN_VERTEX, fragment, kind, shaders);
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

/** Marks a block of `uBlock` pixels that has two neighbors of different objects. */
const BLOCKS_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D uIds;
uniform int uBlock;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uIds, 0);
  ivec2 base = ivec2(gl_FragCoord.xy) * uBlock;
  float edge = 0.0;
  for (int y = 0; y < uBlock && edge == 0.0; y++) {
    for (int x = 0; x < uBlock; x++) {
      ivec2 q = base + ivec2(x, y);
      if (q.x >= size.x || q.y >= size.y) continue;
      vec4 c = texelFetch(uIds, q, 0);
      if ((q.x + 1 < size.x && texelFetch(uIds, q + ivec2(1, 0), 0) != c) ||
          (q.y + 1 < size.y && texelFetch(uIds, q + ivec2(0, 1), 0) != c)) {
        edge = 1.0;
        break;
      }
    }
  }
  outColor = vec4(edge, 0.0, 0.0, 1.0);
}
`;

/** Spreads the marks of `uBlocks` to the blocks within `uReach` of them. */
const SPREAD_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D uBlocks;
uniform int uReach;
out vec4 outColor;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uBlocks, 0);
  float edge = 0.0;
  for (int y = -uReach; y <= uReach && edge == 0.0; y++) {
    for (int x = -uReach; x <= uReach; x++) {
      ivec2 q = b + ivec2(x, y);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      if (texelFetch(uBlocks, q, 0).r > 0.5) {
        edge = 1.0;
        break;
      }
    }
  }
  outColor = vec4(edge, 0.0, 0.0, 1.0);
}
`;

/** See \`WebGLRenderer.#outlines\`. */
const OUTLINE_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D uIds;
uniform highp sampler2D uObjects;
uniform highp sampler2D uBlocks;
uniform int uBlock;
uniform int uRadius;
uniform float uPx;
out vec4 outColor;

int idAt(ivec2 q) {
  vec3 c = texelFetch(uIds, q, 0).rgb * 255.0 + 0.5;
  return int(c.r) + int(c.g) * 256 + int(c.b) * 65536;
}

vec4 objectAt(int id, int part) {
  int i = id * 2 + part;
  return texelFetch(uObjects, ivec2(i % ${OBJECT_ROW}, i / ${OBJECT_ROW}), 0);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  // Far from any edge: nothing to draw.
  if (texelFetch(uBlocks, p / uBlock, 0).r < 0.5) discard;
  ivec2 size = textureSize(uIds, 0);
  int idP = idAt(p);
  vec4 objectP = objectAt(idP, 1);
  float best = 1e9;
  float bestWidth = 0.0;
  int bestId = 0;
  for (int dy = -uRadius; dy <= uRadius; dy++) {
    for (int dx = -uRadius; dx <= uRadius; dx++) {
      float d = length(vec2(dx, dy));
      if (d >= best || d > float(uRadius)) continue;
      ivec2 q = p + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      int idQ = idAt(q);
      // Drawn later (in sort order) than what is here: as in Canvas 2D, it edges over it.
      if (idQ <= idP) continue;
      vec4 objectQ = objectAt(idQ, 1);
      float width = objectQ.r * uPx;
      if (!(width > 0.0) || d > width + 0.5) continue;
      // A decal's outline stays on its anchor (and the anchor's decals), as it is clipped to it.
      if (objectQ.b > 0.5 && (idP == 0 || objectP.g != objectQ.g || objectP.a != objectQ.a)) continue;
      best = d;
      bestWidth = width;
      bestId = idQ;
    }
  }
  if (bestId == 0) discard;
  vec4 color = objectAt(bestId, 0);
  // The edge lies about half a pixel from the neighbor's center.
  float a = color.a * clamp(bestWidth + 1.0 - best, 0.0, 1.0);
  outColor = vec4(color.rgb * a, a);
}
`;

/** Averaging of a `factor × factor` block of internal frame pixels. */
function downsampleFragment(factor: number): string {
  return `#version 300 es
precision highp float;
uniform sampler2D uColor;
out vec4 outColor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * ${factor};
  vec4 sum = vec4(0.0);
  for (int y = 0; y < ${factor}; y++)
    for (int x = 0; x < ${factor}; x++)
      sum += texelFetch(uColor, base + ivec2(x, y), 0);
  outColor = sum / ${factor * factor}.0;
}
`;
}

/** Builds a program; adds the created shaders to `shaders` so they can be deleted later. */
function link(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  kind: string,
  shaders: WebGLShader[],
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create a WebGL program.');
  const vs = compile(gl, gl.VERTEX_SHADER, vertex, kind);
  shaders.push(vs);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment, kind);
  shaders.push(fs);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program ${kind} failed to link: ${log}`);
  }
  return program;
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
  kind: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create a shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader ${kind} failed to compile: ${log}`);
  }
  return shader;
}
