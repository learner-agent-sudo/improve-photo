import { useState } from 'react'
import { MAX_LOOKS, MAX_NAME, type Look } from '../state/looks'

/**
 * Saved looks: one tap to give a photo the look you settled on last time.
 *
 * Deliberately in the panel rather than next to the built-in presets in the
 * top bar. On a phone that bar already wraps to two rows, and every row there
 * comes out of the picture.
 */
export function LooksControls({
  looks,
  activeId,
  onApply,
  onSave,
  onDelete,
}: {
  looks: Look[]
  /** The photo's presetId, so a look can show as the one in use. */
  activeId: string
  onApply: (id: string) => void
  onSave: (name: string) => void
  onDelete: (id: string) => void
}) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const full = looks.length >= MAX_LOOKS

  const start = () => {
    setName(`My look ${looks.length + 1}`)
    setNaming(true)
  }
  const save = () => {
    if (!name.trim()) return
    onSave(name)
    setNaming(false)
  }

  return (
    <div className="group">
      <h3 className="group-title">My looks</h3>
      {looks.length > 0 && (
        <div className="area-list looks-list">
          {looks.map((l) => (
            <span key={l.id} className="area-chip-wrap">
              <button
                className="chip"
                aria-pressed={activeId === `look:${l.id}`}
                onClick={() => onApply(l.id)}
                title="Give this photo this look. Its own Auto correction stays underneath."
              >
                {l.name}
              </button>
              <button
                className="area-remove"
                aria-label={`Delete the look ${l.name}`}
                title="Delete"
                onClick={() => {
                  if (window.confirm(`Delete the look "${l.name}"? This cannot be undone.`)) onDelete(l.id)
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {naming ? (
        <form
          className="look-form"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <input
            className="text-input"
            value={name}
            maxLength={MAX_NAME}
            autoFocus
            aria-label="Name for this look"
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            Save
          </button>
          <button type="button" className="btn" onClick={() => setNaming(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <button className="btn btn-sm" style={{ width: '100%' }} disabled={full} onClick={start}>
          Save this photo's look
        </button>
      )}

      <p className="field-hint">
        {full
          ? `That is the most you can keep: ${MAX_LOOKS}. Delete one to make room.`
          : looks.length === 0
            ? 'Keeps the sliders and the colour mix, so the next photo is one tap. Stored in this browser only.'
            : 'Each look is added to the photo’s own Auto correction, so it suits brighter and darker shots alike.'}
      </p>
    </div>
  )
}
