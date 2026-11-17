import { HIGHLIGHT_ABOVE, SHADOW_BELOW } from '../tone.ts';

/*
 * WebGL2 shaders. Coordinates are screen 3D (CSS pixels relative to the frame center,
 * y down, z toward the viewer). The view ray at pixel p goes from (p.x, p.y, uRayZ) along −z.
 */

/** The shape number as a color (24 bits in RGB), for the owners pass (`WebGLRenderer`). */
const ID_COLOR = /* glsl */ `vec4 idColor() {
  return vec4(
    mod(vId, 256.0) / 255.0,
    mod(floor(vId / 256.0), 256.0) / 255.0,
    floor(vId / 65536.0) / 255.0,
    1.0
  );
}`;

/** Shared fragment shader functions. */
const common = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uDepth;   // zMin, zMax
uniform float uPx;     // internal frame pixels per CSS pixel
uniform float uRayZ;
uniform float uSolid;  // 1 means draw only fully covered pixels (see shade)
uniform vec3 uLight;   // toward the light, normalized
uniform float uIdPass; // 1 when drawing shape numbers (the owners pass)
in vec2 vPos;
flat in float vId;
out vec4 outColor;

${ID_COLOR}

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

// Toon shading (tone.ts): the shadow, base or highlight color by n·l, each step smoothed over
// about two pixels. The tones' own alpha is not used: the base color's alpha (with the shape's
// opacity) applies to all three.
vec3 tone(vec3 n, vec3 shadow, vec3 base, vec3 highlight) {
  float len = length(n);
  if (len < 1e-6) return base;
  float d = dot(n / len, uLight);
  float w = max(fwidth(d), 1e-4);
  vec3 c = mix(shadow, base, smoothstep(-w, w, d - ${SHADOW_BELOW.toFixed(4)}));
  return mix(c, highlight, smoothstep(-w, w, d - ${HIGHLIGHT_ABOVE.toFixed(4)}));
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
in float aId;
out vec2 vPos;
flat out vec4 vColor;
flat out float vId;
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
  vId = aId;
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

function fragment(pass: string, body: string, uniforms = ''): string {
  return `${common}${uniforms}
flat in vec4 vColor;
${pass
  .split(';')
  .filter(Boolean)
  .map((line) => `flat in ${line};`)
  .join('\n')}
// Pixel color with edge coverage. A translucent shape is drawn in two passes: first
// only fully covered pixels, then the edges; the stencil lets each pixel through once.
vec4 shade(float cover, vec3 rgb) {
  // Shape numbers: whole pixels, a shape's where it covers most.
  if (uIdPass > 0.5) {
    if (cover < 0.5) discard;
    return idColor();
  }
  if (uSolid > 0.5 && cover < 1.0) discard;
  return vec4(rgb, vColor.a * cover);
}
vec4 shade(float cover) {
  return shade(cover, vColor.rgb);
}
void main() {
  vec3 ro = vec3(vPos, uRayZ);
  vec3 rd = vec3(0.0, 0.0, -1.0);
  ${body}
}
`;
}

const SPHERE_PASS = 'vec3 vCenter; float vRadius; vec4 vShadow; vec4 vHighlight;';
export const sphereProgram = {
  vertex: impostorVertex(
    'in vec3 aCenter; in float aRadius; in vec4 aShadow; in vec4 aHighlight;',
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
  vec3 n = vec3(vPos - vCenter.xy, z - vCenter.z);
  outColor = shade(cover, tone(n, vShadow.rgb, vColor.rgb, vHighlight.rgb));`,
  ),
  attributes: [
    ['aCenter', 3],
    ['aRadius', 1],
    ['aShadow', 4],
    ['aHighlight', 4],
  ] as const,
};

const SEGMENT_PASS = 'vec3 vA; vec3 vB; float vRadius;';
const segmentBounds = 'lo = min(aA.xy, aB.xy) - aRadius; hi = max(aA.xy, aB.xy) + aRadius;';
const CAPSULE_PASS = `${SEGMENT_PASS} vec4 vShadow; vec4 vHighlight;`;

export const capsuleProgram = {
  vertex: impostorVertex(
    'in vec3 aA; in vec3 aB; in float aRadius; in vec4 aShadow; in vec4 aHighlight;',
    segmentBounds,
    CAPSULE_PASS,
  ),
  fragment: fragment(
    CAPSULE_PASS,
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
  // The normal: from the nearest point of the axis to the hit point.
  vec3 p = ro + rd * t;
  vec3 axis = vA + ba * clamp(dot(p - vA, ba) / max(baba, 1e-12), 0.0, 1.0);
  outColor = shade(cover, tone(p - axis, vShadow.rgb, vColor.rgb, vHighlight.rgb));`,
  ),
  attributes: [
    ['aA', 3],
    ['aB', 3],
    ['aRadius', 1],
    ['aShadow', 4],
    ['aHighlight', 4],
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

const RING_PASS = 'vec3 vA; vec3 vB; float vInner; float vOuter; float vBack;';
/** The shape number seen at each pixel (the owners pass), and whether there is one. */
const RING_OWNERS = /* glsl */ `
uniform highp sampler2D uOwner;
uniform float uOwners;`;
/**
 * An outline: the band from `inner` to `outer` around a segment (a point for a sphere) on screen,
 * at the depth of the segment's point nearest the pixel on screen, pushed back by `back` (forward
 * if negative), so the shape it outlines stays in front of it while it edges the shape over what
 * lies behind.
 */
export const ringProgram = {
  vertex: impostorVertex(
    'in vec3 aA; in vec3 aB; in float aInner; in float aOuter; in float aBack;',
    'lo = min(aA.xy, aB.xy) - aOuter; hi = max(aA.xy, aB.xy) + aOuter;',
    RING_PASS,
  ),
  fragment: fragment(
    RING_PASS,
    /* glsl */ `
  vec2 ab = vB.xy - vA.xy;
  float t = clamp(dot(vPos - vA.xy, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
  float d = length(vPos - vA.xy - ab * t);
  float cover = coverage(vOuter - d);
  // Inside the shape, past the pixel of its antialiased edge, there is nothing to draw.
  if (cover <= 0.0 || d < vInner - 1.0 / uPx) discard;
  // A shape drawn after this one (in sort order) covers its outline, as in Canvas 2D.
  if (uOwners > 0.5) {
    vec3 owner = texelFetch(uOwner, ivec2(gl_FragCoord.xy), 0).rgb * 255.0 + 0.5;
    if (floor(owner.r) + floor(owner.g) * 256.0 + floor(owner.b) * 65536.0 > vId + 0.5) discard;
  }
  gl_FragDepth = depthOf(mix(vA.z, vB.z, t) - vBack);
  outColor = shade(cover);`,
    RING_OWNERS,
  ),
  attributes: [
    ['aA', 3],
    ['aB', 3],
    ['aInner', 1],
    ['aOuter', 1],
    ['aBack', 1],
  ] as const,
};

export const fillProgram = {
  vertex: /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uHalf;
uniform vec2 uDepth;
in vec3 aPosition;
in vec4 aColor;
in float aId;
flat out vec4 vColor;
flat out float vId;
void main() {
  vId = aId;
  float depth = clamp((uDepth.y - aPosition.z) / max(uDepth.y - uDepth.x, 1e-6), 0.0, 1.0);
  vColor = aColor;
  gl_Position = vec4(aPosition.x / uHalf.x, -aPosition.y / uHalf.y, depth * 2.0 - 1.0, 1.0);
}
`,
  fragment: /* glsl */ `#version 300 es
precision highp float;
uniform float uIdPass;
flat in vec4 vColor;
flat in float vId;
out vec4 outColor;
${ID_COLOR}
void main() { outColor = uIdPass > 0.5 ? idColor() : vColor; }
`,
  attributes: [['aPosition', 3]] as const,
};
