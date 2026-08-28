/**
 * 3x3 matrix helpers, row-major.
 *
 * These carry both the affine framing (crop, rotate, straighten) and the
 * projective perspective correction. Keeping them in one representation is what
 * lets the whole framing stage collapse into a single matrix that the GPU
 * applies in one sampling step - no intermediate resample, and the export is
 * pixel-identical to the preview.
 */

/** Row-major: [a b c; d e f; g h i]. */
export type Mat3 = [number, number, number, number, number, number, number, number, number]

export interface Pt {
  x: number
  y: number
}

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9) as Mat3
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return o
}

export const mulAll = (...ms: Mat3[]): Mat3 => ms.reduce(mul, IDENTITY)

export const translate = (x: number, y: number): Mat3 => [1, 0, x, 0, 1, y, 0, 0, 1]
export const scale = (x: number, y: number): Mat3 => [x, 0, 0, 0, y, 0, 0, 0, 1]
export const rotate = (rad: number): Mat3 => {
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

/** Applies the matrix to a point, including the perspective divide. */
export function apply(m: Mat3, x: number, y: number): Pt {
  const w = m[6] * x + m[7] * y + m[8]
  const iw = Math.abs(w) < 1e-12 ? 0 : 1 / w
  return { x: (m[0] * x + m[1] * y + m[2]) * iw, y: (m[3] * x + m[4] * y + m[5]) * iw }
}

export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = f * g - d * i
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return IDENTITY
  const id = 1 / det
  return [
    A * id,
    (c * h - b * i) * id,
    (b * f - c * e) * id,
    B * id,
    (a * i - c * g) * id,
    (c * d - a * f) * id,
    C * id,
    (b * g - a * h) * id,
    (a * e - b * d) * id,
  ]
}

/**
 * The projective map taking the unit square - (0,0), (1,0), (1,1), (0,1) - onto
 * an arbitrary convex quadrilateral given in that same corner order
 * (top-left, top-right, bottom-right, bottom-left).
 *
 * This is the closed form from Heckbert, "Fundamentals of Texture Mapping and
 * Image Warping" (1989), section 2.2. It is exact and needs no least-squares
 * solve, because four point correspondences determine a homography uniquely.
 *
 * Inverting the sense: we want to *undo* a perspective, so the user marks the
 * quadrilateral in the photo that is really a rectangle, and this matrix maps
 * the corrected rectangle back to it. Sampling through it flattens the photo.
 */
export function unitSquareToQuad(q: readonly Pt[]): Mat3 {
  const [p0, p1, p2, p3] = q
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y

  // A parallelogram needs no perspective terms; the general branch would
  // divide by zero here.
  if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1]
  }

  const den = dx1 * dy2 - dx2 * dy1
  if (Math.abs(den) < 1e-12) return IDENTITY // degenerate quad; leave the photo alone
  const g = (dx3 * dy2 - dx2 * dy3) / den
  const h = (dx1 * dy3 - dx3 * dy1) / den

  return [
    p1.x - p0.x + g * p1.x,
    p3.x - p0.x + h * p3.x,
    p0.x,
    p1.y - p0.y + g * p1.y,
    p3.y - p0.y + h * p3.y,
    p0.y,
    g,
    h,
    1,
  ]
}

/** Column-major, as `uniformMatrix3fv` wants it. */
export const toGL = (m: Mat3): Float32Array =>
  new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])
