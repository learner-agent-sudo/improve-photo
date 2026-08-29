import { cropPixelSize, outputSize } from '../engine/geometry'
import { TARGET_GROUPS, TARGETS } from '../engine/targets'
import type { ExportFormat } from '../engine/types'
import type { Photo } from '../state/photos'

export interface ExportConfig {
  targetId: string
  format: ExportFormat
  quality: number
}

export function ExportPanel({
  photo,
  config,
  onChange,
  onExportOne,
  onExportAll,
  count,
  busy,
}: {
  photo: Photo
  config: ExportConfig
  onChange: (patch: Partial<ExportConfig>) => void
  onExportOne: () => void
  onExportAll: () => void
  count: number
  busy: boolean
}) {
  const target = TARGETS.find((t) => t.id === config.targetId) ?? TARGETS[0]
  const [cw, ch] = cropPixelSize(photo.nativeWidth, photo.nativeHeight, photo.edit.geometry)
  const [ow, oh] = outputSize(cw, ch, target.longEdge)
  const qFill = ((config.quality - 0.4) / 0.6) * 100

  return (
    <div className="panel-foot">
      <div className="field">
        <label htmlFor="ex-target">Export for</label>
        <select
          id="ex-target"
          className="select"
          value={config.targetId}
          onChange={(e) => onChange({ targetId: e.target.value })}
        >
          {TARGET_GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {TARGETS.filter((t) => t.group === g).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · {t.note}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {target.hint && <p className="field-hint">{target.hint}</p>}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="ex-format">Format</label>
          <select
            id="ex-format"
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
          <label htmlFor="ex-quality">
            Quality {config.format === 'png' ? '—' : `${Math.round(config.quality * 100)}`}
          </label>
          <input
            id="ex-quality"
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
        <button className="btn btn-primary" onClick={onExportOne} disabled={busy}>
          Export photo
        </button>
        <button className="btn" onClick={onExportAll} disabled={busy || count < 2}>
          All {count} as .zip
        </button>
      </div>

      <div className="export-size">
        will write <b>{ow} × {oh}</b> · {target.aspect === 'original' ? 'original shape' : target.aspect}
      </div>
    </div>
  )
}
