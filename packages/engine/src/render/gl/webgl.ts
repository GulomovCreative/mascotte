import { color as colorMath } from '@mascotte/math';
import type { Camera } from '../../scene/camera.ts';
import type { Scene } from '../../scene/scene.ts';
import type { Viewport } from '../canvas.ts';
import { type Bucket, GLCollector, type GLFrame, type PrimitiveKind, STRIDE } from './collect.ts';
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

/** Порядок рисования видов внутри корзины. */
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
   * Во сколько раз по каждой оси внутренний кадр больше холста (суперсэмплинг), от 1
   * до 4. Глубина пишется на весь пиксель, поэтому линии пересечения фигур сглаживаются
   * только так. По умолчанию 2: вместе с 4 выборками MSAA это 16 выборок на пиксель.
   * Это верхняя граница: на больших холстах множитель снижается, чтобы внутренний кадр
   * уложился в ограничения видеокарты и в `PIXEL_BUDGET`, см. `supersample`.
   */
  supersample?: number;
}

/**
 * Наибольшее число пикселей внутреннего кадра. Каждый пиксель — 4 выборки по 8 байт
 * (цвет, глубина и трафарет), то есть около 256 МБ видеопамяти.
 */
export const PIXEL_BUDGET = 2 ** 23;

/*
 * Трафарет: младшие 7 бит — номер опоры декалей в слое (а у полупрозрачных фигур —
 * номер фигуры), старший бит — «здесь непрозрачное». По нему в конце кадра альфа
 * покрытых выборок ставится в 1: непрозрачные проходы альфу не пишут, иначе покрытие
 * alpha-to-coverage учлось бы в ней второй раз.
 */
const COVERED = 0x80;
const ID_BITS = 0x7f;

/** Внутренние буферы кадра: многовыборочный для рисования и обычный для уменьшения. */
interface Targets {
  width: number;
  height: number;
  factor: number;
  msaa: WebGLFramebuffer;
  resolve: WebGLFramebuffer;
  color: WebGLTexture;
  renderbuffers: WebGLRenderbuffer[];
}

/** Объекты WebGL, которые пересоздаются после потери контекста. */
interface Resources {
  programs: Record<PrimitiveKind, Program>;
  corners: WebGLBuffer;
  emptyVao: WebGLVertexArrayObject;
  /** Заливка альфы покрытых выборок. */
  cover: WebGLProgram;
  /** Программы уменьшения кадра по множителю, создаются по мере надобности. */
  downsample: Map<number, { program: WebGLProgram; color: WebGLUniformLocation }>;
  shaders: WebGLShader[];
  targets: Targets | null;
}

/**
 * Отрисовка сцены через WebGL2 с глубиной на каждый пиксель: перекрытия и пересечения
 * фигур точные и непрерывные. Шары, капсулы и поверхности — прямоугольники-заглушки,
 * форма и глубина которых считаются в каждом пикселе; заливки — треугольники.
 *
 * Кадр рисуется во внутренний многовыборочный буфер в `supersample` раз больше холста
 * (края сглаживаются через alpha-to-coverage и MSAA, линии пересечения — суперсэмплингом),
 * затем уменьшается с усреднением. Слои сортировки рисуются по очереди, глубина
 * проверяется только внутри слоя. Трафарет держит декали на видимых пикселях их опоры.
 *
 * После потери контекста кадры пропускаются, после восстановления объекты WebGL
 * создаются заново. Когда отрисовка больше не нужна, вызовите `destroy()`.
 */
