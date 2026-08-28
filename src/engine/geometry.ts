/**
 * Crop / rotate / straighten maths.
 *
 * The whole framing stage is expressed as a single 3x3 affine matrix that maps
 * output UV to source UV. The GPU then samples the source once, so there is no
 * intermediate resample and the export is exactly what the preview showed.
 */
import { ASPECT_RATIOS, type Geometry } from './types'

/** Row-major 3x3. */
type M3 = [number, number, number, number, number, number, number, number, number]

const I: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

function mul(a: M3, b: M3): M3 {
  const o = new Array(9).fill(0) as unknown as M3
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return o
}

const translate = (x: number, y: number): M3 => [1, 0, x, 0, 1, y, 0, 0, 1]
const scale = (x: number, y: number): M3 => [x, 0, 0, 0, y, 0, 0, 0, 1]
const rotate = (rad: number): M3 => {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

/** Maps rotated-frame UV back to original-source UV for each quarter turn. */
const UNROTATE: Record<0 | 1 | 2 | 3, M3> = {
  0: I,
  1: [0, 1, 0, -1, 0, 1, 0, 0, 1],
  2: [-1, 0, 1, 0, -1, 1, 0, 0, 1],
  3: [0, -1, 1, 1, 0, 0, 0, 0, 1],
}

const FLIP_X: M3 = [-1, 0, 1, 0, 1, 0, 0, 0, 1]

/** Source dimensions after the quarter turns are applied. */
export function rotatedSize(w: number, h: number, k: Geometry['rotate90']): [number, number] {
  return k % 2 === 1 ? [h, w] : [w, h]
}

/** Aspect ratio (w/h) the framing will produce. */
export function targetAspect(w: number, h: number, geo: Geometry): number {
  const [rw, rh] = rotatedSize(w, h, geo.rotate90)
  return geo.aspect === 'original' ? rw / rh : ASPECT_RATIOS[geo.aspect]
}

export interface CropFrame {
  /** Crop size in rotated-source pixels. */
  cw: number
  ch: number
  /** Rotated-source dimensions. */
  rw: number
  rh: number
  /** How far the crop may be panned, in rotated-source pixels. */
  slackX: number
  slackY: number
}

/**
 * The largest centred rectangle of the requested aspect that still fits inside
 * the (possibly straightened) source, then shrunk by `zoom`.
 */
export function cropFrame(w: number, h: number, geo: Geometry): CropFrame {
  const [rw, rh] = rotatedSize(w, h, geo.rotate90)
  const a = geo.aspect === 'original' ? rw / rh : ASPECT_RATIOS[geo.aspect]
  const t = (geo.straighten * Math.PI) / 180
  const ct = Math.abs(Math.cos(t))
  const st = Math.abs(Math.sin(t))

  // Fit constraints for a rect of aspect `a` rotated by `t` inside rw x rh.
  let ch = Math.min(rw / (a * ct + st), rh / (a * st + ct))
  const zoom = Math.max(1, geo.zoom)
  ch /= zoom
  const cw = a * ch

  const bboxW = cw * ct + ch * st
  const bboxH = cw * st + ch * ct
  return {
    cw,
    ch,
    rw,
    rh,
    slackX: Math.max(0, (rw - bboxW) / 2),
    slackY: Math.max(0, (rh - bboxH) / 2),
  }
}

/** Native pixel size of the cropped region, before any export resampling. */
export function cropPixelSize(w: number, h: number, geo: Geometry): [number, number] {
  const f = cropFrame(w, h, geo)
  return [Math.max(1, Math.round(f.cw)), Math.max(1, Math.round(f.ch))]
}

/**
 * Builds the output-UV -> source-UV matrix, in the column-major layout
 * `uniformMatrix3fv` expects.
 */
export function buildTransform(w: number, h: number, geo: Geometry): Float32Array {
  const f = cropFrame(w, h, geo)
  const t = (geo.straighten * Math.PI) / 180

  let m: M3 = translate(-0.5, -0.5)
  m = mul(scale(f.cw, f.ch), m)
  m = mul(rotate(t), m)
  m = mul(translate(geo.offsetX * f.slackX, geo.offsetY * f.slackY), m)
  m = mul(translate(f.rw / 2, f.rh / 2), m)
  m = mul(scale(1 / f.rw, 1 / f.rh), m)
  if (geo.flipH) m = mul(FLIP_X, m)
  m = mul(UNROTATE[geo.rotate90], m)

  // row-major -> column-major
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])
}

/** First two columns of the transform: source-UV steps per output pixel. */
export function pixelSteps(
  xf: Float32Array,
  outW: number,
  outH: number,
): { dx: [number, number]; dy: [number, number] } {
  return {
    dx: [xf[0] / outW, xf[1] / outW],
    dy: [xf[3] / outH, xf[4] / outH],
  }
}

/**
 * Final pixel size for a cropped region constrained to a long edge.
 * `longEdge` of 0 keeps the crop's own resolution. Never upscales.
 */
export function outputSize(cropW: number, cropH: number, longEdge: number): [number, number] {
  const native = Math.max(cropW, cropH)
  const target = longEdge > 0 ? Math.min(longEdge, native) : native
  const a = cropW / cropH
  return a >= 1
    ? [Math.max(1, Math.round(target)), Math.max(1, Math.round(target / a))]
    : [Math.max(1, Math.round(target * a)), Math.max(1, Math.round(target))]
}
