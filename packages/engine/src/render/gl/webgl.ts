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
   * Во сколько раз по каждой оси внутренний кадр больше холста (суперсэмплинг).
   * Глубина пишется на весь пиксель, поэтому линии пересечения фигур сглаживаются
   * только так. По умолчанию 2; вместе с MSAA это 16 выборок на пиксель для краёв фигур.
   */
  supersample?: number;
}

/** Внутренние буферы кадра: многовыборочный для рисования и обычный для уменьшения. */
interface Targets {
  width: number;
  height: number;
  msaa: WebGLFramebuffer;
  resolve: WebGLFramebuffer;
  color: WebGLTexture;
  renderbuffers: WebGLRenderbuffer[];
}

/**
 * Отрисовка сцены через WebGL2 с глубиной на каждый пиксель: перекрытия и пересечения
 * фигур точные и непрерывные. Шары, капсулы и поверхности — прямоугольники-заглушки,
 * форма и глубина которых считаются в каждом пикселе; заливки — треугольники.
 *
 * Кадр рисуется во внутренний многовыборочный буфер в `supersample` раз больше холста
 * (сглаживание краёв через alpha-to-coverage и MSAA), затем уменьшается с усреднением.
 * Трафарет держит декали на видимых пикселях их опоры.
 */
export class WebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly #collector = new GLCollector();
  readonly #programs: Record<PrimitiveKind, Program>;
  readonly #corners: WebGLBuffer;
  readonly #supersample: number;
  readonly #downsample: WebGLProgram;
  readonly #emptyVao: WebGLVertexArrayObject;
  #targets: Targets | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options: WebGLRendererOptions = {}) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      stencil: false,
      depth: false,
      premultipliedAlpha: true,
      alpha: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 недоступен.');
    this.gl = gl;
    const factor = options.supersample ?? 2;
    if (!(Number.isInteger(factor) && factor >= 1 && factor <= 4)) {
      throw new RangeError(`supersample должен быть целым от 1 до 4, получено ${factor}.`);
    }
    this.#supersample = factor;
    this.#downsample = link(gl, DOWNSAMPLE_VERTEX, downsampleFragment(factor), 'downsample');
    const empty = gl.createVertexArray();
    if (!empty) throw new Error('Не удалось создать объекты WebGL.');
    this.#emptyVao = empty;
    const corners = gl.createBuffer();
    if (!corners) throw new Error('Не удалось создать буфер WebGL.');
    this.#corners = corners;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.#programs = {} as Record<PrimitiveKind, Program>;
    for (const kind of Object.keys(SOURCES) as PrimitiveKind[]) {
      this.#programs[kind] = this.#createProgram(kind, SOURCES[kind]);
    }
  }

  render(scene: Scene, camera: Camera, viewport: Viewport): void {
    const gl = this.gl;
    const ratio = viewport.pixelRatio ?? 1;
    if (!(viewport.width > 0 && viewport.height > 0 && ratio > 0 && Number.isFinite(ratio))) {
      throw new RangeError('Размеры кадра и pixelRatio должны быть положительными.');
    }
    const frame = this.#collector.collect(scene, camera);
    const factor = this.#supersample;
    const targets = this.#ensureTargets(
      gl.drawingBufferWidth * factor,
      gl.drawingBufferHeight * factor,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.msaa);
    gl.viewport(0, 0, targets.width, targets.height);
    const [r, g, b, a] = background(viewport.background);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.stencilMask(0xff);
    gl.clearColor(r * a, g * a, b * a, a);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.STENCIL_TEST);
    const half = [viewport.width / 2, viewport.height / 2] as const;

    // Непрозрачное: глубина, трафарет опор, сглаживание через alpha-to-coverage.
    // Альфа кадра не трогается, чтобы края не просвечивали страницу.
    gl.disable(gl.BLEND);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.colorMask(true, true, true, false);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    for (const bucket of frame.opaque) {
      gl.stencilFunc(gl.ALWAYS, bucket.stencil, 0xff);
      this.#draw(bucket, frame, half, ratio * factor, false);
    }
    // Декали: только поверх видимых пикселей своей опоры, в ближнем диапазоне глубины.
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    for (const bucket of frame.decals) {
      gl.stencilFunc(gl.EQUAL, bucket.stencil, 0xff);
      this.#draw(bucket, frame, half, ratio * factor, true);
    }
    // Полупрозрачное: по порядку, с наложением и без записи глубины.
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    for (const bucket of frame.transparent) this.#draw(bucket, frame, half, ratio * factor, false);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
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
    gl.useProgram(this.#downsample);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, targets.color);
    gl.uniform1i(gl.getUniformLocation(this.#downsample, 'uColor'), 0);
    gl.bindVertexArray(this.#emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  /** Внутренние буферы нужного размера; пересоздаются только при смене размера. */
  #ensureTargets(width: number, height: number): Targets {
    const current = this.#targets;
    if (current && current.width === width && current.height === height) return current;
    const gl = this.gl;
    if (current) {
      gl.deleteFramebuffer(current.msaa);
      gl.deleteFramebuffer(current.resolve);
      gl.deleteTexture(current.color);
      for (const buffer of current.renderbuffers) gl.deleteRenderbuffer(buffer);
    }
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    const msaa = gl.createFramebuffer();
    const resolve = gl.createFramebuffer();
    const color = gl.createTexture();
    const colorBuffer = gl.createRenderbuffer();
    const depthBuffer = gl.createRenderbuffer();
    if (!msaa || !resolve || !color || !colorBuffer || !depthBuffer) {
      throw new Error('Не удалось создать буферы кадра WebGL.');
    }
    gl.bindRenderbuffer(gl.RENDERBUFFER, colorBuffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorBuffer);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      depthBuffer,
    );
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolve);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#targets = {
      width,
      height,
      msaa,
      resolve,
      color,
      renderbuffers: [colorBuffer, depthBuffer],
    };
    return this.#targets;
  }

  #draw(
    bucket: Bucket,
    frame: GLFrame,
    half: readonly [number, number],
    ratio: number,
    decal: boolean,
  ): void {
    const gl = this.gl;
    for (const kind of ORDER) {
      const count = bucket.count(kind);
      if (count === 0) continue;
      const program = this.#programs[kind];
      gl.useProgram(program.program);
      const u = program.uniforms;
      gl.uniform2f(u.uHalf ?? null, half[0], half[1]);
      gl.uniform2f(u.uDepth ?? null, frame.zMin, frame.zMax);
      gl.uniform1f(u.uDecal ?? null, decal ? 1 : 0);
      gl.uniform1f(u.uPx ?? null, ratio);
      gl.uniform1f(u.uRayZ ?? null, frame.zMax + 10);
      gl.bindVertexArray(program.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, program.buffer);
      const data = bucket.data[kind];
      gl.bufferData(gl.ARRAY_BUFFER, data.data.subarray(0, data.length), gl.DYNAMIC_DRAW);
      if (program.instanced) gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      else gl.drawArrays(gl.TRIANGLES, 0, count);
    }
    gl.bindVertexArray(null);
  }

  #createProgram(kind: PrimitiveKind, source: ProgramSource): Program {
    const gl = this.gl;
    const program = gl.createProgram();
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!program || !vao || !buffer) throw new Error('Не удалось создать объекты WebGL.');
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, source.vertex, kind));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, source.fragment, kind));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Программа ${kind} не собралась: ${gl.getProgramInfoLog(program)}`);
    }
    const instanced = kind !== 'fill';
    gl.bindVertexArray(vao);
    if (instanced) {
      const corner = gl.getAttribLocation(program, 'aCorner');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#corners);
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
    const uniforms: Record<string, WebGLUniformLocation | null> = {};
    for (const name of ['uHalf', 'uDepth', 'uDecal', 'uPx', 'uRayZ']) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, vao, buffer, uniforms, instanced };
  }
}

const DOWNSAMPLE_VERTEX = `#version 300 es
void main() {
  // Один треугольник на весь кадр.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
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

function link(
  gl: WebGL2RenderingContext,
  vertex: string,
  fragment: string,
  kind: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('Не удалось создать программу WebGL.');
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex, kind));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment, kind));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Программа ${kind} не собралась: ${gl.getProgramInfoLog(program)}`);
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
    throw new Error(`Шейдер ${kind} не скомпилировался: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

/** Цвет фона как RGBA 0–1; без фона или с неразборчивым цветом — прозрачный. */
function background(css: string | undefined): [number, number, number, number] {
  const c = css ? colorMath.parse(css) : null;
  return c ? [c.r, c.g, c.b, c.a] : [0, 0, 0, 0];
}
