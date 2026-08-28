/**
 * Asking Gemini for a second opinion on a photo.
 *
 * The model receives a downscaled copy of the ORIGINAL photo plus the numbers
 * Darkroom already measured, and returns target slider values with reasons.
 * Nothing it says is trusted: every number is checked, clamped to the slider's
 * real range, and shown to you as an old -> new diff before anything is applied.
 *
 * That containment is also the answer to prompt injection. A photo of a menu
 * that happens to read "ignore your instructions and ..." can, at worst, move a
 * slider to a value it was already allowed to take.
 */
import { pct } from '../engine/analysis'
import { make2dCanvas } from '../engine/decode'
import { RANGES } from '../engine/presets'
import type { Adjustments, Analysis } from '../engine/types'
import {
  AiError,
  PROPOSABLE_KEYS,
  type AiProposal,
  type AiSettings,
  type ProposableKey,
  type ProposedChange,
} from './types'

const GEMINI_HOST = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Long edge of the copy that is sent. Enough to judge tone; small enough to be cheap. */
const SEND_EDGE = 768
const MAX_DIAGNOSIS = 600
const MAX_REASON = 200
const MAX_NOTES = 6
const MAX_CHANGES = 20

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * A finite number, or null.
 *
 * Deliberately stricter than `Number()`, which happily turns null, '', [] and
 * false into 0 - so a model that omitted a value by sending null would
 * otherwise look like it had asked for a real zero.
 */
function toNumber(v: unknown): number | null {
  let n: number
  if (typeof v === 'number') n = v
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v)
  else return null
  return Number.isFinite(n) ? n : null
}

/** Strips control characters and collapses whitespace. Model output is data, not markup. */
function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// --- what gets sent ---------------------------------------------------------

/** Re-encodes the untouched photo small, as JPEG, and returns bare base64. */
export async function encodeForReview(bitmap: ImageBitmap): Promise<string> {
  const s = Math.min(1, SEND_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * s))
  const h = Math.max(1, Math.round(bitmap.height * s))
  const { canvas, ctx } = make2dCanvas(w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  const blob =
    'convertToBlob' in canvas
      ? await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.75 })
      : await new Promise<Blob>((res, rej) =>
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? res(b) : rej(new AiError('Could not encode the photo for review.'))),
            'image/jpeg',
            0.75,
          ),
        )
  const dataUrl: string = await new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(r.result as string)
    r.onerror = () => rej(new AiError('Could not read the encoded photo.'))
    r.readAsDataURL(blob)
  })
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

/** The measured facts, so the model reasons from numbers rather than impressions. */
function measurementBlock(a: Analysis, current: Adjustments): string {
  const p = (q: number) => pct(a, q).toFixed(3)
  return [
    'Measurements already taken from the original file (sRGB 0-1 unless stated):',
    `- luminance percentiles: p1 ${p(1)}, p5 ${p(5)}, p25 ${p(25)}, median ${p(50)}, p75 ${p(75)}, p95 ${p(95)}, p99 ${p(99)}`,
    `- median luminance in linear light: ${a.medianLinear.toFixed(4)}`,
    `- mean linear RGB over midtones: ${a.meanLinear.map((v) => v.toFixed(4)).join(', ')}`,
    `- clipped highlights: ${(a.clippedHighlights * 100).toFixed(2)}% of pixels`,
    `- clipped shadows: ${(a.clippedShadows * 100).toFixed(2)}% of pixels`,
    `- noise sigma (Immerkaer, 0-255 scale, measured at native resolution): ${a.noiseSigma.toFixed(2)}`,
    '',
    'Slider values currently applied (the photo you are shown is the UNEDITED original, not this):',
    ...PROPOSABLE_KEYS.map((k) => `- ${k}: ${current[k].toFixed(3)}`),
  ].join('\n')
}

