/**
 * Looks you save yourself: your own presets.
 *
 * A look is stored the way the built-in presets are, as offsets from Auto
 * rather than as raw slider positions. That is what lets one look travel
 * between photos: raw values would carry one photo's exposure fix onto a photo
 * that never needed it, while "Auto, plus a bit warmer and a bit more bite"
 * means the same thing on every shot. The colour mix has no Auto part, so it
 * is stored as it is. Areas and framing are left out on purpose - where the
 * dish sits is different in every photo.
 *
 * Kept in localStorage, on this device only. Anything read back is treated as
 * untrusted: it may be from an older version, or hand-edited, so every number
 * is checked and clamped before it can reach the renderer.
 */
import type { AutoResult } from '../engine/auto'
import { RANGES } from '../engine/presets'
import { MIX_BANDS, NEUTRAL_MIX, type Adjustments, type ColourMix, type Edit } from '../engine/types'

export interface Look {
  id: string
  name: string
  /** Offsets from this photo's Auto result, like Preset.delta. */
  delta: Partial<Adjustments>
  mix: ColourMix
}

const KEY = 'darkroom.looks.v1'
export const MAX_LOOKS = 24
export const MAX_NAME = 32

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const num = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : 0

function clean(raw: unknown): Look | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, MAX_NAME) : ''
  const id = typeof r.id === 'string' ? r.id.slice(0, 40) : ''
  if (!name || !id) return null

  const delta: Partial<Adjustments> = {}
  const d = (r.delta ?? {}) as Record<string, unknown>
  for (const key of Object.keys(RANGES) as (keyof Adjustments)[]) {
    const [lo, hi] = RANGES[key]
    // An offset can be at most the full width of the slider.
    const v = num(d[key], lo - hi, hi - lo)
    if (v !== 0) delta[key] = v
  }

  const m = Array.isArray(r.mix) ? r.mix : []
  const mix = MIX_BANDS.map((_, i) => {
    const b = (m[i] ?? {}) as Record<string, unknown>
    return { hue: num(b.hue, -1, 1), sat: num(b.sat, -1, 1), lum: num(b.lum, -1, 1) }
  })
  return { id, name, delta, mix }
}

export function loadLooks(): Look[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(clean).filter((l): l is Look => l !== null).slice(0, MAX_LOOKS)
  } catch {
    return []
  }
}

/** False when the browser refused the write (private browsing, storage full). */
export function saveLooks(looks: Look[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(looks.slice(0, MAX_LOOKS)))
    return true
  } catch {
    return false
  }
}

/** Captures the photo's current look, relative to its own Auto result. */
export function makeLook(name: string, edit: Edit, auto: AutoResult): Look {
  const delta: Partial<Adjustments> = {}
  for (const key of Object.keys(RANGES) as (keyof Adjustments)[]) {
    const d = edit.adjustments[key] - auto.adjustments[key]
    if (Math.abs(d) > 0.004) delta[key] = Math.round(d * 1000) / 1000
  }
  return {
    id: `l${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
    name: name.trim().slice(0, MAX_NAME),
    delta,
    mix: (edit.mix ?? NEUTRAL_MIX).map((b) => ({ ...b })),
  }
}
