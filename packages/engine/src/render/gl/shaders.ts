/*
 * Шейдеры WebGL2. Координаты — экранное 3D (пиксели CSS относительно центра кадра,
 * y вниз, z к зрителю). Луч взгляда в пикселе p идёт из (p.x, p.y, uRayZ) вдоль −z.
 */

/** Общие функции фрагментных шейдеров. */
const common = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uDepth;   // zMin, zMax
uniform float uDecal;  // 1 — декаль: глубина в отдельном ближнем диапазоне
uniform float uPx;     // пикселей устройства в пикселе CSS
uniform float uRayZ;
in vec2 vPos;
out vec4 outColor;

float depthOf(float z) {
  float d = (uDepth.y - z) / max(uDepth.y - uDepth.x, 1e-6);
  return uDecal > 0.5 ? 0.1 * clamp(d, 0.0, 1.0) : 0.1 + 0.9 * clamp(d, 0.0, 1.0);
}

float coverage(float inside) {
  return clamp(inside * uPx + 0.5, 0.0, 1.0);
}

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
  return length(p - a - ab * t);
}

// Ближняя к зрителю точка пересечения луча со сферой или -1.
float sphereT(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float h = b * b - dot(oc, oc) + r * r;
  return h < 0.0 ? -1.0 : -b - sqrt(h);
}
`;

/** Общий вершинный шейдер заглушек: прямоугольник по экранным габаритам примитива. */
function impostorVertex(attributes: string, bounds: string, pass: string): string {
  return /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uHalf;    // половина кадра в пикселях CSS
uniform float uPx;
in vec2 aCorner;       // углы прямоугольника, 0..1
${attributes}
in vec4 aColor;
out vec2 vPos;
flat out vec4 vColor;
${pass
  .split(';')
  .filter(Boolean)
  .map((line) => `flat out ${line};`)
  .join('\n')}
void main() {
  vec2 lo; vec2 hi;
  ${bounds}
  float margin = 1.0 / uPx + 1.0;
  lo -= margin; hi += margin;
  vec2 p = mix(lo, hi, aCorner);
  vPos = p;
  vColor = aColor;
  ${pass
    .split(';')
    .filter(Boolean)
    .map((line) => {
      const name = line.trim().split(/\s+/)[1] ?? '';
      return `${name} = a${name.slice(1)};`;
    })
    .join('\n  ')}
  gl_Position = vec4(p.x / uHalf.x, -p.y / uHalf.y, 0.0, 1.0);
}
`;
}

function fragment(pass: string, body: string): string {
  return `${common}
flat in vec4 vColor;
${pass
  .split(';')
  .filter(Boolean)
  .map((line) => `flat in ${line};`)
  .join('\n')}
void main() {
  vec3 ro = vec3(vPos, uRayZ);
  vec3 rd = vec3(0.0, 0.0, -1.0);
  ${body}
}
`;
}

const SPHERE_PASS = 'vec3 vCenter; float vRadius;';
export const sphereProgram = {
  vertex: impostorVertex(
    'in vec3 aCenter; in float aRadius;',
    'lo = aCenter.xy - aRadius; hi = aCenter.xy + aRadius;',
    SPHERE_PASS,
  ),
  fragment: fragment(
    SPHERE_PASS,
    /* glsl */ `
  float d = length(vPos - vCenter.xy);
  float cover = coverage(vRadius - d);
  if (cover <= 0.0) discard;
  float r = max(vRadius, d);
  float z = vCenter.z + sqrt(max(r * r - d * d, 0.0));
  gl_FragDepth = depthOf(z);
  outColor = vec4(vColor.rgb, vColor.a * cover);`,
  ),
  attributes: [
    ['aCenter', 3],
    ['aRadius', 1],
  ] as const,
};

const SEGMENT_PASS = 'vec3 vA; vec3 vB; float vRadius;';
const segmentBounds = 'lo = min(aA.xy, aB.xy) - aRadius; hi = max(aA.xy, aB.xy) + aRadius;';

export const capsuleProgram = {
  vertex: impostorVertex('in vec3 aA; in vec3 aB; in float aRadius;', segmentBounds, SEGMENT_PASS),
  fragment: fragment(
    SEGMENT_PASS,
    /* glsl */ `
  float d = segmentDistance(vPos, vA.xy, vB.xy);
  float cover = coverage(vRadius - d);
  if (cover <= 0.0) discard;
  // Глубина: ближайшая точка капсулы на луче; у края берётся радиус не меньше расстояния.
  float r = max(vRadius, d + 1e-3);
  vec3 ba = vB - vA;
  vec3 oa = ro - vA;
  float baba = dot(ba, ba);
  float bard = dot(ba, rd);
  float baoa = dot(ba, oa);
  float rdoa = dot(rd, oa);
  float oaoa = dot(oa, oa);
  float a = baba - bard * bard;
  float t = -1.0;
  if (a > 1e-6 * max(baba, 1e-6)) {
    float b = baba * rdoa - baoa * bard;
    float c = baba * oaoa - baoa * baoa - r * r * baba;
    float h = b * b - a * c;
    if (h >= 0.0) {
      t = (-b - sqrt(h)) / a;
      float y = baoa + t * bard;
      if (y <= 0.0 || y >= baba) t = sphereT(ro, rd, y <= 0.0 ? vA : vB, r);
    }
  } else {
    // Отрезок вдоль луча: видна ближняя сфера-конец.
    t = sphereT(ro, rd, vA.z > vB.z ? vA : vB, r);
  }
  if (t < 0.0) discard;
  gl_FragDepth = depthOf(ro.z - t);
  outColor = vec4(vColor.rgb, vColor.a * cover);`,
  ),
  attributes: [
    ['aA', 3],
    ['aB', 3],
    ['aRadius', 1],
  ] as const,
};

