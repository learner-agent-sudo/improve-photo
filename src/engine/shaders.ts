/**
 * GLSL ES 3.00 sources for the four-pass pipeline.
 *
 * Pass 1  denoise   src            -> texClean   (mipmapped)
 * Pass 2  blur H    texClean(lod2) -> texBlurA   (quarter resolution)
 * Pass 3  blur V    texBlurA       -> texBlurB
 * Pass 4  composite texClean + texBlurB + src -> output
 *
 * All tone maths happens once, in the composite pass, so the image is
 * quantised to 8 bits exactly once.
 */

/**
 * Shared vertex shader.
 *
 * No V flip here, and that is deliberate. Clip space is y-up, and the two kinds
 * of render target disagree about what that means: for a texture attached to a
 * framebuffer, NDC y = -1 is row V = 0, but for the default framebuffer the
 * browser presents NDC y = +1 at the *top* of the HTML canvas. Flipping in the
 * vertex shader would therefore correct the screen while silently inverting
 * every intermediate texture, so the denoised copy would come back upside down
 * relative to the source.
 *
 * Instead every pass shares one orientation - V = 0 is the first uploaded row,
 * the top of the photo - and only the final composite flips, once, when it
 * converts vUv into the output coordinate it hands to the transform.
 */
export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const COLOR_HELPERS = `
vec3 srgbToLin(vec3 c) {
  return mix(c / 12.92, pow(max(c + 0.055, 0.0) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`

/**
 * Pass 1 - edge-preserving denoise.
 *
 * A 5x5 bilateral average. Chroma is smoothed far harder than luma because on
 * phone sensors the objectionable artefact in low light is coloured blotching,
 * while luma grain still reads as texture. Suppressing chroma aggressively and
 * luma gently keeps the picture from turning to plastic.
 */
export const FRAG_DENOISE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uAmount;
${COLOR_HELPERS}
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  if (uAmount <= 0.002) { fragColor = vec4(c, 1.0); return; }

  // Range sigma grows with the slider: wider sigma tolerates bigger
  // differences and therefore smooths more.
  float sigmaR = mix(0.020, 0.140, uAmount);
  float inv2sr = 1.0 / (2.0 * sigmaR * sigmaR);

  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec2 o = vec2(float(x), float(y)) * uTexel;
      vec3 s = texture(uSrc, vUv + o).rgb;
      float d2 = float(x * x + y * y);
      float ws = exp(-d2 / 4.5);              // spatial, sigma ~1.5 texels
      vec3 diff = s - c;
      float wr = exp(-dot(diff, diff) * inv2sr);
      float w = ws * wr;
      sum += s * w;
      wsum += w;
    }
  }
  vec3 avg = sum / max(wsum, 1e-5);

  float lc = luma(c);
  float la = luma(avg);
  vec3 outC = vec3(mix(lc, la, uAmount * 0.65)) + mix(c - lc, avg - la, uAmount * 0.95);
  fragColor = vec4(clamp(outC, 0.0, 1.0), 1.0);
}
`

/**
 * Passes 2-3 - separable Gaussian used as the low-frequency reference for
 * clarity. Runs at quarter resolution off mip level 2, so a wide radius costs
 * almost nothing. Sigma arrives in texels of *this* pass.
 */
export const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform vec2 uDir;      // texel step along the blur axis
uniform float uSigma;   // in texels of this pass
uniform float uLod;
void main() {
  float step0 = max(uSigma * 0.62, 0.5);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    float fi = float(i) * step0;
    float w = exp(-(fi * fi) / (2.0 * uSigma * uSigma));
    sum += textureLod(uSrc, vUv + uDir * fi, uLod).rgb * w;
    wsum += w;
  }
  fragColor = vec4(sum / wsum, 1.0);
}
`

/**
 * Pass 4 - geometry, tone, colour, detail and finish.
 *
 * `uXf` maps output UV to source UV projectively, so crop, rotate, straighten
 * and perspective correction all cost nothing extra and the export is
 * pixel-identical to the preview. The mip level is derived per pixel from the
 * transform's own derivative, which keeps 12 MP phone files from aliasing when
 * they land on a 1440 px canvas and stays correct under perspective, where the
 * minification is not uniform across the frame.
 */
export const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uClean;   // denoised + mipmapped
uniform sampler2D uBlur;    // wide Gaussian, for clarity
uniform sampler2D uOrig;    // untouched source, for the before/after wipe

uniform mat3 uXf;           // output UV -> source UV, projective
uniform vec2 uOutSize;
uniform vec2 uSrcSize;
uniform float uAspect;      // output width / height, for a round vignette
uniform float uSplit;       // wipe position 0..1; negative disables

