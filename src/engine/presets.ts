/**
 * Presets are a character layer on top of Auto, not a replacement for it.
 *
 * Auto handles what is objectively wrong with the file (exposure, cast, noise).
 * A preset then applies the taste part: how a dish, a face or a flat lay wants
 * to look. Keeping them separate means a preset behaves sensibly whether the
 * source was shot in daylight or under a restaurant's tungsten lamps.
 */
import type { Adjustments } from './types'

export interface Preset {
  id: string
  name: string
  hint: string
  /** Offsets applied on top of the Auto result. */
  delta: Partial<Adjustments>
}

export const PRESETS: Preset[] = [
  {
    id: 'auto',
    name: 'Auto',
    hint: 'Measured correction only. Start here.',
    delta: {},
  },
  {
    id: 'dish',
    name: 'Dish',
    hint: 'Food on a table. Warmer, juicier, a touch more bite.',
    delta: {
      temperature: 0.12,
      vibrance: 0.18,
      saturation: 0.05,
      clarity: 0.12,
      shadows: 0.06,
      highlights: -0.06,
      sharpen: 0.06,
    },
  },
  {
    id: 'lowlight',
    name: 'Low light',
    hint: 'Dim restaurant or evening. Lifts and cleans up.',
    delta: { exposure: 0.3, shadows: 0.2, denoise: 0.15, sharpen: -0.05, contrast: 0.05 },
  },
  {
    id: 'daylight',
    name: 'Daylight',
    hint: 'Outdoors and bright. Crisper, more depth.',
    delta: { contrast: 0.1, clarity: 0.1, vibrance: 0.1, highlights: -0.1 },
  },
  {
    id: 'people',
    name: 'People',
    hint: 'Faces in frame. Softer detail, kinder skin.',
    delta: {
      clarity: -0.2,
      sharpen: -0.1,
      shadows: 0.1,
      vibrance: 0.08,
      saturation: -0.02,
      temperature: 0.04,
    },
  },
  {
    id: 'flatlay',
    name: 'Flat lay',
    hint: 'Products and top-down shots. Clean, even, sharp.',
    delta: { whites: 0.15, clarity: 0.2, sharpen: 0.1, vignette: -0.05, shadows: 0.08 },
  },
  {
    id: 'moody',
    name: 'Moody',
    hint: 'Editorial and dark. Deeper corners, film grain.',
    delta: {
      exposure: -0.15,
      contrast: 0.2,
      shadows: -0.12,
      vibrance: 0.05,
      vignette: 0.28,
      temperature: -0.05,
      grain: 0.12,
    },
  },
]

/** Valid range per slider, used to clamp preset arithmetic and UI input. */
export const RANGES: Record<keyof Adjustments, [number, number]> = {
  exposure: [-2, 2],
  contrast: [-1, 1],
  highlights: [-1, 1],
  shadows: [-1, 1],
  whites: [-1, 1],
  blacks: [-1, 1],
  temperature: [-1, 1],
  tint: [-1, 1],
  vibrance: [-1, 1],
  saturation: [-1, 1],
  clarity: [-1, 1],
  sharpen: [0, 1],
  denoise: [0, 1],
  vignette: [-1, 1],
  grain: [0, 1],
}

export function applyPreset(base: Adjustments, preset: Preset): Adjustments {
  const out = { ...base }
  for (const [key, value] of Object.entries(preset.delta) as [keyof Adjustments, number][]) {
    const [lo, hi] = RANGES[key]
    out[key] = Math.min(hi, Math.max(lo, (base[key] ?? 0) + value))
  }
  return out
}
