/**
 * Framing: perspective correction, rotation, straightening and cropping.
 *
 * All of it collapses into one 3x3 matrix mapping output UV to source UV, which
 * the GPU applies in a single sampling step. There is no intermediate resample,
 * the export is pixel-identical to the preview, and - because the matrix is
 * projective rather than merely affine - correcting an off-axis photo costs
 * nothing extra.
 *
 * The chain, right to left, is:
 *
 *   source UV  <-  H  <-  un-rotate  <-  flip  <-  straighten  <-  crop  <- output UV
 *                  |
 *                  perspective: rectified frame -> source
 */
import {
  IDENTITY,
  mul,
  mulAll,
  rotate,
  scale,
  toGL,
  translate,
  unitSquareToQuad,
  type Mat3,
  type Pt,
} from './matrix'
import { ASPECT_RATIOS, UNIT_QUAD, type AspectKey, type Geometry, type Rect } from './types'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Maps rotated-frame UV back to un-rotated frame UV, per quarter turn. */
const UNROTATE: Record<0 | 1 | 2 | 3, Mat3> = {
  0: IDENTITY,
  1: [0, 1, 0, -1, 0, 1, 0, 0, 1],
  2: [-1, 0, 1, 0, -1, 1, 0, 0, 1],
  3: [0, -1, 1, 1, 0, 0, 0, 0, 1],
}

const FLIP_X: Mat3 = [-1, 0, 1, 0, 1, 0, 0, 0, 1]

/** UNROTATE is its own family: the inverse of k quarter turns is 4-k of them. */
export const rotateForward = (k: 0 | 1 | 2 | 3): Mat3 => UNROTATE[((4 - k) % 4) as 0 | 1 | 2 | 3]
export { FLIP_X }

/** Size after the quarter turns. */
export function rotatedSize(w: number, h: number, k: Geometry['rotate90']): [number, number] {
  return k % 2 === 1 ? [h, w] : [w, h]
}

/**
 * The keystone sliders expressed as a quadrilateral, so they and the corner
 * handles share a single representation instead of being two parallel systems.
 * Positive tiltV pushes the top edge wider, which is what you want when a photo
 * was taken looking down at a table.
 */
export function tiltQuad(tiltV: number, tiltH: number): [Pt, Pt, Pt, Pt] {
  const v = clamp(tiltV, -1, 1) * 0.4
  const h = clamp(tiltH, -1, 1) * 0.4
  const top = 0.5 * (1 - v)
  const bottom = 0.5 * (1 + v)
  const left = 0.5 * (1 - h)
  const right = 0.5 * (1 + h)
  return [
    { x: 0.5 - top, y: 0.5 - left },
    { x: 0.5 + top, y: 0.5 - right },
    { x: 0.5 + bottom, y: 0.5 + right },
    { x: 0.5 - bottom, y: 0.5 + left },
  ]
}

/** The rectified-frame -> source-UV homography: corner handles, then tilt. */
export function perspectiveMatrix(geo: Geometry): Mat3 {
  const quad = geo.corners
    ? unitSquareToQuad(geo.corners)
    : IDENTITY
  const tilted =
    geo.tiltV === 0 && geo.tiltH === 0 ? IDENTITY : unitSquareToQuad(tiltQuad(geo.tiltV, geo.tiltH))
  return mul(quad, tilted)
}

/**
 * Pixel dimensions of the rectified frame.
 *
 * When a quadrilateral is flattened, something has to decide the aspect of the
 * rectangle it becomes. Recovering the true one needs the camera's focal
 * length, which a JPEG may not carry, so we take the mean of the opposite edge
 * lengths. For the angles people actually shoot at - a plate from across the
 * table, a menu held at arm's length - that is close, and it is predictable,
 * which matters more than being theoretically optimal.
 */
export function rectifiedSize(w: number, h: number, geo: Geometry): [number, number] {
  if (!geo.corners) return [w, h]
  const px = geo.corners.map((p) => ({ x: p.x * w, y: p.y * h }))
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
  const width = (d(px[0], px[1]) + d(px[3], px[2])) / 2
  const height = (d(px[0], px[3]) + d(px[1], px[2])) / 2
  return [Math.max(16, width), Math.max(16, height)]
}

/** Rectified frame after the quarter turns, in pixels. */
export function framedSize(w: number, h: number, geo: Geometry): [number, number] {
  const [rw, rh] = rectifiedSize(w, h, geo)
  return rotatedSize(rw, rh, geo.rotate90)
}

export interface ResolvedCrop {
  /** Centre and size in framed pixels. */
  cx: number
  cy: number
  cw: number
  ch: number
  /** The framed dimensions the crop is relative to. */
  fw: number
  fh: number
  /** True when straightening forced the crop to shrink. */
  clamped: boolean
}