export const cylinderProgram = {
  vertex: impostorVertex('in vec3 aA; in vec3 aB; in float aRadius;', segmentBounds, SEGMENT_PASS),
  fragment: fragment(
    SEGMENT_PASS,
    /* glsl */ `
  // Только боковая поверхность: основания рисуются заливками.
  vec3 ba = vB - vA;
  vec3 oc = ro - vA;
  float baba = dot(ba, ba);
  float bard = dot(ba, rd);
  float baoc = dot(ba, oc);
  float k2 = baba - bard * bard;
  if (k2 < 1e-6 * max(baba, 1e-6)) discard;
  float d = segmentDistance(vPos, vA.xy, vB.xy);
  // Радиус точно как у крышек: расширение ради сглаживания вылезло бы каймой за край крышки.
  float r = vRadius;
  float k1 = baba * dot(oc, rd) - baoc * bard;
  float k0 = baba * dot(oc, oc) - baoc * baoc - r * r * baba;
  float h = k1 * k1 - k2 * k0;
  if (h < 0.0) discard;
  h = sqrt(h);
  float t = (-k1 - h) / k2;
  float y = baoc + t * bard;
  if (y <= 0.0 || y >= baba) {
    t = (-k1 + h) / k2;
    y = baoc + t * bard;
    if (y <= 0.0 || y >= baba) discard;
  }
  float cover = coverage(vRadius - d);
  gl_FragDepth = depthOf(ro.z - t);
  outColor = vec4(vColor.rgb, vColor.a * cover);`,
  ),
  attributes: [
    ['aA', 3],
    ['aB', 3],
    ['aRadius', 1],
  ] as const,
};

const HEMI_PASS = 'vec3 vCenter; float vRadius; vec3 vAxis;';
export const hemisphereProgram = {
  vertex: impostorVertex(
    'in vec3 aCenter; in float aRadius; in vec3 aAxis;',
    'lo = aCenter.xy - aRadius; hi = aCenter.xy + aRadius;',
    HEMI_PASS,
  ),
  fragment: fragment(
    HEMI_PASS,
    /* glsl */ `
  float d = length(vPos - vCenter.xy);
  float cover = coverage(vRadius - d);
  if (cover <= 0.0) discard;
  float r = max(vRadius, d);
  float s = sqrt(max(r * r - d * d, 0.0));
  // Ближняя точка сферы, если она на стороне купола, иначе дальняя (вид внутрь).
  vec3 near = vec3(vPos, vCenter.z + s);
  vec3 far = vec3(vPos, vCenter.z - s);
  float z;
  if (dot(near - vCenter, vAxis) >= 0.0) z = near.z;
  else if (dot(far - vCenter, vAxis) >= 0.0) { z = far.z; cover = 1.0; }
  else discard;
  gl_FragDepth = depthOf(z);
  outColor = vec4(vColor.rgb, vColor.a * cover);`,
  ),
  attributes: [
    ['aCenter', 3],
    ['aRadius', 1],
    ['aAxis', 3],
  ] as const,
};

const CONE_PASS = 'vec3 vBase; vec3 vApex; float vRadius;';
export const coneProgram = {
  vertex: impostorVertex(
    'in vec3 aBase; in vec3 aApex; in float aRadius;',
    'lo = min(aBase.xy - aRadius, aApex.xy); hi = max(aBase.xy + aRadius, aApex.xy);',
    CONE_PASS,
  ),
  fragment: fragment(
    CONE_PASS,
    /* glsl */ `
  // Боковая поверхность конуса от основания (радиус vRadius) к вершине.
  // Радиус точно как у основания, иначе бок вылезет каймой за его край.
  float ra = vRadius;
  vec3 ba = vApex - vBase;
  vec3 oa = ro - vBase;
  float m0 = dot(ba, ba);
  float m1 = dot(oa, ba);
  float m2 = dot(rd, ba);
  float m3 = dot(rd, oa);
  float m5 = dot(oa, oa);
  float hy = m0 + ra * ra;
  float k2 = m0 * m0 - m2 * m2 * hy;
  float k1 = m0 * m0 * m3 - m1 * m2 * hy + m0 * ra * (ra * m2);
  float k0 = m0 * m0 * m5 - m1 * m1 * hy + m0 * ra * (ra * m1 * 2.0 - m0 * ra);
  float h = k1 * k1 - k2 * k0;
  if (h < 0.0 || abs(k2) < 1e-9) discard;
  h = sqrt(h);
  float t = (-k1 - h) / k2;
  float y = m1 + t * m2;
  if (y <= 0.0 || y >= m0) {
    t = (-k1 + h) / k2;
    y = m1 + t * m2;
    if (y <= 0.0 || y >= m0) discard;
  }
  gl_FragDepth = depthOf(ro.z - t);
  outColor = vColor;`,
  ),
  attributes: [
    ['aBase', 3],
    ['aApex', 3],
    ['aRadius', 1],
  ] as const,
};

export const fillProgram = {
  vertex: /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uHalf;
uniform vec2 uDepth;
uniform float uDecal;
in vec3 aPosition;
in vec4 aColor;
flat out vec4 vColor;
void main() {
  float d = clamp((uDepth.y - aPosition.z) / max(uDepth.y - uDepth.x, 1e-6), 0.0, 1.0);
  float depth = uDecal > 0.5 ? 0.1 * d : 0.1 + 0.9 * d;
  vColor = aColor;
  gl_Position = vec4(aPosition.x / uHalf.x, -aPosition.y / uHalf.y, depth * 2.0 - 1.0, 1.0);
}
`,
  fragment: /* glsl */ `#version 300 es
precision highp float;
flat in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }
`,
  attributes: [['aPosition', 3]] as const,
};
