import { MAX_AREAS, type AreaAdjust } from '../engine/types'
import { Slider } from './Slider'

const ev = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`
const pctSigned = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`

export const areaName = (a: AreaAdjust, i: number) =>
  `${a.kind === 'radial' ? 'Circle' : 'Gradient'} ${i + 1}`

/**
 * The panel side of local adjustments. The shapes themselves are placed by
 * dragging on the photo (AreaOverlay); this is where they are added, chosen,
 * tuned and removed. Size has a slider as well as handles because a handle
 * that is easy for a mouse is fiddly for a thumb.
 */
export function AreaControls({
  areas,
  selectedId,
  onSelect,
  onAdd,
  onChange,
  onRemove,
}: {
  areas: AreaAdjust[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onAdd: (kind: AreaAdjust['kind']) => void
  onChange: (id: string, patch: Partial<AreaAdjust>, key: string) => void
  onRemove: (id: string) => void
}) {
  const index = areas.findIndex((a) => a.id === selectedId)
  const sel = index >= 0 ? areas[index] : null
  const full = areas.length >= MAX_AREAS

  return (
    <>
      <div className="group">
        <h3 className="group-title">Brighten or darken one part</h3>
        <div className="icon-row">
          <button className="btn" style={{ flex: 1 }} disabled={full} onClick={() => onAdd('radial')}>
            + Circle
          </button>
          <button className="btn" style={{ flex: 1 }} disabled={full} onClick={() => onAdd('linear')}>
            + Gradient
          </button>
        </div>
        {areas.length === 0 ? (
          <p className="auto-notes" style={{ marginTop: 12 }}>
            A <b>circle</b> lifts the dish and leaves the table alone. A <b>gradient</b> fades
            across the photo, for a bright window on one side or a busy background at the top.
            Add one, then drag it on the photo.
          </p>
        ) : (
          <div className="area-list" role="listbox" aria-label="Areas">
            {areas.map((a, i) => (
              <span key={a.id} className="area-chip-wrap">
                <button
                  className="chip"
                  role="option"
                  aria-selected={a.id === selectedId}
                  aria-pressed={a.id === selectedId}
                  onClick={() => onSelect(a.id)}
                >
                  {areaName(a, i)}
                </button>
                <button
                  className="area-remove"
                  aria-label={`Remove ${areaName(a, i)}`}
                  title="Remove"
                  onClick={() => onRemove(a.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {full && <p className="field-hint">That is the most a photo can have: {MAX_AREAS}.</p>}
      </div>

      {sel && (
        <div className="group">
          <h3 className="group-title">{areaName(sel, index)}</h3>
          <Slider
            label="Brightness"
            value={sel.exposure}
            min={-1.5}
            max={1.5}
            display={ev}
            onChange={(v) => onChange(sel.id, { exposure: v }, 'exposure')}
            onReset={() => onChange(sel.id, { exposure: 0 }, 'exposure')}
          />
          <Slider
            label="Warmth"
            value={sel.warmth}
            min={-1}
            max={1}
            display={pctSigned}
            onChange={(v) => onChange(sel.id, { warmth: v }, 'warmth')}
            onReset={() => onChange(sel.id, { warmth: 0 }, 'warmth')}
          />
          {sel.kind === 'radial' && (
            <>
              <Slider
                label="Size"
                value={sel.rx}
                min={0.03}
                max={1}
                bipolar={false}
                display={(v) => `${Math.round(v * 100)}`}
                // Scales both radii together, so an oval stays the same shape.
                onChange={(v) =>
                  onChange(sel.id, { rx: v, ry: (sel.ry * v) / Math.max(sel.rx, 1e-3) }, 'size')
                }
                onReset={() => onChange(sel.id, { rx: 0.22, ry: 0.22 }, 'size')}
              />
              <Slider
                label="Soft edge"
                value={sel.feather}
                min={0.05}
                max={1}
                bipolar={false}
                onChange={(v) => onChange(sel.id, { feather: v }, 'feather')}
                onReset={() => onChange(sel.id, { feather: 0.6 }, 'feather')}
              />
            </>
          )}
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={sel.invert}
              onChange={(e) => onChange(sel.id, { invert: e.target.checked }, 'invert')}
            />
            <span>{sel.kind === 'radial' ? 'Change the outside instead' : 'Fade the other way'}</span>
          </label>
          <p className="auto-notes" style={{ marginTop: 10 }}>
            {sel.kind === 'radial'
              ? 'Drag the middle to move it and the two outer dots to change its shape. The dashed line is where the soft edge begins.'
              : 'The solid line is full strength and the dashed line is where it has faded out. Drag either end, or the middle to move both.'}
          </p>
        </div>
      )}
    </>
  )
}