export class WebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly #canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly #collector = new GLCollector();
  readonly #maxSupersample: number;
  #res: Resources | null = null;
  // Что нарисовано в последнем кадре: если ничего из этого не изменилось, кадр тот же.
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
  // Разобранный цвет фона: разбирается заново только при смене строки.
  #backgroundCss: string | undefined = undefined;
  #backgroundParsed = false;
  readonly #backgroundRgba = new Float64Array(4);
  #supersample = 1;

  readonly #onLost = (event: Event) => {
    // Без preventDefault браузер не восстановит контекст.
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
      // Обработчик события: бросать некуда, кадры так и будут пропускаться.
      console.error('Не удалось восстановить объекты WebGL после потери контекста.', error);
    }
  };

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options: WebGLRendererOptions = {}) {
    const factor = options.supersample ?? 2;
    if (!(Number.isInteger(factor) && factor >= 1 && factor <= 4)) {
      throw new RangeError(`supersample должен быть целым от 1 до 4, получено ${factor}.`);
    }
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      stencil: false,
      depth: false,
      premultipliedAlpha: true,
      alpha: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 недоступен.');
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

  /** Множитель суперсэмплинга последнего кадра: не больше заданного в настройках. */
  get supersample(): number {
    return this.#supersample;
  }

  /** Контекст потерян: кадры пропускаются, пока браузер его не восстановит. */
  get contextLost(): boolean {
    return this.#lost || this.gl.isContextLost();
  }

  /** Забыть последний кадр: следующий `render` нарисует его заново, даже если ничего не изменилось. */
  invalidate(): void {
    this.#last.scene = null;
  }

  /** Освобождает объекты WebGL и сам контекст. После вызова рендерер не используется. */
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
   * Рисует кадр. Без фона кадр прозрачный: альфа точно отражает покрытие фигурами.
   *
   * Если со времени прошлого кадра не изменились ни сцена (`Scene.changeVersion`), ни
   * камера, ни размеры кадра и холста, ничего не делает: на холсте остаётся прошлый
   * кадр. Так в покое нет ни работы, ни выделений памяти. Пока контекст потерян, тоже
   * ничего не делает. Возвращает `true`, если кадр нарисован.
   */
  render(scene: Scene, camera: Camera, viewport: Viewport): boolean {
    if (this.#destroyed) throw new Error('Рендерер уничтожен.');
    const ratio = viewport.pixelRatio ?? 1;
    if (!(viewport.width > 0 && viewport.height > 0 && ratio > 0 && Number.isFinite(ratio))) {
      throw new RangeError('Размеры кадра и pixelRatio должны быть положительными.');
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
    // Полупрозрачное смешивается с уже премультиплицированным кадром.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Половина кадра и плотность пикселей — в полях, чтобы не создавать массив на кадр.
    this.#halfX = viewport.width / 2;
    this.#halfY = viewport.height / 2;
    this.#px = px;

    let first = true;
    for (const layer of frame.layers) {
      if (!first) {
        // Новый слой рисуется поверх: глубина и номера опор с чистого листа.
        gl.depthMask(true);
        gl.stencilMask(ID_BITS);
        gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      }
      first = false;

      // Непрозрачное: глубина, номер опоры и бит покрытия в трафарете, сглаживание через
      // alpha-to-coverage. Альфа кадра не пишется (её ставит проход покрытия).
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

      // Декали: только на видимых пикселях своей опоры, по порядку сортировки и без
      // проверки глубины — опора уже закрыта всем, что перед ней.
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

      // Полупрозрачное: по порядку, с наложением, без записи глубины. Каждая фигура
      // получает свой номер в трафарете и смешивается в пикселе один раз, иначе
      // перекрытия капсул обводки дали бы тёмные бусины.
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

    // Альфа 1 во всех выборках под непрозрачным.
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

    // Многовыборочный буфер → обычная текстура → холст с усреднением блоков.
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
    // Запоминается только нарисованный кадр: после ошибки следующий вызов рисует снова.
    this.#remember(scene, camera, viewport, ratio);
    return true;
  }

  /** Цвет фона как RGBA 0–1; без фона или с неразборчивым цветом — прозрачный. */
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

  /** Тот же ли кадр, что нарисован в прошлый раз. */
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
      if (!emptyVao || !corners) throw new Error('Не удалось создать объекты WebGL.');
      res.emptyVao = emptyVao;
      res.corners = corners;
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      res.cover = link(gl, FULLSCREEN_VERTEX, COVER_FRAGMENT, 'cover', shaders);
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
      if (!color) throw new Error('В программе уменьшения кадра нет uColor.');
      entry = { program, color };
      res.downsample.set(factor, entry);
    }
    return entry;
  }

  /**
   * Внутренние буферы для холста `width × height`; пересоздаются только при смене
   * размера. Множитель — наибольший, при котором кадр укладывается в ограничения.
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
    if (!msaa || !resolve || !color || !colorBuffer || !depthBuffer) {
      throw new Error('Не удалось создать буферы кадра WebGL.');
    }
    const targets: Targets = {
      width: w,
      height: h,
      factor,
      msaa,
      resolve,
      color,
      renderbuffers: [colorBuffer, depthBuffer],
    };
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
        `Буфер кадра ${w}×${h} (${samples} выборки) не создан: статус ${msaaStatus}, ${resolveStatus}.`,
      );
    }
    res.targets = targets;
    return targets;
  }

  /** `solid` — первый проход полупрозрачной фигуры: только полностью покрытые пиксели. */
  #draw(res: Resources, bucket: Bucket, frame: GLFrame, solid: boolean): void {
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
      gl.bindVertexArray(program.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, program.buffer);
      const data = bucket.data[kind];
      // Вариант WebGL2 со смещением и длиной: без подмассива на каждый вызов.
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
    if (!vao || !buffer) throw new Error('Не удалось создать объекты WebGL.');
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
    for (const [name, size] of [...source.attributes, ['aColor', 4] as const]) {
      const location = gl.getAttribLocation(program, name);
      if (location >= 0) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
        if (instanced) gl.vertexAttribDivisor(location, 1);
      }
      offset += size * 4;
    }
    gl.bindVertexArray(null);
    // Неиспользуемую в шейдере переменную компилятор выбрасывает, её место — null.
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of ['uHalf', 'uDepth', 'uPx', 'uRayZ', 'uSolid']) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    if (!uniforms.uHalf) throw new Error(`В программе ${kind} нет uHalf.`);
    return { program, vao, buffer, uniforms, instanced };
  }
}

/**
 * Множитель суперсэмплинга для холста `width × height`: наибольший не больше `max`,
 * при котором стороны внутреннего кадра не превышают `limit`, а число пикселей —
 * `PIXEL_BUDGET`.
 */
export function supersampleFor(width: number, height: number, max: number, limit: number): number {
  if (width > limit || height > limit) {
    throw new RangeError(`Холст ${width}×${height} больше предела видеокарты ${limit}.`);
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
  for (const buffer of targets.renderbuffers) gl.deleteRenderbuffer(buffer);
}

const FULLSCREEN_VERTEX = `#version 300 es
void main() {
  // Один треугольник на весь кадр.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const COVER_FRAGMENT = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, 1.0); }
`;

/** Усреднение блока `factor × factor` пикселей внутреннего кадра. */
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

/** Собирает программу; созданные шейдеры добавляет в `shaders`, чтобы потом удалить. */
function link(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  kind: string,
  shaders: WebGLShader[],
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Не удалось создать программу WebGL.');
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
    throw new Error(`Программа ${kind} не собралась: ${log}`);
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
  if (!shader) throw new Error('Не удалось создать шейдер.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Шейдер ${kind} не скомпилировался: ${log}`);
  }
  return shader;
}
