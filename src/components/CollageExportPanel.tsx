import { aspectValue, type CollageDoc } from '../engine/collage'
import type { ExportFormat } from '../engine/types'

export interface CollageExportConfig {
  longEdge: number
  format: ExportFormat
  quality: number
}

const SIZES = [
  { edge: 1080, note: 'small' },
  { edge: 1440, note: 'Xiaohongshu 3:4' },
  { edge: 1920, note: 'stories' },
  { edge: 2048, note: 'large' },
]

/** Pixel size of the finished collage for a given long edge. */
export function collageSize(doc: CollageDoc, longEdge: number): [number, number] {
  const a = aspectValue(doc.aspect)
  return a >= 1
    ? [Math.round(longEdge), Math.round(longEdge / a)]
    : [Math.round(longEdge * a), Math.round(longEdge)]
}

export function CollageExportPanel({
  doc,
  config,
  onChange,
  onExport,
  busy,
  filled,
}: {
  doc: CollageDoc
  config: CollageExportConfig
  onChange: (patch: Partial<CollageExportConfig>) => void
  onExport: () => void
  busy: boolean
  filled: number
}) {
  const [w, h] = collageSize(doc, config.longEdge)
  const qFill = ((config.quality - 0.4) / 0.6) * 100

  return (
    <div className="panel-foot">
      <div className="field">
        <label htmlFor="cx-size">Size</label>
        <select
          id="cx-size"
          className="select"
          value={config.longEdge}
          onChange={(e) => onChange({ longEdge: Number(e.target.value) })}
        >
          {SIZES.map((s) => {
            const [sw, sh] = collageSize(doc, s.edge)
            return (
              <option key={s.edge} value={s.edge}>
                {sw} × {sh} · {s.note}
              </option>
            )
          })}
        </select>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="cx-format">Format</label>
          <select
            id="cx-format"
            className="select"
            value={config.format}
            onChange={(e) => onChange({ format: e.target.value as ExportFormat })}
          >
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
            <option value="png">PNG</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="cx-quality">
            Quality {config.format === 'png' ? '—' : Math.round(config.quality * 100)}
          </label>
          <input
            id="cx-quality"
            type="range"
            min={0.4}
            max={1}
            step={0.01}
            value={config.quality}
            disabled={config.format === 'png'}
            onChange={(e) => onChange({ quality: Number(e.target.value) })}
            style={{
              width: '100%',
              height: 32,
              ['--track' as string]: `linear-gradient(90deg, var(--amber) 0 ${qFill}%, var(--ink-700) ${qFill}% 100%)`,
            }}
          />
        </div>
      </div>

      <div className="export-actions">
        <button className="btn btn-primary" onClick={onExport} disabled={busy || filled === 0}>
          Export collage
        </button>
      </div>

      <div className="export-size">
        will write <b>{w} × {h}</b> · {doc.aspect}
      </div>
    </div>
  )
}