uniform float uExposure, uContrast, uHighlights, uShadows;
uniform float uBlackPt, uWhitePt;
uniform vec3  uWbGain;
uniform float uVibrance, uSaturation;
uniform float uClarity, uSharpen;
uniform float uVignette, uGrain, uSeed;

// Colour mix: per band, (hue, saturation, brightness), each -1..1.
uniform vec3  uMix[8];
uniform float uMixOn;

// Areas. uFrameXf maps output UV to area UV (see outputToFrame); uFrameUnit
// is the frame's size over its long edge, so distances come out round.
uniform mat3  uFrameXf;
uniform vec2  uFrameUnit;
uniform int   uAreaCount;
uniform vec4  uAreaA[4];     // x, y, kind (0 radial, 1 linear), invert
uniform vec4  uAreaB[4];     // radial: rx, ry, feather; linear: x2, y2
uniform vec3  uAreaGain[4];  // log2 of the linear-light RGB multiplier

${COLOR_HELPERS}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 rgbToHsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}

vec3 hsvToRgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Band centres in degrees (MIX_HUES in types.ts), with red repeated at 360 so
// every hue falls between two of them.
const float MIX_H[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);

// The mix setting at a hue: the two neighbouring bands blended by how far the
// hue sits between their centres. Blending, rather than snapping to the
// nearest band, is what stops a gradient across orange from breaking into a
// visible edge where it crosses from "red" into "orange".
vec3 mixAt(float deg) {
  for (int i = 0; i < 8; i++) {
    if (deg < MIX_H[i + 1]) {
      float t = (deg - MIX_H[i]) / (MIX_H[i + 1] - MIX_H[i]);
      return mix(uMix[i], uMix[(i + 1) % 8], t * t * (3.0 - 2.0 * t));
    }
  }
  return uMix[0];
}

// How strongly area i applies at this point, 0..1.
float areaWeight(int i, vec2 f) {
  vec4 a = uAreaA[i];
  vec4 b = uAreaB[i];
  vec2 p = f * uFrameUnit;
  float w;
  if (a.z < 0.5) {
    vec2 d = (p - a.xy * uFrameUnit) / max(b.xy, vec2(1e-4));
    w = 1.0 - smoothstep(1.0 - b.z, 1.0 + 1e-4, length(d));
  } else {
    vec2 s = a.xy * uFrameUnit;
    vec2 se = b.xy * uFrameUnit - s;
    float t = dot(p - s, se) / max(dot(se, se), 1e-8);
    w = 1.0 - smoothstep(0.0, 1.0, t);
  }
  return a.w > 0.5 ? 1.0 - w : w;
}

