import { useCallback, useRef, useState } from 'react'
import { requestReview } from '../ai/gemini'
import { isConfigured } from '../ai/settings'
import { AiError, type AiProposal, type AiSettings, type ProposableKey, type ProposedChange } from '../ai/types'
import type { Photo } from '../state/photos'

const LABELS: Record<ProposableKey, string> = {
  exposure: 'Exposure',
  contrast: 'Contrast',
  highlights: 'Highlights',
  shadows: 'Shadows',
  whites: 'Whites',
  blacks: 'Blacks',
  temperature: 'Temperature',
  tint: 'Tint',
  vibrance: 'Vibrance',
  saturation: 'Saturation',
  clarity: 'Clarity',
  sharpen: 'Sharpen',
  denoise: 'Noise reduction',
}

/** Model text rarely ends in a full stop; add one so it does not run into ours. */
const endSentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

const fmt = (key: ProposableKey, v: number) => {
  if (key === 'exposure') return `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`
  if (key === 'sharpen' || key === 'denoise') return String(Math.round(v * 100))
  return `${v > 0 ? '+' : ''}${Math.round(v * 100)}`
}

/**
 * The AI second opinion, and its approval gate.
 *
 * Nothing here changes the photo on its own. The model's answer is rendered as
 * a list of proposed moves with the current value beside the suggested one, each
 * one individually approvable, and applying goes through the normal edit history
 * so Ctrl+Z undoes the whole thing.
 */
export function AiPanel({
  photo,
  settings,
  onOpenSettings,
  onApply,
}: {
  photo: Photo
  settings: AiSettings
  onOpenSettings: () => void
  onApply: (changes: ProposedChange[], straighten?: number) => void
}) {
  const [busy, setBusy] = useState(false)
  const [proposal, setProposal] = useState<AiProposal | null>(null)
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null)
  const [skipped, setSkipped] = useState<Set<ProposableKey>>(new Set())
  const [takeStraighten, setTakeStraighten] = useState(true)
  const abort = useRef<AbortController | null>(null)

  const ready = isConfigured(settings)

  const ask = useCallback(async () => {
    setError(null)
    setProposal(null)
    setBusy(true)
    abort.current?.abort()
    const ac = new AbortController()
    abort.current = ac
    try {
      const result = await requestReview(
        settings,
        photo.preview,
        photo.analysis,
        photo.edit.adjustments,
        ac.signal,
      )
      setProposal(result)
      setSkipped(new Set())
      setTakeStraighten(true)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      const e = err as AiError
      setError({ message: e.message || 'The review failed.', hint: e.hint })
    } finally {
      setBusy(false)
    }
  }, [settings, photo])

  const accepted = proposal?.changes.filter((c) => !skipped.has(c.key)) ?? []

  if (!settings.enabled) {
    return (
      <div className="ai-block">
        <button className="btn btn-sm ai-cta" onClick={onOpenSettings}>
          <span aria-hidden="true">✦</span> Set up AI review
        </button>
        <p className="ai-hint">
          Optional. Sends a small copy of the photo to Gemini for a second opinion, and shows you
          every change before anything is applied.
        </p>
      </div>
    )
  }

  return (
    <div className="ai-block">
      <div className="ai-row">
        <button
          className="btn btn-sm ai-cta"
          onClick={busy ? () => abort.current?.abort() : ask}
          disabled={!ready && !busy}
        >
          {busy ? (
            <>
              <span className="ai-spin" aria-hidden="true" /> Reviewing… (cancel)
            </>
          ) : (
            <>
              <span aria-hidden="true">✦</span> Ask AI
            </>
          )}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onOpenSettings} title="AI settings">
          ⚙
        </button>
      </div>

      {!ready && (
        <p className="ai-hint">
          Not configured yet — open the settings above to add a proxy address or an API key.
        </p>
      )}

      {error && (
        <div className="ai-card error">
          <b>{error.message}</b>
          {error.hint && <p>{error.hint}</p>}
        </div>
      )}

      {proposal && (
        <div className="ai-card">
          <p className="ai-diagnosis">{proposal.diagnosis}</p>

          {proposal.changes.length === 0 ? (
            <p className="ai-none">No slider changes suggested.</p>
          ) : (
            <ul className="ai-changes">
              {proposal.changes.map((c) => {
                const from = photo.edit.adjustments[c.key]
                const off = skipped.has(c.key)
                return (
                  <li key={c.key} className={off ? 'off' : undefined}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!off}
                        onChange={() =>
                          setSkipped((prev) => {
                            const next = new Set(prev)
                            if (next.has(c.key)) next.delete(c.key)
                            else next.add(c.key)
                            return next
                          })
                        }
                      />
                      <span className="ai-key">{LABELS[c.key]}</span>
                      <span className="ai-delta">
                        <i>{fmt(c.key, from)}</i> → <b>{fmt(c.key, c.value)}</b>
                      </span>
                    </label>
                    {c.reason && <p className="ai-reason">{c.reason}</p>}
                    {c.requested !== undefined && (
                      <p className="ai-reason clamped">
                        asked for {c.requested.toFixed(2)}, clamped to the slider&rsquo;s range
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {proposal.straighten !== undefined && (
            <label className="ai-extra">
              <input
                type="checkbox"
                checked={takeStraighten}
                onChange={(e) => setTakeStraighten(e.target.checked)}
              />
              <span>
                Straighten <b>{proposal.straighten > 0 ? '+' : ''}{proposal.straighten.toFixed(1)}°</b>
                {proposal.straightenReason ? ` — ${proposal.straightenReason}` : ''}
              </span>
            </label>
          )}

          {proposal.perspective?.recommended && (
            <p className="ai-flag">
              {/* The note is the model's own sentence, so it is closed off before
                  ours begins rather than run together with it. */}
              <b>Shot off-axis.</b> {endSentence(proposal.perspective.note)} Open the{' '}
              <b>Perspective</b> tool and put the four corners on something that is really a
              rectangle.
            </p>
          )}

          {proposal.notes.length > 0 && (
            <div className="ai-notes">
              <h4>Also noticed</h4>
              <ul>
                {proposal.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="ai-actions">
            <button
              className="btn btn-primary btn-sm"
              disabled={accepted.length === 0 && !(takeStraighten && proposal.straighten !== undefined)}
              onClick={() => {
                onApply(
                  accepted,
                  takeStraighten ? proposal.straighten : undefined,
                )
                setProposal(null)
              }}
            >
              Apply {accepted.length || ''}
            </button>
            <button className="btn btn-sm" onClick={() => setProposal(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
