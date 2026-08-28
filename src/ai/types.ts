/**
 * Types for the optional AI second opinion.
 *
 * The model is asked to act as an *eye*, not as a pair of hands: it returns
 * slider values and a written diagnosis, and Darkroom's own GPU pipeline does
 * the actual work at full resolution. See docs/ARCHITECTURE.md for why the
 * alternative - handing the photo to an image-generation model and getting a
 * new picture back - was rejected.
 */
import type { Adjustments } from '../engine/types'

/** Which sliders the model is allowed to propose. Framing stays with the user. */
export type ProposableKey = Extract<
  keyof Adjustments,
  | 'exposure'
  | 'contrast'
  | 'highlights'
  | 'shadows'
  | 'whites'
  | 'blacks'
  | 'temperature'
  | 'tint'
  | 'vibrance'
  | 'saturation'
  | 'clarity'
  | 'sharpen'
  | 'denoise'
>

export const PROPOSABLE_KEYS: ProposableKey[] = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'vibrance',
  'saturation',
  'clarity',
  'sharpen',
  'denoise',
]

export interface ProposedChange {
  key: ProposableKey
  /** The value the model asked for, already clamped into the slider's range. */
  value: number
  /** Whatever the model was clamped from, when it overshot. Shown for honesty. */
  requested?: number
  /** One short line of justification. */
  reason: string
}

export interface AiProposal {
  /** Plain-language summary of what is wrong with the photo. */
  diagnosis: string
  changes: ProposedChange[]
  /** Degrees, -20..20. Present only when the model saw a tilted horizon. */
  straighten?: number
  straightenReason?: string
  /**
   * Whether the photo looks shot off-axis.
   *
   * Deliberately a flag and not a quadrilateral: a vision model's guess at four
   * corner pixels is rough, and a wrong quad actively distorts the picture,
   * which is worse than no suggestion. The user places the corners themselves
   * with the Perspective tool, which is precise.
   */
  perspective?: { recommended: boolean; note: string }
  /** Anything the model flagged that no slider can fix. */
  notes: string[]
}

export type AiTransport = 'proxy' | 'direct'

export interface AiSettings {
  enabled: boolean
  transport: AiTransport
  /** Worker/function URL for proxy mode. */
  proxyUrl: string
  /** Optional shared secret, if the Worker was given an ACCESS_TOKEN. */
  accessToken: string
  /** Only used in direct mode, and only ever stored in this browser. */
  apiKey: string
  model: string
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  transport: 'proxy',
  proxyUrl: '',
  accessToken: '',
  apiKey: '',
  // Model IDs churn - Gemini 2.5 Flash is already scheduled for retirement -
  // so this is an editable default rather than a hard-coded constant.
  model: 'gemini-3.7-flash',
}

export const KNOWN_MODELS = ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.5-flash']

export class AiError extends Error {
  constructor(
    message: string,
    /** A concrete next step for the user, when there is one. */
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'AiError'
  }
}
