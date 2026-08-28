import { useState, type ReactNode } from 'react'
import {
  aspectValue,
  layoutsFor,
  type Cell,
  type CollageDoc,
  type TextFont,
  type TextLayer,
} from '../engine/collage'
import type { AspectKey } from '../engine/types'
import { Slider } from './Slider'

type Tab = 'layout' | 'style' | 'text'

const SHAPES: { key: AspectKey; label: string }[] = [
  { key: '3:4', label: '3:4' },
  { key: '4:5', label: '4:5' },
  { key: '1:1', label: '1:1' },
  { key: '9:16', label: '9:16' },
  { key: '4:3', label: '4:3' },
  { key: '16:9', label: '16:9' },
]

const BACKGROUNDS = ['#f4efe6', '#ffffff', '#0f0e0c', '#1b1815', '#e8ded0', '#d9c9b4', '#2f4739', '#f2a03d']

const FONTS: { key: TextFont; label: string }[] = [
  { key: 'display', label: 'Serif' },
  { key: 'sans', label: 'Sans' },
  { key: 'mono', label: 'Mono' },
]

const TEXT_COLORS = ['#ffffff', '#0f0e0c', '#f2a03d', '#e0561f', '#86a97b', '#7a5c3e']

/** A miniature of a layout, drawn from its own cells. */
function LayoutThumb({ cells, aspect }: { cells: Cell[]; aspect: number }) {
  const w = 34
  const h = w / aspect
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      {cells.map((c, i) => (
        <rect
          key={i}
          x={c.x * w + 0.6}
          y={c.y * h + 0.6}
          width={Math.max(0.5, c.w * w - 1.2)}
          height={Math.max(0.5, c.h * h - 1.2)}
          rx={1}
          fill="currentColor"
        />
      ))}
    </svg>
  )
}

