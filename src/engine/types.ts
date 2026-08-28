/**
 * Core value types for the image engine.
 *
 * Everything in `src/engine` is deliberately UI-free: it takes an ImageBitmap
 * plus plain data and returns pixels. Stage 2 (the collage builder) renders
 * each tile by calling exactly the same pipeline, so a photo looks identical
 * on its own and inside a grid.
 */

/** Tone / colour / detail sliders. All normalised to -1..1 (or 0..1). */
export interface Adjustments {
  /** Exposure in stops, -2..2. Applied in linear light. */
  exposure: number
  /** S-curve strength, -1..1. */
  contrast: number
  /** -1 recovers blown highlights, +1 pushes them up. */
  highlights: number
  /** +1 lifts shadows out of black, -1 deepens them. */
  shadows: number
  /** White point trim, -1..1. */
  whites: number
  /** Black point trim, -1..1. */
  blacks: number

  /** Warm/cool, -1 (cool) .. 1 (warm). Applied in linear light. */
  temperature: number
  /** Green/magenta, -1 (green) .. 1 (magenta). */
  tint: number
  /** Saturation weighted toward already-muted colours, -1..1. */
  vibrance: number
  /** Global saturation, -1..1. */
  saturation: number

  /** Local contrast (midtone punch), -1..1. */
  clarity: number
  /** Unsharp mask at output resolution, 0..1. */
  sharpen: number
  /** Edge-preserving noise reduction, 0..1. */
  denoise: number

  /** Corner darkening, -1 (bright corners) .. 1 (dark corners). */
  vignette: number
  /** Film grain, 0..1. Also masks 8-bit banding in smooth gradients. */
  grain: number
}

export const NEUTRAL: Adjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  vibrance: 0,
  saturation: 0,
  clarity: 0,
  sharpen: 0,
  denoise: 0,
  vignette: 0,
  grain: 0,
}

export type AspectKey =
  | 'original'
  | '1:1'
  | '4:5'
  | '3:4'
  | '9:16'
  | '4:3'
  | '3:2'
  | '16:9'

export const ASPECT_RATIOS: Record<Exclude<AspectKey, 'original'>, number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:4': 3 / 4,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
}

/** Framing: rotation, straightening and the crop rectangle. */
export interface Geometry {
  /** Quarter turns clockwise, 0-3. */
  rotate90: 0 | 1 | 2 | 3
  flipH: boolean
  /** Straighten angle in degrees, -15..15. */
  straighten: number
  aspect: AspectKey
  /** 1 = crop as large as will fit; >1 zooms in. */
  zoom: number
  /** Pan within the frame, -1..1 of the available slack. */
  offsetX: number
  offsetY: number
}

export const NEUTRAL_GEOMETRY: Geometry = {
  rotate90: 0,
  flipH: false,
  straighten: 0,
  aspect: 'original',
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
}

/** Auto-levels endpoints derived from the histogram, in sRGB 0..1. */
export interface Levels {
  black: number
  white: number
}

export const NEUTRAL_LEVELS: Levels = { black: 0, white: 1 }

/** Everything needed to reproduce one edited photo. */
export interface Edit {
  adjustments: Adjustments
  geometry: Geometry
  levels: Levels
}

export const NEUTRAL_EDIT: Edit = {
  adjustments: NEUTRAL,
  geometry: NEUTRAL_GEOMETRY,
  levels: NEUTRAL_LEVELS,
}

export type ExportFormat = 'jpeg' | 'webp' | 'png'

export interface ExportSettings {
  format: ExportFormat
  /** 0..1, ignored for PNG. */
  quality: number
  /** Longest output edge in pixels. 0 means "keep the cropped source size". */
  longEdge: number
}

/** What the histogram/noise analysis found. Drives Auto and is shown in the UI. */
export interface Analysis {
  /** Luminance percentiles in sRGB 0..1. Index i is the i/10-th percentile (length 1001). */
  percentiles: number[]
  /** Mean linear-light channel values over the midtones. */
  meanLinear: [number, number, number]
  /** Median linear luminance. */
  medianLinear: number
  /** Immerkaer noise sigma estimate in 0..255 units, from a native-res crop. */
  noiseSigma: number
  /** Fraction of pixels at or above 250/255. */
  clippedHighlights: number
  /** Fraction of pixels at or below 5/255. */
  clippedShadows: number
  /** 64-bin luminance histogram, scaled so the tallest bin is 1. For display. */
  histogram: number[]
}