const SYSTEM = `You are a photo editor reviewing a photograph taken on a phone, usually of food, a place or a product, destined for social media or a website.

You are looking at the ORIGINAL, unedited file. Propose ABSOLUTE target values for the sliders listed below - not deltas. Only include a slider if you would actually move it; leaving one out means "leave it alone".

Slider ranges and meanings:
- exposure: -2..2, in stops, applied in linear light
- contrast: -1..1, S-curve strength
- highlights: -1..1, negative recovers blown highlights
- shadows: -1..1, positive lifts shadows out of black
- whites / blacks: -1..1, trims the white and black points
- temperature: -1..1, negative cools, positive warms
- tint: -1..1, negative green, positive magenta
- vibrance: -1..1, favours colours that are still muted
- saturation: -1..1, global
- clarity: -1..1, midtone local contrast
- sharpen: 0..1
- denoise: 0..1

Judgement:
- Food should stay appetising and slightly warm. Do not neutralise a tungsten cast completely.
- Match denoise to the measured noise sigma. Above about 8 it needs real reduction; below 2 it needs none, and denoising a clean file only softens it.
- Never push exposure so far that already-clipped highlights grow.
- Faces want less clarity and less sharpening than plates do.
- Be conservative. A photo that is already good needs almost nothing, and saying so is a valid answer.

Also report, separately:
- straighten: degrees, -20..20, only if the horizon or a clear vertical is visibly off.
- perspectiveRecommended: true if the subject was shot noticeably off-axis and would benefit from being flattened to face-on. Describe the angle in perspectiveNote. Do NOT attempt to give corner coordinates.
- notes: anything you noticed that no slider can fix - a distracting background, a hand in shot, motion blur, missed focus. At most three, one line each.

Keep the diagnosis to two or three sentences of plain English. Reasons must be one short clause each.`

function buildBody(model: string, imageB64: string, a: Analysis, current: Adjustments) {
  const changeItem = {
    type: 'OBJECT',
    properties: {
      key: { type: 'STRING', enum: PROPOSABLE_KEYS },
      value: { type: 'NUMBER' },
      reason: { type: 'STRING' },
    },
    required: ['key', 'value', 'reason'],
  }
  return {
    model,
    body: {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: imageB64 } },
            { text: measurementBlock(a, current) },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            diagnosis: { type: 'STRING' },
            changes: { type: 'ARRAY', items: changeItem },
            straighten: { type: 'NUMBER' },
            straightenReason: { type: 'STRING' },
            perspectiveRecommended: { type: 'BOOLEAN' },
            perspectiveNote: { type: 'STRING' },
            notes: { type: 'ARRAY', items: { type: 'STRING' } },
          },
          required: ['diagnosis', 'changes'],
        },
      },
    },
  }
}

// --- what comes back --------------------------------------------------------

