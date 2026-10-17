/**
 * WebGL2 renderer for the four-pass pipeline described in shaders.ts.
 *
 * One instance drives the live preview; export creates a short-lived instance
 * at full resolution and disposes it. Both run identical code, so what you see
 * is what you download.
 */
import { buildTransform, outputSize, outputToFrame, resolveCrop, type ViewMode } from './geometry'
import { toGL } from './matrix'
import { FRAG_BLUR, FRAG_COMPOSITE, FRAG_DENOISE, VERT } from './shaders'
import { isNeutralMix, MAX_AREAS, type AreaAdjust, type ColourMix, type Edit } from './types'

export class WebGLUnavailableError extends Error {
  constructor() {
    super(
      'This browser could not start WebGL 2, which Darkroom needs to process images. ' +
        'Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is on.',
    )
    this.name = 'WebGLUnavailableError'
  }
}

/** RGB multipliers for the temperature/tint sliders, normalised to keep luma. */
export function whiteBalanceGain(temperature: number, tint: number): [number, number, number] {
  let r = 1 + temperature * 0.2
  let g = 1
  let b = 1 - temperature * 0.2
  g *= 1 - tint * 0.16
  r *= 1 + tint * 0.08
  b *= 1 + tint * 0.08
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return [r / y, g / y, b / y]
}

/** Inverse of `whiteBalanceGain`, by bisection. Used to show Auto's decision on the sliders. */
export function solveTemperatureTint(
  gr: number,
  gg: number,
  gb: number,
): { temperature: number; tint: number } {
  const err = (t: number, ti: number) => {
    const [r, g, b] = whiteBalanceGain(t, ti)
    return [Math.log(r / g) - Math.log(gr / gg), Math.log(b / g) - Math.log(gb / gg)] as const
  }
  let t = 0
  let ti = 0
  // Coordinate-wise bisection: temperature drives r/b, tint drives g.
  for (let pass = 0; pass < 3; pass++) {
    let lo = -1
    let hi = 1
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      const [er] = err(mid, ti)
      if (er < 0) lo = mid
      else hi = mid
    }
    t = (lo + hi) / 2
    lo = -1
    hi = 1
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      const [, eb] = err(t, mid)
      if (eb < 0) lo = mid
      else hi = mid
    }
    ti = (lo + hi) / 2
  }
  return { temperature: clamp(t, -1, 1), tint: clamp(ti, -1, 1) }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The colour mix flattened for `uniform vec3 uMix[8]`. */
export function packMix(mix: ColourMix): Float32Array {
  const out = new Float32Array(24)
  mix.slice(0, 8).forEach((b, i) => {
    out[i * 3] = clamp(b.hue, -1, 1)
    out[i * 3 + 1] = clamp(b.sat, -1, 1)
    out[i * 3 + 2] = clamp(b.lum, -1, 1)
  })
  return out
}

/**
 * Areas flattened for the three uniform arrays the shader reads. The gain is
 * worked out here, once per frame, rather than per pixel: brightness and
 * warmth become one log2 RGB multiplier, with warmth borrowing the white
 * balance maths so it shifts colour without shifting brightness.
 */
export function packAreas(areas: AreaAdjust[]) {
  const a = new Float32Array(MAX_AREAS * 4)
  const b = new Float32Array(MAX_AREAS * 4)
  const gain = new Float32Array(MAX_AREAS * 3)
  const list = areas.slice(0, MAX_AREAS)
  list.forEach((ar, i) => {
    a.set([ar.x, ar.y, ar.kind === 'linear' ? 1 : 0, ar.invert ? 1 : 0], i * 4)
    b.set(
      ar.kind === 'linear'
        ? [ar.x2, ar.y2, 0, 0]
        : [Math.max(ar.rx, 0.005), Math.max(ar.ry, 0.005), clamp(ar.feather, 0.05, 1), 0],
      i * 4,
    )
    const wb = whiteBalanceGain(clamp(ar.warmth, -1, 1), 0)
    const ev = clamp(ar.exposure, -1.5, 1.5)
    gain.set([ev + Math.log2(wb[0]), ev + Math.log2(wb[1]), ev + Math.log2(wb[2])], i * 3)
  })
  return { count: list.length, a, b, gain }
}

interface Program {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

export interface RenderOptions {
  /** Before/after wipe position, 0..1. Omit or pass < 0 to render the edit only. */
  split?: number
  /** Stable per-photo grain seed. */
  seed?: number
  /**
   * Which framing to draw. The crop and perspective tools need to see beyond
   * the finished crop, so they ask for a wider view of the same photo.
   */
  view?: ViewMode
}

export class Renderer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private gl: WebGL2RenderingContext
  private denoise!: Program
  private blur!: Program
  private composite!: Program
  private vao: WebGLVertexArrayObject | null = null

