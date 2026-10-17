import { useState, type ReactNode } from 'react'
import { COLLAGE_SHAPES } from '../engine/collage'
import {
  MAX_REEL_PHOTOS,
  reelDuration,
  reelSize,
  SECONDS_CHOICES,
  type ReelSettings,
} from '../engine/reel'
import type { Photo } from '../state/photos'
import { PHONE_QUERY, useMediaQuery } from '../state/media'

type Tab = 'photos' | 'style' | 'export'

/**
 * Video settings. Same shape as the collage panel: tabs that become a sheet on
 * a phone, and on a phone the export controls are a tab rather than a footer,
 * so they do not sit on top of the preview.
 */
export function ReelPanel({
  order,
  off,
  settings,
  onSettings,
  onMove,
  onToggle,
  collapsed,
  onExpand,
  footer,
}: {
  order: Photo[]
  off: Set<string>
  settings: ReelSettings
  onSettings: (patch: Partial<ReelSettings>) => void
  onMove: (id: string, by: -1 | 1) => void
  onToggle: (id: string) => void
  collapsed?: boolean
  onExpand?: () => void
  footer: ReactNode
}) {
  const phone = useMediaQuery(PHONE_QUERY)
  const [tab, setTab] = useState<Tab>('style')
  const tabs: Tab[] = phone ? ['photos', 'style', 'export'] : ['photos', 'style']
  const current: Tab = tab === 'export' && !phone ? 'style' : tab
  const label: Record<Tab, string> = { photos: 'Photos', style: 'Style', export: 'Make' }

  const choice = <K extends keyof ReelSettings>(key: K, value: ReelSettings[K], text: string, hint?: string) => (
    <button
      key={String(value)}
      className="seg-btn"
      aria-pressed={settings[key] === value}
      onClick={() => onSettings({ [key]: value } as Partial<ReelSettings>)}
      title={hint}
    >
      {text}
    </button>
  )

  let n = 0
  return (
    <aside className={`panel${collapsed ? ' collapsed' : ''}`}>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            className="tab"
            role="tab"
            aria-selected={current === t}
            onClick={() => {
              if (collapsed || current === t) onExpand?.()
              setTab(t)
            }}
          >
            {label[t]}
          </button>
        ))}
        <button className="sheet-handle" onClick={onExpand} aria-label={collapsed ? 'Show controls' : 'Hide controls'}>
          {collapsed ? '⌃' : '⌄'}
        </button>
      </div>

      <div className="panel-body">
        {current === 'photos' && (
          <div className="group">
            <h3 className="group-title">Order</h3>
            <ol className="reel-order">
              {order.map((p, i) => {
                const out = off.has(p.id)
                const pos = out ? null : ++n
                return (
                  <li key={p.id} className={out ? 'out' : ''}>
                    <img src={p.thumbUrl} alt="" />
                    <span className="reel-order-name">
                      <b>{out ? '–' : pos}</b> {p.name}
                    </span>
                    <button
                      className="icon-btn"
                      aria-label={`Move ${p.name} earlier`}
                      disabled={i === 0}
                      onClick={() => onMove(p.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`Move ${p.name} later`}
                      disabled={i === order.length - 1}
                      onClick={() => onMove(p.id, 1)}
                    >
                      ↓
                    </button>
                    <label className="reel-include" title={out ? 'Put it back in' : 'Leave it out'}>
                      <input type="checkbox" checked={!out} onChange={() => onToggle(p.id)} aria-label={`Include ${p.name}`} />
                    </label>
                  </li>
                )
              })}
            </ol>
            {n > MAX_REEL_PHOTOS && (
              <p className="field-hint">Only the first {MAX_REEL_PHOTOS} go into the video.</p>
            )}
          </div>
        )}

        {current === 'style' && (
          <>
            <div className="group">
              <h3 className="group-title">Shape</h3>
              <div className="aspect-grid three">
                {COLLAGE_SHAPES.map((s) => {
                  const [w, h] = reelSize(s.key)
                  return (
                    <button
                      key={s.key}
                      className="aspect-btn"
                      aria-pressed={settings.aspect === s.key}
                      onClick={() => onSettings({ aspect: s.key })}
                      title={`${s.label}, ${w} × ${h} - best for ${s.bestFor}`}
                    >
                      <span
                        className="shape"
                        style={{
                          aspectRatio: String(w / h),
                          width: w >= h ? 16 : 'auto',
                          height: w >= h ? 'auto' : 16,
                        }}
                      />
                      <span className="aspect-use">{s.use}</span>
                      <span className="aspect-ratio">{s.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="group">
              <h3 className="group-title">Each photo stays</h3>
              <div className="seg three">
                {SECONDS_CHOICES.map((sec) => choice('secondsPerPhoto', sec, `${sec} s`))}
              </div>
            </div>

            <div className="group">
              <h3 className="group-title">Movement</h3>
              <div className="seg">
                {choice('motion', 'gentle', 'Slow zoom', 'Each photo drifts a little, so it reads as video rather than a frozen frame')}
                {choice('motion', 'none', 'Still')}
              </div>
              <div className="seg">
                {choice('transition', 'fade', 'Crossfade')}
                {choice('transition', 'cut', 'Cut')}
              </div>
            </div>

            <div className="group">
              <h3 className="group-title">Fit</h3>
              <div className="seg">
                {choice('fit', 'fill', 'Fill the frame', 'Crops each photo to the shape')}
                {choice('fit', 'whole', 'Whole photo', 'Shows all of each photo, over a blurred copy of itself')}
              </div>
              <p className="auto-notes" style={{ marginTop: 10 }}>
                <b>Fill</b> crops each photo to the shape, which suits photos taken upright.
                <b> Whole photo</b> shows everything, on a soft blurred copy of itself, which suits
                wide shots in a tall video.
              </p>
            </div>
          </>
        )}

        {current === 'export' && <div className="export-tab">{footer}</div>}
      </div>

      {!phone && footer}
    </aside>
  )
}

/** The "Make video" block: what will be made, the button, and the result. */
export function ReelExport({
  count,
  settings,
  supported,
  busy,
  result,
  canShare,
  onMake,
  onSave,
  onShare,
}: {
  count: number
  settings: ReelSettings
  supported: boolean | null
  busy: boolean
  result: { name: string; size: number } | null
  canShare: boolean
  onMake: () => void
  onSave: () => void
  onShare: () => void
}) {
  const [w, h] = reelSize(settings.aspect)
  const secs = reelDuration(count, settings)
  return (
    <div className="panel-foot">
      <p className="reel-summary">
        {count} photo{count === 1 ? '' : 's'} · {secs.toFixed(secs % 1 ? 1 : 0)} s · {w} × {h} · MP4
      </p>
      {supported === false ? (
        <p className="field-hint reel-warn">
          This browser cannot make video files. A recent Chrome or Edge, or Safari on an up-to-date
          iPhone or Mac, can - and your edits will still be here if you switch.
        </p>
      ) : result ? (
        <>
          <div className="icon-row" style={{ marginBottom: 6 }}>
            {canShare && (
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={onShare}>
                Share or save…
              </button>
            )}
            <button className={`btn${canShare ? '' : ' btn-primary'}`} style={{ flex: 1 }} onClick={onSave}>
              Download
            </button>
          </div>
          <p className="field-hint">
            {(result.size / 1048576).toFixed(1)} MB.{' '}
            {canShare
              ? 'On a phone, Share → Save Video puts it straight into your photos.'
              : 'Change anything and the video is made again.'}
          </p>
        </>
      ) : (
        <button
          className="btn btn-primary"
          style={{ width: '100%' }}
          disabled={busy || count === 0 || supported !== true}
          onClick={onMake}
        >
          {supported === null ? 'Checking this browser…' : 'Make video'}
        </button>
      )}
      <p className="field-hint">
        No sound, on purpose: add music in Instagram, TikTok or Xiaohongshu when you post. Each has
        its own music library for that.
      </p>
    </div>
  )
}
