/*
 * WebGL2 shaders. Coordinates are screen 3D (CSS pixels relative to the frame center,
 * y down, z toward the viewer). The view ray at pixel p goes from (p.x, p.y, uRayZ) along −z.
 */

/** Shared fragment shader functions. */
const common = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uDepth;   // zMin, zMax
uniform float uPx;     // internal frame pixels per CSS pixel
uniform float uRayZ;
uniform float uSolid;  // 1 means draw only fully covered pixels (see shade)
in vec2 vPos;
out vec4 outColor;

float depthOf(float z) {
  return clamp((uDepth.y - z) / max(uDepth.y - uDepth.x, 1e-6), 0.0, 1.0);
}

float coverage(float inside) {
  return clamp(inside * uPx + 0.5, 0.0, 1.0);
}

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
  return length(p - a - ab * t);
}

// The ray-sphere intersection point nearest to the viewer, or -1.
float sphereT(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float h = b * b - dot(oc, oc) + r * r;
  return h < 0.0 ? -1.0 : -b - sqrt(h);
}
`;

/** Shared vertex shader for impostors: a rectangle over the primitive's screen bounds. */
function impostorVertex(attributes: string, bounds: string, pass: string): string {
  return /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uHalf;    // half of the frame in CSS pixels
uniform float uPx;
in vec2 aCorner;       // rectangle corners, 0..1
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
// Pixel color with edge coverage. A translucent shape is drawn in two passes: first
// only fully covered pixels, then the edges; the stencil lets each pixel through once.
vec4 shade(float cover) {
  if (uSolid > 0.5 && cover < 1.0) discard;
  return vec4(vColor.rgb, vColor.a * cover);
}
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
  outColor = shade(cover);`,
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
  // Depth: the nearest capsule point on the ray; at the edge the radius taken is at least the distance.
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
    // Segment along the ray: the near end sphere is visible.
    t = sphereT(ro, rd, vA.z > vB.z ? vA : vB, r);
  }
  if (t < 0.0) discard;
  gl_FragDepth = depthOf(ro.z - t);
  outColor = shade(cover);`,
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
  // Only the side surface: the bases are drawn as fills.
  vec3 ba = vB - vA;
  vec3 oc = ro - vA;
  float baba = dot(ba, ba);
  float bard = dot(ba, rd);
  float baoc = dot(ba, oc);
  float k2 = baba - bard * bard;
  if (k2 < 1e-6 * max(baba, 1e-6)) discard;
  float d = segmentDistance(vPos, vA.xy, vB.xy);
  // Radius exactly as for the caps: widening it for antialiasing would leave a rim past the cap edge.
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
  outColor = shade(cover);`,
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
  // The near sphere point if it is on the dome side, otherwise the far one (view inside).
  vec3 near = vec3(vPos, vCenter.z + s);
  vec3 far = vec3(vPos, vCenter.z - s);
  float z;
  if (dot(near - vCenter, vAxis) >= 0.0) z = near.z;
  else if (dot(far - vCenter, vAxis) >= 0.0) { z = far.z; cover = 1.0; }
  else discard;
  gl_FragDepth = depthOf(z);
  outColor = shade(cover);`,
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
  // Cone side surface from the base (radius vRadius) to the apex.
  // Radius exactly as for the base, otherwise the side leaves a rim past its edge.
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
  outColor = shade(1.0);`,
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
in vec3 aPosition;
in vec4 aColor;
flat out vec4 vColor;
void main() {
  float depth = clamp((uDepth.y - aPosition.z) / max(uDepth.y - uDepth.x, 1e-6), 0.0, 1.0);
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