/**
 * Turns the stored crop rectangle into concrete pixels, shrinking it if the
 * straighten angle would otherwise pull empty corners into frame.
 *
 * This is the behaviour every photo editor has: straightening eats a little of
 * the picture. Better to lose a sliver than to show grey wedges.
 */
export function resolveCrop(w: number, h: number, geo: Geometry): ResolvedCrop {
  const [fw, fh] = framedSize(w, h, geo)
  const t = (geo.straighten * Math.PI) / 180
  const ct = Math.abs(Math.cos(t))
  const st = Math.abs(Math.sin(t))

  let cw = clamp(geo.crop.w, 0.02, 1) * fw
  let ch = clamp(geo.crop.h, 0.02, 1) * fh
  let cx = (clamp(geo.crop.x, -1, 2) + clamp(geo.crop.w, 0.02, 1) / 2) * fw
  let cy = (clamp(geo.crop.y, -1, 2) + clamp(geo.crop.h, 0.02, 1) / 2) * fh

  // Shrink about the centre until the rotated rectangle fits the frame.
  const bboxW = cw * ct + ch * st
  const bboxH = cw * st + ch * ct
  const s = Math.min(1, fw / bboxW, fh / bboxH)
  const clamped = s < 0.9999
  cw *= s
  ch *= s

  // Then slide it back inside.
  const halfW = (cw * ct + ch * st) / 2
  const halfH = (cw * st + ch * ct) / 2
  cx = clamp(cx, halfW, fw - halfW)
  cy = clamp(cy, halfH, fh - halfH)

  return { cx, cy, cw, ch, fw, fh, clamped }
}

/** Aspect ratio the framing produces. */
export function targetAspect(w: number, h: number, geo: Geometry): number {
  const c = resolveCrop(w, h, geo)
  return c.cw / c.ch
}

/** Native pixel size of the cropped region, before any export resampling. */
export function cropPixelSize(w: number, h: number, geo: Geometry): [number, number] {
  const c = resolveCrop(w, h, geo)
  return [Math.max(1, Math.round(c.cw)), Math.max(1, Math.round(c.ch))]
}

/**
 * How the stage is showing the photo. The crop and perspective tools need to
 * see more than the finished framing: you cannot drag a crop handle outwards if
 * the app is only drawing you what is already inside the crop.
 */
export type ViewMode = 'edit' | 'crop' | 'perspective'

/**
 * In crop mode we draw the whole straightened frame, so the crop box has
 * somewhere to grow into. This is that view's rectangle, in framed pixels.
 */
export function fullViewSize(w: number, h: number, geo: Geometry): [number, number] {
  const [fw, fh] = framedSize(w, h, geo)
  const t = (geo.straighten * Math.PI) / 180
  const ct = Math.abs(Math.cos(t))
  const st = Math.abs(Math.sin(t))
  // Bounding box of the frame once rotated, plus a small margin so the edges
  // of the photo stay visible rather than sitting flush against the viewport.
  return [(fw * ct + fh * st) * 1.06, (fw * st + fh * ct) * 1.06]
}

/**
 * Output UV -> area UV: 0..1 across the photo after perspective correction,
 * before it is turned, mirrored, straightened or cropped (see AreaAdjust).
 * `rw`/`rh` are that rectangle's size in pixels.
 *
 * This is everything in `transformFor` except the perspective step, so it is
 * affine. It is null in the perspective view, which deliberately draws the
 * uncorrected photo and so has no rectified frame to speak of.
 */
export function outputToFrame(
  w: number,
  h: number,
  geo: Geometry,
  view: ViewMode = 'edit',
): { m: Mat3; rw: number; rh: number } | null {
  if (view === 'perspective') return null
  const { m, fw, fh } = frameChain(w, h, geo, view)
  const [rw, rh] = rectifiedSize(w, h, geo)
  return {
    m: mulAll(UNROTATE[geo.rotate90], geo.flipH ? FLIP_X : IDENTITY, scale(1 / fw, 1 / fh), m),
    rw,
    rh,
  }
}

/** Output UV -> framed pixels, shared by `transformFor` and `outputToFrame`. */
function frameChain(w: number, h: number, geo: Geometry, view: ViewMode) {
  const straighten = view === 'perspective' ? 0 : geo.straighten

  let fw: number
  let fh: number
  let cx: number
  let cy: number
  let cw: number
  let ch: number

  if (view === 'edit') {
    const c = resolveCrop(w, h, geo)
    ;({ fw, fh, cx, cy, cw, ch } = c)
  } else if (view === 'crop') {
    ;[fw, fh] = framedSize(w, h, geo)
    ;[cw, ch] = fullViewSize(w, h, geo)
    cx = fw / 2
    cy = fh / 2
  } else {
    // Perspective mode shows the untouched photo, only turned the right way up.
    ;[fw, fh] = rotatedSize(w, h, geo.rotate90)
    cw = fw
    ch = fh
    cx = fw / 2
    cy = fh / 2
  }

  const t = (straighten * Math.PI) / 180
  const m = mulAll(translate(cx, cy), rotate(t), scale(cw, ch), translate(-0.5, -0.5))
  return { m, fw, fh }
}