  private texSrc: WebGLTexture | null = null
  private texClean: WebGLTexture | null = null
  private texBlurA: WebGLTexture | null = null
  private texBlurB: WebGLTexture | null = null
  private fboClean: WebGLFramebuffer | null = null
  private fboA: WebGLFramebuffer | null = null
  private fboB: WebGLFramebuffer | null = null

  private srcW = 0
  private srcH = 0
  private blurW = 0
  private blurH = 0
  /** Denoise amount currently baked into texClean, so we can skip redundant passes. */
  private cleanFor = Number.NaN

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null
    if (!gl) throw new WebGLUnavailableError()
    this.gl = gl
    this.denoise = this.build(VERT, FRAG_DENOISE)
    this.blur = this.build(VERT, FRAG_BLUR)
    this.composite = this.build(VERT, FRAG_COMPOSITE)
    this.buildQuad()
  }

  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number
  }

  private build(vsSrc: string, fsSrc: string): Program {
    const gl = this.gl
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh)
        gl.deleteShader(sh)
        throw new Error(`Shader compile failed: ${log}`)
      }
      return sh
    }
    const vs = compile(gl.VERTEX_SHADER, vsSrc)
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc)
    const program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.bindAttribLocation(program, 0, 'aPos')
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`)
    }
    const uniforms: Record<string, WebGLUniformLocation | null> = {}
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)
      if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name)
    }
    return { program, uniforms }
  }

  private buildQuad() {
    const gl = this.gl
    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
  }

  private allocTexture(w: number, h: number, levels: number): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return tex
  }

  /** Uploads the working image. The bitmap must already fit `maxTextureSize`. */
  setImage(bitmap: ImageBitmap) {
    const gl = this.gl
    this.releaseTextures()
    const w = bitmap.width
    const h = bitmap.height
    this.srcW = w
    this.srcH = h
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1

    this.texSrc = this.allocTexture(w, h, levels)
    gl.bindTexture(gl.TEXTURE_2D, this.texSrc)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    gl.generateMipmap(gl.TEXTURE_2D)

    this.texClean = this.allocTexture(w, h, levels)
    this.fboClean = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboClean)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texClean, 0)

    this.blurW = Math.max(1, Math.ceil(w / 4))
    this.blurH = Math.max(1, Math.ceil(h / 4))
    this.texBlurA = this.allocTexture(this.blurW, this.blurH, 1)
    this.texBlurB = this.allocTexture(this.blurW, this.blurH, 1)
    this.fboA = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texBlurA, 0)
    this.fboB = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texBlurB, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    this.cleanFor = Number.NaN
  }

  /** Output size for a given long edge, honouring the crop aspect. */
  outputSizeFor(edit: Edit, longEdge: number): [number, number] {
    const c = resolveCrop(this.srcW, this.srcH, edit.geometry)
    return outputSize(c.cw, c.ch, longEdge)
  }

  render(outW: number, outH: number, edit: Edit, opts: RenderOptions = {}) {
    const gl = this.gl
    if (!this.texSrc) return
    if (this.canvas.width !== outW || this.canvas.height !== outH) {
      this.canvas.width = outW
      this.canvas.height = outH
    }
    gl.bindVertexArray(this.vao)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const adj = edit.adjustments

    // --- pass 1: denoise (skipped when the amount has not changed) ---------
    if (this.cleanFor !== adj.denoise) {
      gl.useProgram(this.denoise.program)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboClean)
      gl.viewport(0, 0, this.srcW, this.srcH)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.texSrc)
      gl.uniform1i(this.denoise.uniforms.uSrc!, 0)
      gl.uniform2f(this.denoise.uniforms.uTexel!, 1 / this.srcW, 1 / this.srcH)
      gl.uniform1f(this.denoise.uniforms.uAmount!, adj.denoise)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.bindTexture(gl.TEXTURE_2D, this.texClean)
      gl.generateMipmap(gl.TEXTURE_2D)
      this.cleanFor = adj.denoise
    }

    // --- passes 2 and 3: wide separable blur, used as the clarity reference -
    // Radius tracks the long edge so clarity looks the same on any file size.
    const sigma = clamp((0.012 * Math.max(this.srcW, this.srcH)) / 4, 1.2, 26)
    gl.useProgram(this.blur.program)
    gl.viewport(0, 0, this.blurW, this.blurH)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texClean)
    gl.uniform1i(this.blur.uniforms.uSrc!, 0)
    gl.uniform2f(this.blur.uniforms.uDir!, 1 / this.blurW, 0)
    gl.uniform1f(this.blur.uniforms.uSigma!, sigma)
    gl.uniform1f(this.blur.uniforms.uLod!, 2)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB)
    gl.bindTexture(gl.TEXTURE_2D, this.texBlurA)
    gl.uniform2f(this.blur.uniforms.uDir!, 0, 1 / this.blurH)
    gl.uniform1f(this.blur.uniforms.uLod!, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // --- pass 4: composite -------------------------------------------------
    const p = this.composite
    gl.useProgram(p.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, outW, outH)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texClean)
    gl.uniform1i(p.uniforms.uClean!, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.texBlurB)
    gl.uniform1i(p.uniforms.uBlur!, 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.texSrc)
    gl.uniform1i(p.uniforms.uOrig!, 2)

    const xf = buildTransform(this.srcW, this.srcH, edit.geometry, opts.view ?? 'edit')
    gl.uniformMatrix3fv(p.uniforms.uXf!, false, xf)
    gl.uniform2f(p.uniforms.uOutSize!, outW, outH)
    gl.uniform2f(p.uniforms.uSrcSize!, this.srcW, this.srcH)
    gl.uniform1f(p.uniforms.uAspect!, outW / outH)
    gl.uniform1f(p.uniforms.uSplit!, opts.split ?? -1)

    gl.uniform1f(p.uniforms.uExposure!, adj.exposure)
    gl.uniform1f(p.uniforms.uContrast!, adj.contrast)
    gl.uniform1f(p.uniforms.uHighlights!, adj.highlights)
    gl.uniform1f(p.uniforms.uShadows!, adj.shadows)
    gl.uniform1f(
      p.uniforms.uBlackPt!,
      clamp(edit.levels.black - adj.blacks * 0.1, -0.2, 0.45),
    )
    gl.uniform1f(
      p.uniforms.uWhitePt!,
      clamp(edit.levels.white - adj.whites * 0.1, 0.55, 1.25),
    )
    const g = whiteBalanceGain(adj.temperature, adj.tint)
    gl.uniform3f(p.uniforms.uWbGain!, g[0], g[1], g[2])
    gl.uniform1f(p.uniforms.uVibrance!, adj.vibrance)
    gl.uniform1f(p.uniforms.uSaturation!, adj.saturation)
    gl.uniform1f(p.uniforms.uClarity!, adj.clarity)
    gl.uniform1f(p.uniforms.uSharpen!, adj.sharpen)
    gl.uniform1f(p.uniforms.uVignette!, adj.vignette)
    gl.uniform1f(p.uniforms.uGrain!, adj.grain)
    gl.uniform1f(p.uniforms.uSeed!, opts.seed ?? 17)

    const mix = edit.mix
    const mixOn = !!mix && !isNeutralMix(mix)
    gl.uniform1f(p.uniforms.uMixOn!, mixOn ? 1 : 0)
    if (mixOn) gl.uniform3fv(p.uniforms['uMix[0]']!, packMix(mix))

    // Areas are positioned on the rectified photo, which the perspective view
    // does not draw, so they sit that one out.
    const frame = outputToFrame(this.srcW, this.srcH, edit.geometry, opts.view ?? 'edit')
    const areas = frame ? packAreas(edit.areas ?? []) : null
    gl.uniform1i(p.uniforms.uAreaCount!, areas?.count ?? 0)
    if (frame && areas && areas.count > 0) {
      const long = Math.max(frame.rw, frame.rh)
      gl.uniformMatrix3fv(p.uniforms.uFrameXf!, false, toGL(frame.m))
      gl.uniform2f(p.uniforms.uFrameUnit!, frame.rw / long, frame.rh / long)
      gl.uniform4fv(p.uniforms['uAreaA[0]']!, areas.a)
      gl.uniform4fv(p.uniforms['uAreaB[0]']!, areas.b)
      gl.uniform3fv(p.uniforms['uAreaGain[0]']!, areas.gain)
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }

  private releaseTextures() {
    const gl = this.gl
    for (const t of [this.texSrc, this.texClean, this.texBlurA, this.texBlurB]) {
      if (t) gl.deleteTexture(t)
    }
    for (const f of [this.fboClean, this.fboA, this.fboB]) {
      if (f) gl.deleteFramebuffer(f)
    }
    this.texSrc = this.texClean = this.texBlurA = this.texBlurB = null
    this.fboClean = this.fboA = this.fboB = null
  }

  dispose() {
    const gl = this.gl
    this.releaseTextures()
    for (const p of [this.denoise, this.blur, this.composite]) {
      if (p) gl.deleteProgram(p.program)
    }
    if (this.vao) gl.deleteVertexArray(this.vao)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