export function CollagePanel({
  doc,
  photoCount,
  selectedCell,
  selectedText,
  onDoc,
  onLayout,
  onSelectText,
  onAutoFill,
  onShuffle,
  onClearAll,
  onClearCell,
  onAddText,
  footer,
}: {
  doc: CollageDoc
  photoCount: number
  selectedCell: number | null
  selectedText: string | null
  onDoc: (patch: Partial<CollageDoc>, coalesceKey?: string) => void
  onLayout: (layoutId: string) => void
  onSelectText: (id: string | null) => void
  onAutoFill: () => void
  onShuffle: () => void
  onClearAll: () => void
  onClearCell: (i: number) => void
  onAddText: () => void
  footer?: ReactNode
}) {
  const [tab, setTab] = useState<Tab>('layout')
  const aspect = aspectValue(doc.aspect)
  const layouts = layoutsFor(photoCount)
  const active = selectedText ? doc.texts.find((t) => t.id === selectedText) ?? null : null

  const patchText = (patch: Partial<TextLayer>, key?: string) =>
    onDoc(
      { texts: doc.texts.map((t) => (t.id === selectedText ? { ...t, ...patch } : t)) },
      key ?? `text:${Object.keys(patch).join()}`,
    )

  return (
    <aside className="panel">
      <div className="tabs" role="tablist">
        {(['layout', 'style', 'text'] as Tab[]).map((t) => (
          <button
            key={t}
            className="tab"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            style={{ textTransform: 'capitalize' }}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="panel-body">
        {tab === 'layout' && (
          <>
            <div className="group">
              <h3 className="group-title">Canvas shape</h3>
              <div className="aspect-grid three">
                {SHAPES.map(({ key, label }) => {
                  const r = aspectValue(key)
                  return (
                    <button
                      key={key}
                      className="aspect-btn"
                      aria-pressed={doc.aspect === key}
                      onClick={() => onDoc({ aspect: key }, 'aspect')}
                    >
                      <span
                        className="shape"
                        style={{
                          aspectRatio: String(r),
                          width: r >= 1 ? 16 : 'auto',
                          height: r >= 1 ? 'auto' : 16,
                        }}
                      />
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="group">
              <h3 className="group-title">Arrangement</h3>
              <div className="layout-grid">
                <button
                  className="layout-btn"
                  aria-pressed={doc.layoutId === 'auto'}
                  onClick={() => onLayout('auto')}
                  title={`Fitted to ${photoCount} photo${photoCount === 1 ? '' : 's'}`}
                >
                  <LayoutThumb cells={doc.layoutId === 'auto' ? doc.cells : []} aspect={aspect} />
                  <span>Auto</span>
                </button>
                {layouts.map((l) => (
                  <button
                    key={l.id}
                    className="layout-btn"
                    aria-pressed={doc.layoutId === l.id}
                    onClick={() => onLayout(l.id)}
                    title={`${l.name} — ${l.cells.length} frames`}
                  >
                    <LayoutThumb cells={l.cells} aspect={aspect} />
                    <span>{l.cells.length}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="group">
              <h3 className="group-title">Fill</h3>
              <div className="icon-row">
                <button className="btn btn-sm" style={{ flex: 1 }} onClick={onAutoFill}>
                  Fill in order
                </button>
                <button className="btn btn-sm" style={{ flex: 1 }} onClick={onShuffle}>
                  Shuffle
                </button>
              </div>
              <button className="btn btn-sm" style={{ width: '100%' }} onClick={onClearAll}>
                Empty every frame
              </button>
            </div>

            {selectedCell !== null && doc.slots[selectedCell]?.photoId && (
              <div className="group">
                <h3 className="group-title">Frame {selectedCell + 1}</h3>
                <Slider
                  label="Zoom"
                  value={doc.slots[selectedCell].zoom}
                  min={1}
                  max={3}
                  step={0.01}
                  bipolar={false}
                  display={(v) => `${v.toFixed(2)}×`}
                  onChange={(v) =>
                    onDoc(
                      { slots: doc.slots.map((s, i) => (i === selectedCell ? { ...s, zoom: v } : s)) },
                      `zoom:${selectedCell}`,
                    )
                  }
                  onReset={() =>
                    onDoc({
                      slots: doc.slots.map((s, i) =>
                        i === selectedCell ? { ...s, zoom: 1, offsetX: 0, offsetY: 0 } : s,
                      ),
                    })
                  }
                />
                <button
                  className="btn btn-sm"
                  style={{ width: '100%' }}
                  onClick={() => onClearCell(selectedCell)}
                >
                  Empty this frame
                </button>
              </div>
            )}
          </>
        )}

        {tab === 'style' && (
          <>
            <div className="group">
              <h3 className="group-title">Spacing</h3>
              <Slider
                label="Gap between photos"
                value={doc.gutter}
                min={0}
                max={0.06}
                step={0.001}
                bipolar={false}
                display={(v) => `${Math.round(v * 1000)}`}
                onChange={(v) => onDoc({ gutter: v }, 'gutter')}
                onReset={() => onDoc({ gutter: 0.012 })}
              />
              <Slider
                label="Border"
                value={doc.padding}
                min={0}
                max={0.08}
                step={0.001}
                bipolar={false}
                display={(v) => `${Math.round(v * 1000)}`}
                onChange={(v) => onDoc({ padding: v }, 'padding')}
                onReset={() => onDoc({ padding: 0.012 })}
              />
              <Slider
                label="Corner rounding"
                value={doc.radius}
                min={0}
                max={0.08}
                step={0.001}
                bipolar={false}
                display={(v) => `${Math.round(v * 1000)}`}
                onChange={(v) => onDoc({ radius: v }, 'radius')}
                onReset={() => onDoc({ radius: 0.014 })}
              />
            </div>

            <div className="group">
              <h3 className="group-title">Background</h3>
              <div className="swatches">
                {BACKGROUNDS.map((c) => (
                  <button
                    key={c}
                    className="swatch"
                    style={{ background: c }}
                    aria-pressed={doc.background.toLowerCase() === c}
                    aria-label={c}
                    onClick={() => onDoc({ background: c }, 'bg')}
                  />
                ))}
              </div>
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="bg-custom">Any colour</label>
                <input
                  id="bg-custom"
                  type="color"
                  className="color-input"
                  value={doc.background}
                  onChange={(e) => onDoc({ background: e.target.value }, 'bg')}
                />
              </div>
            </div>
          </>
        )}

        {tab === 'text' && (
          <>
            <div className="group">
              <button className="btn btn-sm" style={{ width: '100%' }} onClick={onAddText}>
                + Add text
              </button>
            </div>

            {doc.texts.length > 0 && (
              <div className="group">
                <h3 className="group-title">Layers</h3>
                <div className="text-list">
                  {doc.texts.map((t) => (
                    <button
                      key={t.id}
                      className="text-item"
                      aria-pressed={t.id === selectedText}
                      onClick={() => onSelectText(t.id)}
                    >
                      {t.text.split('\n')[0] || '(empty)'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {active && (
              <div className="group">
                <h3 className="group-title">Selected</h3>
                <textarea
                  className="text-input area"
                  rows={3}
                  value={active.text}
                  onChange={(e) => patchText({ text: e.target.value }, 'text:content')}
                  aria-label="Text content"
                />
                <div className="icon-row" style={{ marginTop: 10 }}>
                  {FONTS.map((f) => (
                    <button
                      key={f.key}
                      className="icon-btn"
                      aria-pressed={active.font === f.key}
                      onClick={() => patchText({ font: f.key })}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="icon-row">
                  {(['left', 'center', 'right'] as CanvasTextAlign[]).map((a) => (
                    <button
                      key={a}
                      className="icon-btn"
                      aria-pressed={active.align === a}
                      onClick={() => patchText({ align: a })}
                      title={`Align ${a}`}
                    >
                      {a === 'left' ? '⯇' : a === 'center' ? '≡' : '⯈'}
                    </button>
                  ))}
                </div>
                <div className="swatches" style={{ marginBottom: 12 }}>
                  {TEXT_COLORS.map((c) => (
                    <button
                      key={c}
                      className="swatch"
                      style={{ background: c }}
                      aria-pressed={active.color.toLowerCase() === c}
                      aria-label={c}
                      onClick={() => patchText({ color: c })}
                    />
                  ))}
                </div>
                <Slider
                  label="Size"
                  value={active.size}
                  min={0.02}
                  max={0.22}
                  step={0.001}
                  bipolar={false}
                  display={(v) => `${Math.round(v * 1000)}`}
                  onChange={(v) => patchText({ size: v }, 'text:size')}
                  onReset={() => patchText({ size: 0.07 })}
                />
                <Slider
                  label="Weight"
                  value={active.weight}
                  min={300}
                  max={900}
                  step={100}
                  bipolar={false}
                  display={(v) => String(Math.round(v))}
                  onChange={(v) => patchText({ weight: Math.round(v) }, 'text:weight')}
                  onReset={() => patchText({ weight: 600 })}
                />
                <Slider
                  label="Rotation"
                  value={active.rotation}
                  min={-30}
                  max={30}
                  step={0.5}
                  display={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}°`}
                  onChange={(v) => patchText({ rotation: v }, 'text:rot')}
                  onReset={() => patchText({ rotation: 0 })}
                />
                <label className="switch" style={{ marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    checked={active.shadow}
                    onChange={(e) => patchText({ shadow: e.target.checked })}
                  />
                  <span>Drop shadow, for light text on a busy photo</span>
                </label>
                <button
                  className="btn btn-sm"
                  style={{ width: '100%' }}
                  onClick={() => {
                    onDoc({ texts: doc.texts.filter((t) => t.id !== selectedText) }, 'text:delete')
                    onSelectText(null)
                  }}
                >
                  Delete this text
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {footer}
    </aside>
  )
}
