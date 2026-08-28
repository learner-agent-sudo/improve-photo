/**
 * Measuring a photo before deciding what to do to it.
 *
 * Two samples are taken, for different reasons:
 *  - a 384 px downscale of the whole frame, for the histogram, exposure and
 *    white balance. Downscaling here is fine and fast.
 *  - a 512 px crop at *native* resolution, for the noise estimate. Noise is a
 *    per-pixel property, so measuring it on a downscaled copy would report
 *    almost none and Auto would never denoise a dim restaurant shot.
 */
import { make2dCanvas } from './decode'
import type { Analysis } from './types'

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)

/** Precomputed sRGB->linear for all 256 byte values. */
const LIN = new Float32Array(256)
for (let i = 0; i < 256; i++) LIN[i] = srgbToLinear(i / 255)

const ANALYSIS_EDGE = 384
const NOISE_CROP = 512

function drawScaled(bitmap: ImageBitmap, edge: number): ImageData {
  const s = Math.min(1, edge / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * s))
  const h = Math.max(1, Math.round(bitmap.height * s))
  const { ctx } = make2dCanvas(w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

function drawNativeCrop(bitmap: ImageBitmap, edge: number): ImageData {
  const w = Math.min(edge, bitmap.width)
  const h = Math.min(edge, bitmap.height)
  const sx = Math.floor((bitmap.width - w) / 2)
  const sy = Math.floor((bitmap.height - h) / 2)
  const { ctx } = make2dCanvas(w, h)
  ctx.drawImage(bitmap, sx, sy, w, h, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

/**
 * Immerkaer's fast noise variance estimate: convolve with a Laplacian-like
 * kernel that a smooth image nulls out, then take the mean absolute response.
 * J. Immerkaer, "Fast Noise Variance Estimation", CVIU 64(2), 1996.
 * Returns sigma in 0..255 units.
 */
function estimateNoiseSigma(img: ImageData): number {
  const { width: w, height: h, data } = img
  if (w < 3 || h < 3) return 0
  const gray = new Float32Array(w * h)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  let sum = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const v =
        4 * gray[i] -
        2 * (gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w]) +
        (gray[i - w - 1] + gray[i - w + 1] + gray[i + w - 1] + gray[i + w + 1])
      sum += Math.abs(v)
    }
  }
  return Math.sqrt(Math.PI / 2) * (sum / (6 * (w - 2) * (h - 2)))
}

export function analyseBitmap(bitmap: ImageBitmap): Analysis {
  const img = drawScaled(bitmap, ANALYSIS_EDGE)
  const data = img.data
  const n = data.length / 4

  const hist = new Uint32Array(256)
  let clippedHi = 0
  let clippedLo = 0
  let mr = 0
  let mg = 0
  let mb = 0
  let midCount = 0

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) | 0
    hist[y]++
    if (y >= 250) clippedHi++
    if (y <= 5) clippedLo++
    // Grey-world is only meaningful over midtones: clipped whites and blacks
    // carry no colour information and would drag the estimate to neutral.
    if (y > 38 && y < 230) {
      mr += LIN[r]
      mg += LIN[g]
      mb += LIN[b]
      midCount++
    }
  }

  // Percentile table at 0.1% resolution, interpolated from the 256-bin histogram.
  const percentiles = new Array<number>(1001)
  let acc = 0
  let bin = 0
  for (let q = 0; q <= 1000; q++) {
    const want = (q / 1000) * n
    while (bin < 255 && acc + hist[bin] < want) {
      acc += hist[bin]
      bin++
    }
    percentiles[q] = bin / 255
  }

  const medianSrgb = percentiles[500]
  const k = midCount || 1

  // 64-bin histogram for the panel readout, normalised to its tallest bin.
  const histogram = new Array<number>(64).fill(0)
  for (let i = 0; i < 256; i++) histogram[i >> 2] += hist[i]
  const peak = Math.max(...histogram, 1)
  for (let i = 0; i < 64; i++) histogram[i] /= peak

  return {
    percentiles,
    meanLinear: [mr / k, mg / k, mb / k],
    medianLinear: srgbToLinear(medianSrgb),
    noiseSigma: estimateNoiseSigma(drawNativeCrop(bitmap, NOISE_CROP)),
    clippedHighlights: clippedHi / n,
    clippedShadows: clippedLo / n,
    histogram,
  }
}

/** Percentile lookup by percent (0..100). */
export const pct = (a: Analysis, q: number): number =>
  a.percentiles[Math.min(1000, Math.max(0, Math.round(q * 10)))]
