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

/**
 * Отрисовка сцены через WebGL2 с глубиной на каждый пиксель: перекрытия и пересечения
 * фигур точные и непрерывные. Шары, капсулы и поверхности — прямоугольники-заглушки,
 * форма и глубина которых считаются в каждом пикселе; заливки — треугольники.
 *
 * Контекст создаётся с `antialias: true` и `stencil: true`: сглаживание краёв идёт через
 * alpha-to-coverage, трафарет держит декали на видимых пикселях их опоры.
 */
export class WebGLRenderer {
  readonly gl: WebGL2RenderingContext;
  readonly #collector = new GLCollector();
  readonly #programs: Record<PrimitiveKind, Program>;
  readonly #corners: WebGLBuffer;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      stencil: true,
      depth: true,
      premultipliedAlpha: true,
      alpha: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 недоступен.');
    this.gl = gl;
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
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
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
      this.#draw(bucket, frame, half, ratio, false);
    }
    // Декали: только поверх видимых пикселей своей опоры, в ближнем диапазоне глубины.
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    for (const bucket of frame.decals) {
      gl.stencilFunc(gl.EQUAL, bucket.stencil, 0xff);
      this.#draw(bucket, frame, half, ratio, true);
    }
    // Полупрозрачное: по порядку, с наложением и без записи глубины.
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    for (const bucket of frame.transparent) this.#draw(bucket, frame, half, ratio, false);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
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