/** Builds the output-UV -> source-UV matrix for a given view. */
export function transformFor(w: number, h: number, geo: Geometry, view: ViewMode = 'edit'): Mat3 {
  const perspective = view === 'perspective' ? IDENTITY : perspectiveMatrix(geo)
  const { m, fw, fh } = frameChain(w, h, geo, view)
  return mulAll(
    perspective,
    UNROTATE[geo.rotate90],
    geo.flipH ? FLIP_X : IDENTITY,
    scale(1 / fw, 1 / fh),
    m,
  )
}

export function buildTransform(
  w: number,
  h: number,
  geo: Geometry,
  view: ViewMode = 'edit',
): Float32Array {
  return toGL(transformFor(w, h, geo, view))
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

/** Numeric ratio for an aspect key, or null when the crop is unconstrained. */
export function aspectRatio(key: AspectKey, frameW: number, frameH: number): number | null {
  if (key === 'free') return null
  if (key === 'original') return frameW / frameH
  return ASPECT_RATIOS[key]
}

/** The largest centred rectangle of the given ratio that fits the frame. */
export function centredCrop(ratio: number | null, frameW: number, frameH: number): Rect {
  if (ratio === null) return { x: 0, y: 0, w: 1, h: 1 }
  const frameRatio = frameW / frameH
  if (ratio >= frameRatio) {
    const h = frameRatio / ratio
    return { x: 0, y: (1 - h) / 2, w: 1, h }
  }
  const w = ratio / frameRatio
  return { x: (1 - w) / 2, y: 0, w, h: 1 }
}

export { UNIT_QUAD }

/**
 * The crop expressed in the coordinates the crop tool actually works in.
 *
 * Both the crop box and the wide "crop mode" view are rotated by the same
 * straighten angle, which is what produces the familiar behaviour: the box
 * stays square to the screen and the photo tilts underneath it.
 *
 * `ex`/`ey` are the crop centre's offset from the frame centre, measured in
 * that straightened space, in pixels.
 */
export interface CropInView {
  ex: number
  ey: number
  cw: number
  ch: number
  vw: number
  vh: number
}

export function cropInViewSpace(w: number, h: number, geo: Geometry): CropInView {
  const c = resolveCrop(w, h, geo)
  const [vw, vh] = fullViewSize(w, h, geo)
  const t = (geo.straighten * Math.PI) / 180
  const dx = c.cx - c.fw / 2
  const dy = c.cy - c.fh / 2
  return {
    ex: Math.cos(t) * dx + Math.sin(t) * dy,
    ey: -Math.sin(t) * dx + Math.cos(t) * dy,
    cw: c.cw,
    ch: c.ch,
    vw,
    vh,
  }
}

/** The inverse of `cropInViewSpace`: back to a storable normalised rectangle. */
export function cropRectFromViewSpace(
  w: number,
  h: number,
  geo: Geometry,
  ex: number,
  ey: number,
  cw: number,
  ch: number,
): Rect {
  const [fw, fh] = framedSize(w, h, geo)
  const t = (geo.straighten * Math.PI) / 180
  const dx = Math.cos(t) * ex - Math.sin(t) * ey
  const dy = Math.sin(t) * ex + Math.cos(t) * ey
  const cx = fw / 2 + dx
  const cy = fh / 2 + dy
  return {
    x: cx / fw - cw / fw / 2,
    y: cy / fh - ch / fh / 2,
    w: cw / fw,
    h: ch / fh,
  }
}

/** Where the crop box sits inside the crop-mode view, in 0..1 of that view. */
export function cropBoxInView(w: number, h: number, geo: Geometry) {
  const v = cropInViewSpace(w, h, geo)
  return {
    left: 0.5 + (v.ex - v.cw / 2) / v.vw,
    top: 0.5 + (v.ey - v.ch / 2) / v.vh,
    width: v.cw / v.vw,
    height: v.ch / v.vh,
  }
}

/**
 * Source UV -> perspective-view UV. The perspective tool draws the photo with
 * only the quarter turns and mirroring applied, so the corner handles have to
 * be mapped through those and nothing else.
 */
export function toPerspectiveView(geo: Geometry): Mat3 {
  const unrotate = rotateForward(geo.rotate90)
  return geo.flipH ? mul(FLIP_X, unrotate) : unrotate
}

/** The inverse of `toPerspectiveView`: where a dragged handle lands in the source. */
export function fromPerspectiveView(geo: Geometry): Mat3 {
  return mul(UNROTATE[geo.rotate90], geo.flipH ? FLIP_X : IDENTITY)
}