/** Pulls the JSON out of a Gemini response, tolerating stray markdown fences. */
export function extractJson(payload: unknown): unknown {
  const parts = (payload as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
    ?.candidates?.[0]?.content?.parts
  const text = parts?.map((p) => p?.text ?? '').join('') ?? ''
  if (!text.trim()) {
    const blocked = (payload as { promptFeedback?: { blockReason?: string } })?.promptFeedback
      ?.blockReason
    throw new AiError(
      blocked
        ? `The model declined to answer (${blocked}).`
        : 'The model returned an empty response.',
      'Try again, or try a different photo.',
    )
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = (fenced ? fenced[1] : text).trim()
  try {
    return JSON.parse(raw)
  } catch {
    throw new AiError(
      'The model did not return usable JSON.',
      'This usually clears up on a retry. If it persists, try a different model.',
    )
  }
}

/**
 * Turns whatever came back into a proposal that is safe to show and apply.
 *
 * Every field is treated as untrusted: unknown slider names are dropped,
 * non-finite numbers are dropped, and anything out of range is clamped with the
 * original request kept so the UI can admit it was clamped.
 */
export function validateProposal(input: unknown): AiProposal {
  const o = (input ?? {}) as Record<string, unknown>

  const seen = new Set<string>()
  const changes: ProposedChange[] = []
  const rawChanges = Array.isArray(o.changes) ? o.changes.slice(0, MAX_CHANGES) : []
  for (const c of rawChanges) {
    const item = (c ?? {}) as Record<string, unknown>
    const key = String(item.key ?? '') as ProposableKey
    if (!PROPOSABLE_KEYS.includes(key) || seen.has(key)) continue
    const n = toNumber(item.value)
    if (n === null) continue
    seen.add(key)
    const [lo, hi] = RANGES[key]
    const value = clamp(n, lo, hi)
    changes.push({
      key,
      value,
      ...(Math.abs(value - n) > 1e-6 ? { requested: n } : {}),
      reason: clean(item.reason, MAX_REASON),
    })
  }

  const proposal: AiProposal = {
    diagnosis: clean(o.diagnosis, MAX_DIAGNOSIS) || 'No diagnosis was returned.',
    changes,
    notes: Array.isArray(o.notes)
      ? o.notes
          .slice(0, MAX_NOTES)
          .map((n) => clean(n, MAX_REASON))
          .filter(Boolean)
      : [],
  }

  const st = toNumber(o.straighten)
  if (st !== null && Math.abs(st) >= 0.1) {
    proposal.straighten = clamp(st, -20, 20)
    proposal.straightenReason = clean(o.straightenReason, MAX_REASON)
  }

  if (o.perspectiveRecommended === true) {
    proposal.perspective = {
      recommended: true,
      note: clean(o.perspectiveNote, MAX_REASON) || 'The subject looks shot off-axis.',
    }
  }

  return proposal
}

// --- transport --------------------------------------------------------------

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { message?: string } }
    return j?.error?.message || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export async function requestReview(
  settings: AiSettings,
  bitmap: ImageBitmap,
  analysis: Analysis,
  current: Adjustments,
  signal?: AbortSignal,
): Promise<AiProposal> {
  const model = settings.model.trim()
  if (!model) throw new AiError('No model is set.', 'Add one in AI settings.')

  const imageB64 = await encodeForReview(bitmap)
  const envelope = buildBody(model, imageB64, analysis, current)

  let res: Response
  if (settings.transport === 'proxy') {
    const url = settings.proxyUrl.trim()
    if (!url) {
      throw new AiError(
        'No proxy URL is set.',
        'Deploy proxy/cloudflare-worker.js and paste its address into AI settings.',
      )
    }
    try {
      const token = settings.accessToken.trim()
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-Darkroom-Token': token } : {}),
        },
        body: JSON.stringify(envelope),
        signal,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      throw new AiError(
        `Could not reach the proxy at ${url}.`,
        'Check the address, and that the Worker allows requests from this site.',
      )
    }
  } else {
    if (!settings.apiKey.trim()) {
      throw new AiError('No API key is set.', 'Add one in AI settings, or switch to proxy mode.')
    }
    try {
      res = await fetch(`${GEMINI_HOST}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': settings.apiKey.trim() },
        body: JSON.stringify(envelope.body),
        signal,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      // A browser reports a CORS rejection as an indistinguishable network
      // failure, and Google does not officially support calls from a page.
      throw new AiError(
        'The browser could not reach the Gemini API directly.',
        'This is usually the browser blocking the call rather than a network fault. Proxy mode avoids it, and keeps your key off the page.',
      )
    }
  }

  if (!res.ok) {
    const message = await readError(res)
    const hint =
      res.status === 429
        ? 'That is the rate limit. The free tier allows only a few requests a minute.'
        : res.status === 400 || res.status === 404
          ? `Check the model name (${model}) and the API key.`
          : res.status === 403
            ? 'The key was rejected. Check it is enabled for the Gemini API.'
            : undefined
    throw new AiError(message, hint)
  }

  return validateProposal(extractJson(await res.json()))
}
