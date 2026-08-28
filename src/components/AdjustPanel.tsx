import { useState, type ReactNode } from 'react'
import type { AiSettings, ProposedChange } from '../ai/types'
import { AiPanel } from './AiPanel'
import { describeAuto } from '../engine/auto'
import { aspectRatio, centredCrop, framedSize } from '../engine/geometry'
import { RANGES } from '../engine/presets'
import type { Adjustments, AspectKey, Geometry } from '../engine/types'
import { FULL_RECT } from '../engine/types'
import type { Photo } from '../state/photos'
import { Histogram } from './Histogram'
import { Slider } from './Slider'
import type { Tool } from './Stage'

type Tab = 'light' | 'colour' | 'detail' | 'frame'

const TABS: { id: Tab; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'colour', label: 'Colour' },
  { id: 'detail', label: 'Detail' },
  { id: 'frame', label: 'Frame' },
]

const ASPECTS: { key: AspectKey; label: string }[] = [
  { key: 'free', label: 'Free' },
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

export function AdjustPanel({
  photo,
  tool,
  onTool,
  onAdjust,
  onGeometry,
  onResetFraming,
  aiSettings,
  onOpenAiSettings,
  onApplyAi,
  footer,
}: {
  photo: Photo
  tool: Tool
  onTool: (t: Tool) => void
  onAdjust: (patch: Partial<Adjustments>) => void
  onGeometry: (patch: Partial<Geometry>) => void
  onResetFraming: () => void
  aiSettings: AiSettings
  onOpenAiSettings: () => void
  onApplyAi: (changes: ProposedChange[], straighten?: number) => void
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

  /** Picking a shape re-centres the crop at the largest rectangle that fits. */
  const chooseAspect = (key: AspectKey) => {
    const [fw, fh] = framedSize(photo.preview.width, photo.preview.height, g)
    const ratio = aspectRatio(key, fw, fh)
    onGeometry({ aspect: key, crop: centredCrop(ratio, fw, fh) })
    if (tool !== 'crop') onTool('crop')
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

            <AiPanel
              photo={photo}
              settings={aiSettings}
              onOpenSettings={onOpenAiSettings}
              onApply={onApplyAi}
            />

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
              <h3 className="group-title">Tools</h3>
              <div className="icon-row">
                <button
                  className="btn"
                  style={{ flex: 1 }}
                  aria-pressed={tool === 'crop'}
                  onClick={() => onTool(tool === 'crop' ? 'adjust' : 'crop')}
                >
                  Crop
                </button>
                <button
                  className="btn"
                  style={{ flex: 1 }}
                  aria-pressed={tool === 'perspective'}
                  onClick={() => onTool(tool === 'perspective' ? 'adjust' : 'perspective')}
                >
                  Perspective
                </button>
              </div>
            </div>

            <div className="group">
              <h3 className="group-title">Orientation</h3>
              <div className="icon-row">
                <button
                  className="icon-btn"
                  title="Rotate left"
                  onClick={() =>
                    onGeometry({ rotate90: ((g.rotate90 + 3) % 4) as Geometry['rotate90'] })
                  }
                >
                  ↺
                </button>
                <button
                  className="icon-btn"
                  title="Rotate right"
                  onClick={() =>
                    onGeometry({ rotate90: ((g.rotate90 + 1) % 4) as Geometry['rotate90'] })
                  }
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
              <Slider
                label="Straighten"
                value={g.straighten}
                min={-20}
                max={20}
                step={0.1}
                display={deg}
                onChange={(v) => onGeometry({ straighten: v })}
                onReset={() => onGeometry({ straighten: 0 })}
              />
            </div>

            <div className="group">
              <h3 className="group-title">Crop shape</h3>
              <div className="aspect-grid three">
                {ASPECTS.map(({ key, label }) => {
                  const ratio =
                    key === 'free'
                      ? 1.35
                      : key === 'original'
                        ? photo.nativeWidth / photo.nativeHeight
                        : aspectRatio(key, 1, 1)!
                  return (
                    <button
                      key={key}
                      className={`aspect-btn${key === 'free' ? ' free' : ''}`}
                      aria-pressed={g.aspect === key}
                      onClick={() => chooseAspect(key)}
                    >
                      <span
                        className="shape"
                        style={{
                          aspectRatio: String(ratio),
                          width: ratio >= 1 ? 16 : 'auto',
                          height: ratio >= 1 ? 'auto' : 16,
                        }}
                      />
                      {label}
                    </button>
                  )
                })}
              </div>
              <button
                className="btn btn-sm"
                style={{ width: '100%' }}
                onClick={() => onGeometry({ crop: { ...FULL_RECT } })}
              >
                Fill the frame
              </button>
            </div>

            <div className="group">
              <h3 className="group-title">Perspective</h3>
              <Slider
                label="Vertical"
                value={g.tiltV}
                min={-1}
                max={1}
                display={pctSigned}
                onChange={(v) => onGeometry({ tiltV: v })}
                onReset={() => onGeometry({ tiltV: 0 })}
              />
              <Slider
                label="Horizontal"
                value={g.tiltH}
                min={-1}
                max={1}
                display={pctSigned}
                onChange={(v) => onGeometry({ tiltH: v })}
                onReset={() => onGeometry({ tiltH: 0 })}
              />
              <button
                className="btn btn-sm"
                style={{ width: '100%' }}
                disabled={!g.corners && g.tiltV === 0 && g.tiltH === 0}
                onClick={() => onGeometry({ corners: null, tiltV: 0, tiltH: 0 })}
              >
                Clear perspective
              </button>
              <p className="auto-notes" style={{ marginTop: 12 }}>
                The sliders handle a gentle lean. For a photo taken properly off to one side, use
                the <b>Perspective</b> tool and put the four corners on something that is really a
                rectangle.
              </p>
            </div>

            <button className="btn btn-sm" style={{ width: '100%' }} onClick={onResetFraming}>
              Reset all framing
            </button>
          </>
        )}
      </div>

      {footer}
    </aside>
  )
}
