/**
 * Core value types for the image engine.
 *
 * Everything in `src/engine` is deliberately UI-free: it takes an ImageBitmap
 * plus plain data and returns pixels. Stage 2 (the collage builder) renders
 * each tile by calling exactly the same pipeline, so a photo looks identical
 * on its own and inside a grid.
 */
import type { Pt } from './matrix'

export type { Pt }

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
  | 'free'
  | 'original'
  | '1:1'
  | '4:5'
  | '3:4'
  | '2:3'
  | '9:16'
  | '4:3'
  | '3:2'
  | '16:9'
  | '1.91:1'

export const ASPECT_RATIOS: Record<Exclude<AspectKey, 'original' | 'free'>, number> = {
  '1:1': 1,
  '4:5': 4 / 5,
  '3:4': 3 / 4,
  '2:3': 2 / 3,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  '1.91:1': 1.91,
}

/** A rectangle in normalised 0..1 coordinates. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const FULL_RECT: Rect = { x: 0, y: 0, w: 1, h: 1 }

/** The four corners of the unit square, in the order used everywhere: TL, TR, BR, BL. */
export const UNIT_QUAD: [Pt, Pt, Pt, Pt] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]

/**
 * Framing: perspective correction, then rotation, straightening and the crop.
 *
 * The order matters and is fixed: a photo is first *rectified* (the off-axis
 * shot is flattened to face-on), and only then rotated, straightened and
 * cropped. Doing it the other way round would mean the crop you drew moves as
 * soon as you touch the perspective.
 */
export interface Geometry {
  /** Quarter turns clockwise, 0-3. */
  rotate90: 0 | 1 | 2 | 3
  flipH: boolean
  /** Straighten angle in degrees, -20..20. */
  straighten: number

  /**
   * The quadrilateral in the photo that is really a rectangle, in source UV,
   * corners TL/TR/BR/BL. Null means no perspective correction.
   */
  corners: [Pt, Pt, Pt, Pt] | null
  /** Keystone: -1 leans the top away, +1 leans the bottom away. */
  tiltV: number
  /** Keystone about the vertical axis. */
  tiltH: number

  /** Constrains handle dragging and the ratio buttons. 'free' leaves it open. */
  aspect: AspectKey
  /** The crop, in normalised coordinates of the straightened, rectified frame. */
  crop: Rect
}

export const NEUTRAL_GEOMETRY: Geometry = {
  rotate90: 0,
  flipH: false,
  straighten: 0,
  corners: null,
  tiltV: 0,
  tiltH: 0,
  aspect: 'original',
  crop: { ...FULL_RECT },
}

/** True when the photo is being framed exactly as it was shot. */
export function isNeutralGeometry(g: Geometry): boolean {
  return (
    g.rotate90 === 0 &&
    !g.flipH &&
    g.straighten === 0 &&
    g.corners === null &&
    g.tiltV === 0 &&
    g.tiltH === 0 &&
    g.crop.x === 0 &&
    g.crop.y === 0 &&
    g.crop.w === 1 &&
    g.crop.h === 1
  )
}

/** Auto-levels endpoints derived from the histogram, in sRGB 0..1. */
export interface Levels {
  black: number
  white: number
}

export const NEUTRAL_LEVELS: Levels = { black: 0, white: 1 }

/**
 * The colour mix: hue, saturation and brightness for one colour at a time.
 *
 * Eight bands, as in Lightroom and Snapseed. The centres are uneven on purpose:
 * the warm end of the wheel is where skin, bread, sauces and wood all live, so
 * it gets three bands (red, orange, yellow) inside 60 degrees, while one band
 * is plenty for the stretch from green to aqua.
 */
export const MIX_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
export type MixBand = (typeof MIX_BANDS)[number]
/** Band centres in degrees, matching MIX_BANDS. The shader keeps its own copy. */
export const MIX_HUES = [0, 30, 60, 120, 180, 240, 270, 300]

export interface BandShift {
  /** -1..1, about +/-30 degrees toward the neighbouring colours. */
  hue: number
  /** -1 removes this colour's saturation, +1 doubles it. */
  sat: number
  /** -1..1, about +/-1 stop for this colour only. */
  lum: number
}

/** One entry per band, in MIX_BANDS order. */
export type ColourMix = BandShift[]

export const NEUTRAL_MIX: ColourMix = MIX_BANDS.map(() => ({ hue: 0, sat: 0, lum: 0 }))

export function isNeutralMix(mix: ColourMix | undefined): boolean {
  return !mix || mix.every((b) => b.hue === 0 && b.sat === 0 && b.lum === 0)
}

/**
 * A local adjustment: brighten, darken, warm or cool one part of the photo.
 *
 * Positions are 0..1 across the photo after perspective correction, but
 * before it is turned, mirrored, straightened or cropped. That is what makes an
 * area stay on the dish when the crop moves or the photo is rotated, instead of
 * staying put on the screen while the food slides out from under it. Sizes are
 * fractions of the photo's long edge, so a circle stays round on a portrait.
 */
export interface AreaAdjust {
  id: string
  /** A soft-edged ellipse, or a graduated filter across the frame. */
  kind: 'radial' | 'linear'
  /** Radial: the centre. Linear: the end where the effect is full strength. */
  x: number
  y: number
  /** Radial only: half-width and half-height, as fractions of the long edge. */
  rx: number
  ry: number
  /** Linear only: the end where the effect has faded to nothing. */
  x2: number
  y2: number
  /** Radial only: how much of the radius is a soft fall-off, 0.05..1. */
  feather: number
  /** Radial: affect the outside instead. Linear: run the fade the other way. */
  invert: boolean
  /** Brightness in stops, -1.5..1.5. Applied in linear light, like exposure. */
  exposure: number
  /** -1 (cooler) .. 1 (warmer), without changing brightness. */
  warmth: number
}

/** More than this and the panel turns into a list nobody can read on a phone. */
export const MAX_AREAS = 4

/** Everything needed to reproduce one edited photo. */
export interface Edit {
  adjustments: Adjustments
  geometry: Geometry
  levels: Levels
  /** Optional so an edit made before these existed still renders. */
  mix?: ColourMix
  areas?: AreaAdjust[]
}

export const NEUTRAL_EDIT: Edit = {
  adjustments: NEUTRAL,
  geometry: NEUTRAL_GEOMETRY,
  levels: NEUTRAL_LEVELS,
  mix: NEUTRAL_MIX,
  areas: [],
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
