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
 * Shared vertex shader. The V coordinate is flipped here rather than at upload
 * time so that WebGL's y-up clip space lands the right way round both on
 * screen and in `toBlob`/`readPixels` output.
 */
export const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
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
 * `uXf` maps output UV to source UV, so crop / rotate / straighten cost
 * nothing extra and the export is pixel-identical to the preview.
 * `uLod` is the mip level that matches the export downscale, which keeps
 * 12 MP phone files from aliasing when they land on a 1440 px canvas.
 */
export const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uClean;   // denoised + mipmapped
uniform sampler2D uBlur;    // wide Gaussian, for clarity
uniform sampler2D uOrig;    // untouched source, for the before/after wipe

uniform mat3 uXf;
uniform float uLod;
uniform vec2 uDx;           // source-UV delta for one output pixel in x
uniform vec2 uDy;
uniform vec2 uOutSize;
uniform float uAspect;      // output width / height, for a round vignette
uniform float uSplit;       // wipe position 0..1; negative disables

uniform float uExposure, uContrast, uHighlights, uShadows;
uniform float uBlackPt, uWhitePt;
uniform vec3  uWbGain;
uniform float uVibrance, uSaturation;
uniform float uClarity, uSharpen;
uniform float uVignette, uGrain, uSeed;

${COLOR_HELPERS}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = (uXf * vec3(vUv, 1.0)).xy;

  // Outside the source (only reachable with an extreme straighten) paint the
  // backdrop rather than smearing edge pixels.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.055, 0.051, 0.047, 1.0);
    return;
  }

  if (uSplit >= 0.0 && vUv.x < uSplit) {
    fragColor = vec4(textureLod(uOrig, uv, uLod).rgb, 1.0);
    return;
  }

  vec3 c = textureLod(uClean, uv, uLod).rgb;
  float lo = luma(c);

  // --- linear light: exposure and white balance ---------------------------
  vec3 lin = srgbToLin(c) * exp2(uExposure) * uWbGain;
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
    float n = luma(textureLod(uClean, uv + uDx, uLod).rgb)
            + luma(textureLod(uClean, uv - uDx, uLod).rgb)
            + luma(textureLod(uClean, uv + uDy, uLod).rgb)
            + luma(textureLod(uClean, uv - uDy, uLod).rgb);
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

  // --- vignette -----------------------------------------------------------
  if (abs(uVignette) > 0.001) {
    vec2 p = (vUv - 0.5) * vec2(max(uAspect, 1.0), max(1.0 / uAspect, 1.0));
    float r = length(p) * 1.32;
    c *= 1.0 - uVignette * smoothstep(0.30, 1.05, r) * 0.85;
  }

  // --- grain, plus a permanent sub-LSB dither against 8-bit banding -------
  float n2 = hash12(vUv * uOutSize + uSeed) - 0.5;
  c += n2 * (uGrain * 0.075 + 0.0028);

  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`
