/**
 * Auto-enhance.
 *
 * Deliberately transparent: instead of a hidden "magic" filter, Auto writes
 * real values onto the same sliders you can then move. You can always see what
 * it decided and undo any single part of it.
 */
import { pct } from './analysis'
import { solveTemperatureTint } from './renderer'
import { NEUTRAL, type Adjustments, type Analysis, type Levels } from './types'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** sRGB 0.47 in linear light - a slightly bright but safe midtone target. */
const TARGET_MEDIAN_LINEAR = 0.1845

export interface AutoResult {
  adjustments: Adjustments
  levels: Levels
}

export function autoEnhance(a: Analysis): AutoResult {
  // --- levels: stretch to the real black and white points, but never so far
  // that a legitimately low-contrast photo (fog, white plate) gets crushed.
  const rawBlack = pct(a, 0.3)
  const rawWhite = pct(a, 99.7)
  const levels: Levels = {
    black: rawBlack > 0.02 ? Math.min(rawBlack, 0.12) : 0,
    white: rawWhite < 0.97 ? Math.max(rawWhite, 0.8) : 1,
  }

  // --- exposure toward a target median, held back if highlights already clip.
  let exposure = clamp(
    Math.log2(TARGET_MEDIAN_LINEAR / Math.max(a.medianLinear, 1e-4)),
    -1.0,
    1.4,
  )
  if (a.clippedHighlights > 0.02) exposure = Math.min(exposure, 0.25)

  // --- white balance: partial grey-world over the midtones. Full correction
  // would neutralise the warmth that makes food photos look appetising, so we
  // only take part of the way and cap how far it can go.
  const [mr, mg, mb] = a.meanLinear
  const damp = 0.55
  const gr = Math.pow(mg / Math.max(mr, 1e-5), damp)
  const gb = Math.pow(mg / Math.max(mb, 1e-5), damp)
  const solved = solveTemperatureTint(gr, 1, gb)
  const temperature = clamp(solved.temperature, -0.45, 0.45)
  const tint = clamp(solved.tint, -0.3, 0.3)

  // --- tone shaping from where the histogram actually sits.
  const shadows = a.clippedShadows > 0.01 || pct(a, 10) < 0.12 ? 0.28 : 0.12
  const highlights = a.clippedHighlights > 0.005 ? -0.3 : -0.08
  const spread = pct(a, 95) - pct(a, 5)
  const contrast = spread < 0.45 ? 0.22 : spread > 0.8 ? 0.02 : 0.12

  // --- detail: sharpening and denoise pull against each other, so let the
  // measured noise decide the balance.
  const denoise = clamp((a.noiseSigma - 1.6) / 9, 0, 0.75)
  const sharpen = clamp(0.42 - denoise * 0.35, 0.12, 0.45)
  const clarity = clamp(0.18 - denoise * 0.18, 0, 0.18)

  return {
    adjustments: {
      ...NEUTRAL,
      exposure,
      contrast,
      highlights,
      shadows,
      temperature,
      tint,
      vibrance: 0.22,
      saturation: 0.03,
      clarity,
      sharpen,
      denoise,
    },
    levels,
  }
}

/** Plain-language summary of what Auto did, shown under the button. */
export function describeAuto(a: Analysis, r: AutoResult): string[] {
  const notes: string[] = []
  const ev = r.adjustments.exposure
  if (Math.abs(ev) > 0.08) notes.push(`${ev > 0 ? '+' : ''}${ev.toFixed(2)} EV exposure`)
  if (r.levels.black > 0.005 || r.levels.white < 0.995) notes.push('black/white points set')
  if (Math.abs(r.adjustments.temperature) > 0.05) {
    notes.push(r.adjustments.temperature > 0 ? 'warmed up' : 'cooled down')
  }
  if (r.adjustments.denoise > 0.05) {
    notes.push(`noise reduced (sigma ${a.noiseSigma.toFixed(1)})`)
  }
  if (a.clippedHighlights > 0.005) notes.push('highlights pulled back')
  if (notes.length === 0) notes.push('already well exposed - only a light touch applied')
  return notes
}
