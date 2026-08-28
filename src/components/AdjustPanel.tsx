import { useState, type ReactNode } from 'react'
import { describeAuto } from '../engine/auto'
import { RANGES } from '../engine/presets'
import type { Adjustments, AspectKey, Geometry } from '../engine/types'
import { ASPECT_RATIOS } from '../engine/types'
import type { Photo } from '../state/photos'
import { Histogram } from './Histogram'
import { Slider } from './Slider'

type Tab = 'light' | 'colour' | 'detail' | 'frame'

const TABS: { id: Tab; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'colour', label: 'Colour' },
  { id: 'detail', label: 'Detail' },
  { id: 'frame', label: 'Frame' },
]

const ASPECTS: { key: AspectKey; label: string }[] = [
  { key: 'original', label: 'Orig' },
  { key: '1:1', label: '1:1' },
  { key: '4:5', label: '4:5' },
  { key: '3:4', label: '3:4' },
  { key: '9:16', label: '9:16' },
  { key: '4:3', label: '4:3' },
  { key: '3:2', label: '3:2' },
  { key: '16:9', label: '16:9' },
]

const ev = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`
const deg = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`
const pctSigned = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`
const times = (v: number) => `${v.toFixed(2)}×`

export function AdjustPanel({
  photo,
  onAdjust,
  onGeometry,
  onResetFraming,
  footer,
}: {
  photo: Photo
  onAdjust: (patch: Partial<Adjustments>) => void
  onGeometry: (patch: Partial<Geometry>) => void
  onResetFraming: () => void
  footer?: ReactNode
}) {
  const [tab, setTab] = useState<Tab>('light')
  const a = photo.edit.adjustments
  const g = photo.edit.geometry

  const bind = (key: keyof Adjustments, label: string, display?: (v: number) => string) => {
    const [min, max] = RANGES[key]
    return (
      <Slider
        key={key}
        label={label}
        value={a[key]}
        min={min}
        max={max}
        display={display}
        onChange={(v) => onAdjust({ [key]: v } as Partial<Adjustments>)}
        onReset={() => onAdjust({ [key]: 0 } as Partial<Adjustments>)}
      />
    )
  }

  return (
    <aside className="panel">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="tab"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="panel-body">
        {tab === 'light' && (
          <>
            <Histogram bins={photo.analysis.histogram} />
            <p className="auto-notes">
              <b>Auto read this photo as:</b>
              <br />
              {describeAuto(photo.analysis, photo.auto).join(' · ')}
            </p>
            <div className="group">
              <h3 className="group-title">Tone</h3>
              {bind('exposure', 'Exposure', ev)}
              {bind('contrast', 'Contrast', pctSigned)}
              {bind('highlights', 'Highlights', pctSigned)}
              {bind('shadows', 'Shadows', pctSigned)}
              {bind('whites', 'Whites', pctSigned)}
              {bind('blacks', 'Blacks', pctSigned)}
            </div>
          </>
        )}

        {tab === 'colour' && (
          <>
            <div className="group">
              <h3 className="group-title">White balance</h3>
              {bind('temperature', 'Temperature', pctSigned)}
              {bind('tint', 'Tint', pctSigned)}
            </div>
            <div className="group">
              <h3 className="group-title">Intensity</h3>
              {bind('vibrance', 'Vibrance', pctSigned)}
              {bind('saturation', 'Saturation', pctSigned)}
            </div>
            <p className="auto-notes">
              <b>Vibrance</b> lifts the colours that are still dull and mostly leaves the ones that
              are already strong. On food it is almost always the better of the two.
            </p>
          </>
        )}

        {tab === 'detail' && (
          <>
            <div className="group">
              <h3 className="group-title">Detail</h3>
              {bind('clarity', 'Clarity', pctSigned)}
              {bind('sharpen', 'Sharpen')}
              {bind('denoise', 'Noise reduction')}
            </div>
            <div className="group">
              <h3 className="group-title">Finish</h3>
              {bind('vignette', 'Vignette', pctSigned)}
              {bind('grain', 'Grain')}
            </div>
            <p className="auto-notes">
              Sharpening is applied at the <b>export</b> size, not the original size, so a photo
              destined for a 1080&nbsp;px post gets the amount of bite that size needs.
            </p>
          </>
        )}

        {tab === 'frame' && (
          <>
            <div className="group">
              <h3 className="group-title">Orientation</h3>
              <div className="icon-row">
                <button
                  className="icon-btn"
                  title="Rotate left"
                  onClick={() => onGeometry({ rotate90: (((g.rotate90 + 3) % 4) as Geometry['rotate90']) })}
                >
                  ↺
                </button>
                <button
                  className="icon-btn"
                  title="Rotate right"
                  onClick={() => onGeometry({ rotate90: (((g.rotate90 + 1) % 4) as Geometry['rotate90']) })}
                >
                  ↻
                </button>
                <button
                  className="icon-btn"
                  title="Mirror horizontally"
                  aria-pressed={g.flipH}
                  onClick={() => onGeometry({ flipH: !g.flipH })}
                >
                  ⇄
                </button>
              </div>
            </div>

            <div className="group">
              <h3 className="group-title">Crop shape</h3>
              <div className="aspect-grid">
                {ASPECTS.map(({ key, label }) => {
                  const ratio =
                    key === 'original'
                      ? photo.nativeWidth / photo.nativeHeight
                      : ASPECT_RATIOS[key]
                  return (
                    <button
                      key={key}
                      className="aspect-btn"
                      aria-pressed={g.aspect === key}
                      onClick={() => onGeometry({ aspect: key })}
                    >
                      <span
                        className="shape"
                        style={{ aspectRatio: String(ratio), width: ratio >= 1 ? 15 : 'auto', height: ratio >= 1 ? 'auto' : 15 }}
                      />
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="group">
              <h3 className="group-title">Adjust</h3>
              <Slider
                label="Straighten"
                value={g.straighten}
                min={-15}
                max={15}
                step={0.1}
                display={deg}
                onChange={(v) => onGeometry({ straighten: v })}
                onReset={() => onGeometry({ straighten: 0 })}
              />
              <Slider
                label="Zoom"
                value={g.zoom}
                min={1}
                max={3}
                step={0.01}
                bipolar={false}
                display={times}
                onChange={(v) => onGeometry({ zoom: v })}
                onReset={() => onGeometry({ zoom: 1, offsetX: 0, offsetY: 0 })}
              />
              <button className="btn btn-sm" style={{ width: '100%' }} onClick={onResetFraming}>
                Reset framing
              </button>
            </div>

            <p className="auto-notes">
              When the crop is tighter than the frame you can <b>drag the photo</b> to choose what
              stays in.
            </p>
          </>
        )}
      </div>

      {footer}
    </aside>
  )
}