void main() {
  // The single flip that turns clip space into image space; see VERT.
  vec2 outUv = vec2(vUv.x, 1.0 - vUv.y);

  // Projective transform: the divide by w is what lets one matrix express both
  // the crop and the perspective correction.
  vec3 p = uXf * vec3(outUv, 1.0);
  if (abs(p.z) < 1e-6) { fragColor = vec4(0.055, 0.051, 0.047, 1.0); return; }
  vec2 uv = p.xy / p.z;

  // Outside the source - reachable by straightening, or by a perspective
  // correction that pulls in area the camera never saw - paint the backdrop
  // rather than smearing edge pixels.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.055, 0.051, 0.047, 1.0);
    return;
  }

  // Analytic derivative of uv with respect to the output pixel, by the quotient
  // rule on p.xy / p.z. Under perspective the scale differs across the frame -
  // the far edge of a rectified plate is squeezed harder than the near edge -
  // so the mip level and the sharpening radius have to be computed per pixel,
  // not passed in as a constant.
  vec3 c0 = uXf[0];
  vec3 c1 = uXf[1];
  float invZ2 = 1.0 / (p.z * p.z);
  vec2 dUVdx = (c0.xy * p.z - p.xy * c0.z) * invZ2 / uOutSize.x;
  vec2 dUVdy = (c1.xy * p.z - p.xy * c1.z) * invZ2 / uOutSize.y;

  vec2 fx = dUVdx * uSrcSize;
  vec2 fy = dUVdy * uSrcSize;
  float lod = max(0.0, 0.5 * log2(max(dot(fx, fx), dot(fy, fy))));

  if (uSplit >= 0.0 && outUv.x < uSplit) {
    fragColor = vec4(textureLod(uOrig, uv, lod).rgb, 1.0);
    return;
  }

  vec3 c = textureLod(uClean, uv, lod).rgb;
  float lo = luma(c);

  // --- linear light: exposure and white balance ---------------------------
  vec3 lin = srgbToLin(c) * exp2(uExposure) * uWbGain;

  // --- areas: local exposure and warmth, in the same linear light ---------
  // Summed in log space, so two overlapping areas compose the way two
  // exposure changes would, in whatever order they were added.
  if (uAreaCount > 0) {
    vec3 fp = uFrameXf * vec3(outUv, 1.0);
    vec2 f = fp.xy / fp.z;
    vec3 logGain = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      if (i >= uAreaCount) break;
      logGain += areaWeight(i, f) * uAreaGain[i];
    }
    lin *= exp2(logGain);
  }
  c = linToSrgb(lin);

  // --- levels -------------------------------------------------------------
  c = clamp((c - uBlackPt) / max(uWhitePt - uBlackPt, 1e-3), 0.0, 1.0);

  // --- shadows and highlights --------------------------------------------
  float l = luma(c);
  float sMask = pow(1.0 - smoothstep(0.0, 0.62, l), 1.5);
  float hMask = smoothstep(0.38, 1.0, l);
  c += uShadows * sMask * 0.55 * (uShadows >= 0.0 ? (1.0 - c) : c);
  c += uHighlights * hMask * 0.55 * (uHighlights >= 0.0 ? (1.0 - c) : c);
  c = clamp(c, 0.0, 1.0);

  // --- contrast: blend toward smoothstep, extrapolate for negative --------
  vec3 sc = c * c * (3.0 - 2.0 * c);
  c = clamp(mix(c, sc, uContrast), 0.0, 1.0);

  // --- clarity: midtone-masked local contrast off the wide blur -----------
  if (abs(uClarity) > 0.001) {
    float lb = luma(texture(uBlur, uv).rgb);
    float detail = lo - lb;
    float la = luma(c);
    float mask = 1.0 - abs(la * 2.0 - 1.0);
    c += uClarity * detail * 1.7 * mask;
  }

  // --- sharpen: unsharp mask measured in output pixels --------------------
  if (uSharpen > 0.001) {
    float n = luma(textureLod(uClean, uv + dUVdx, lod).rgb)
            + luma(textureLod(uClean, uv - dUVdx, lod).rgb)
            + luma(textureLod(uClean, uv + dUVdy, lod).rgb)
            + luma(textureLod(uClean, uv - dUVdy, lod).rgb);
    float hp = lo - n * 0.25;
    hp = sign(hp) * max(abs(hp) - 0.004, 0.0);   // threshold, so grain is left alone
    c += uSharpen * hp * 1.9;
  }
  c = clamp(c, 0.0, 1.0);

  // --- vibrance and saturation -------------------------------------------
  float lum = luma(c);
  float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
  float vib = uVibrance * (1.0 - smoothstep(0.0, 0.72, sat));
  c = clamp(mix(vec3(lum), c, clamp(1.0 + uSaturation + vib, 0.0, 3.0)), 0.0, 1.0);

  // --- colour mix: one colour at a time -----------------------------------
  if (uMixOn > 0.5) {
    vec3 hsv = rgbToHsv(c);
    // Near-greys have no reliable hue - a white plate's is just noise - so
    // they are faded out of the mix rather than tinted by whichever band
    // their noise happens to land in.
    float chroma = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
    vec3 m = mixAt(hsv.x * 360.0) * smoothstep(0.03, 0.22, chroma);

    // Hue: turn toward the neighbouring colours, then put the brightness
    // back, so moving yellow toward orange does not also darken it.
    float l0 = luma(c);
    vec3 turned = hsvToRgb(vec3(fract(hsv.x + m.x * (30.0 / 360.0)), hsv.y, hsv.z));
    c = clamp(turned + (l0 - luma(turned)), 0.0, 1.0);

    float l1 = luma(c);
    c = clamp(mix(vec3(l1), c, 1.0 + m.y), 0.0, 1.0);

    // Brightness as a per-colour exposure, in linear light.
    c = clamp(linToSrgb(srgbToLin(c) * exp2(m.z)), 0.0, 1.0);
  }

  // --- vignette -----------------------------------------------------------
  if (abs(uVignette) > 0.001) {
    vec2 vp = (outUv - 0.5) * vec2(max(uAspect, 1.0), max(1.0 / uAspect, 1.0));
    float r = length(vp) * 1.32;
    c *= 1.0 - uVignette * smoothstep(0.30, 1.05, r) * 0.85;
  }

  // --- grain, plus a permanent sub-LSB dither against 8-bit banding -------
  float n2 = hash12(outUv * uOutSize + uSeed) - 0.5;
  c += n2 * (uGrain * 0.075 + 0.0028);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`
