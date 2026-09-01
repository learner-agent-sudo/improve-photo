import { useState, type ReactNode } from 'react'
import {
  aspectValue,
  autoLayout,
  COLLAGE_SHAPES,
  FONT_BY_KEY,
  FONTS,
  layoutsFor,
  type Cell,
  type CollageDoc,
  type TextLayer,
  type TextStyle,
} from '../engine/collage'
import { PHONE_QUERY, useMediaQuery } from '../state/media'
import { Slider } from './Slider'

type Tab = 'layout' | 'style' | 'text' | 'export'

const BACKGROUNDS = ['#f4efe6', '#ffffff', '#0f0e0c', '#1b1815', '#e8ded0', '#d9c9b4', '#2f4739', '#f2a03d']

const TEXT_COLORS = [
  '#ffffff', '#0f0e0c', '#f2a03d', '#e0561f', '#c62828', '#e91e8c',
  '#7a5c3e', '#86a97b', '#2f6f6f', '#3457d5', '#f5e6c8', '#8d6e63',
]

const TEXT_STYLES: { key: TextStyle; label: string; hint: string }[] = [
  { key: 'plain', label: 'Solid', hint: 'Filled letters' },
  { key: 'outline', label: 'Hollow', hint: 'Outlined letters, so the photo shows through' },
  { key: 'plate', label: 'Plate', hint: 'Sitting on a colour block' },
]

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
  collapsed,
  onExpand,
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
  collapsed?: boolean
  onExpand?: () => void
  footer?: ReactNode
}) {
  const [tab, setTab] = useState<Tab>('layout')
  // On a phone the export controls are a tab rather than a permanent footer.
  // That block is 210px tall - on a 390x844 screen it was costing the canvas
  // a quarter of the display to show a menu you touch once, at the end.
  const phone = useMediaQuery(PHONE_QUERY)
  const tabs: Tab[] = phone ? ['layout', 'style', 'text', 'export'] : ['layout', 'style', 'text']
  const current: Tab = tab === 'export' && !phone ? 'layout' : tab
  const aspect = aspectValue(doc.aspect)
  const layouts = layoutsFor(photoCount)
  const active = selectedText ? doc.texts.find((t) => t.id === selectedText) ?? null : null
  const spec = active ? FONT_BY_KEY.get(active.font) : undefined

  const patchText = (patch: Partial<TextLayer>, key?: string) =>
    onDoc(
      { texts: doc.texts.map((t) => (t.id === selectedText ? { ...t, ...patch } : t)) },
      key ?? `text:${Object.keys(patch).join()}`,
    )

  const slot = selectedCell !== null ? doc.slots[selectedCell] : undefined
  const framed = selectedCell !== null && !!slot?.photoId

  const setSlot = (patch: Partial<typeof doc.slots[number]>, key: string) =>
    onDoc({ slots: doc.slots.map((s, i) => (i === selectedCell ? { ...s, ...patch } : s)) }, key)

  return (
    <aside className={`panel${collapsed ? ' collapsed' : ''}`}>
      {/*
        The chosen frame's own controls, on a phone.

        They used to float over the picture. That failed twice over: the sheet
        opens from the bottom and covered them completely, and on a shorter
        phone the canvas fills the stage, so the bar sat on the bottom of the
        photograph rather than beside it. Here they are never covered, never on
        top of the picture, and always in the same place. The row keeps its
        height when no frame is chosen so that choosing one does not resize the
        canvas underneath.
      */}
      {phone && (
        <div className="frame-bar" role="toolbar" aria-label="Chosen frame">
          {framed ? (
            <>
              <span className="frame-bar-label">Frame {selectedCell + 1}</span>
              <button
                className="tile-btn"
                aria-label="Zoom out"
                onClick={() => setSlot({ zoom: Math.max(1, slot!.zoom - 0.15) }, `zoom:${selectedCell}`)}
              >
                −
              </button>
              <span className="tile-zoom">{(slot!.zoom * 100).toFixed(0)}%</span>
              <button
                className="tile-btn"
                aria-label="Zoom in"
                onClick={() => setSlot({ zoom: Math.min(4, slot!.zoom + 0.15) }, `zoom:${selectedCell}`)}
              >
                +
              </button>
              <button
                className="tile-btn wide"
                onClick={() => setSlot({ zoom: 1, offsetX: 0, offsetY: 0 }, `reset:${selectedCell}`)}
              >
                Reset
              </button>
              <button className="tile-btn wide" onClick={() => onClearCell(selectedCell)}>
                Empty
              </button>
            </>
          ) : (
            <span className="frame-bar-hint">Tap a photo in the collage to work on it</span>
          )}
        </div>
      )}

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            className="tab"
            role="tab"
            aria-selected={current === t}
            onClick={() => {
              setTab(t)
              onExpand?.()
            }}
            style={{ textTransform: 'capitalize' }}
          >
            {t}
          </button>
        ))}
        <button
          className="sheet-handle"
          onClick={onExpand}
          aria-label={collapsed ? 'Show controls' : 'Hide controls'}
        >
          {collapsed ? '\u2303' : '\u2304'}
        </button>
      </div>

      <div className="panel-body">
        {current === 'layout' && (
          <>
            <div className="group">
              <h3 className="group-title">Canvas shape</h3>
              <div className="aspect-grid three">
                {COLLAGE_SHAPES.map(({ key, label, use, bestFor }) => {
                  const r = aspectValue(key)
                  return (
                    <button
                      key={key}
                      className="aspect-btn"
                      aria-pressed={doc.aspect === key}
                      onClick={() => onDoc({ aspect: key }, 'aspect')}
                      title={`${label} - best for ${bestFor}`}
                    >
                      <span
                        className="shape"
                        style={{
                          aspectRatio: String(r),
                          width: r >= 1 ? 16 : 'auto',
                          height: r >= 1 ? 'auto' : 16,
                        }}
                      />
                      <span className="aspect-use">{use}</span>
                      <span className="aspect-ratio">{label}</span>
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
                  <LayoutThumb cells={autoLayout(Math.max(photoCount, 1), aspect)} aspect={aspect} />
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

            {!phone && selectedCell !== null && doc.slots[selectedCell]?.photoId && (
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

        {current === 'style' && (
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

        {current === 'text' && (
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
                <h4 className="sub-title">Typeface</h4>
                <div className="font-grid">
                  {FONTS.map((f) => (
                    <button
                      key={f.key}
                      className="font-btn"
                      aria-pressed={active.font === f.key}
                      onClick={() => patchText({ font: f.key })}
                      title={f.label}
                      style={{ fontFamily: f.stack }}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                <h4 className="sub-title">Style</h4>
                <div className="icon-row">
                  {TEXT_STYLES.map((st) => (
                    <button
                      key={st.key}
                      className="icon-btn"
                      aria-pressed={active.style === st.key}
                      onClick={() => patchText({ style: st.key })}
                      title={st.hint}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
                <div className="icon-row">
                  <button
                    className="icon-btn"
                    aria-pressed={active.italic}
                    disabled={!spec?.hasItalic}
                    onClick={() => patchText({ italic: !active.italic })}
                    title={spec?.hasItalic ? 'Italic' : 'This typeface has no italic'}
                    style={{ fontStyle: 'italic', fontFamily: 'serif' }}
                  >
                    I
                  </button>
                  <button
                    className="icon-btn"
                    aria-pressed={active.uppercase || !!spec?.capsOnly}
                    disabled={!!spec?.capsOnly}
                    onClick={() => patchText({ uppercase: !active.uppercase })}
                    title={spec?.capsOnly ? 'This typeface is capitals only' : 'All capitals'}
                  >
                    AA
                  </button>
                  <button
                    className="icon-btn"
                    aria-pressed={active.shadow}
                    onClick={() => patchText({ shadow: !active.shadow })}
                    title="Drop shadow, for light text on a busy photo"
                  >
                    Shadow
                  </button>
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
                <h4 className="sub-title">Colour</h4>
                <div className="swatches">
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
                <div className="field" style={{ marginTop: 8 }}>
                  <input
                    type="color"
                    className="color-input"
                    value={active.color}
                    onChange={(e) => patchText({ color: e.target.value }, 'text:color')}
                    aria-label="Any text colour"
                  />
                </div>

                {active.style === 'plate' && (
                  <>
                    <h4 className="sub-title">Plate colour</h4>
                    <div className="field">
                      <input
                        type="color"
                        className="color-input"
                        value={active.plateColor}
                        onChange={(e) => patchText({ plateColor: e.target.value }, 'text:plate')}
                        aria-label="Plate colour"
                      />
                    </div>
                  </>
                )}
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
                {spec?.weights ? (
                  <Slider
                    label="Weight"
                    value={Math.min(spec.weights[1], Math.max(spec.weights[0], active.weight))}
                    min={spec.weights[0]}
                    max={spec.weights[1]}
                    step={50}
                    bipolar={false}
                    display={(v) => String(Math.round(v))}
                    onChange={(v) => patchText({ weight: Math.round(v) }, 'text:weight')}
                    onReset={() => patchText({ weight: 600 })}
                  />
                ) : (
                  <p className="field-hint" style={{ marginBottom: 10 }}>
                    {spec?.label} comes in one weight.
                  </p>
                )}
                <Slider
                  label="Letter spacing"
                  value={active.tracking}
                  min={-0.05}
                  max={0.4}
                  step={0.005}
                  display={(v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}`}
                  onChange={(v) => patchText({ tracking: v }, 'text:track')}
                  onReset={() => patchText({ tracking: 0 })}
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
        {current === 'export' && <div className="export-tab">{footer}</div>}
      </div>

      {!phone && footer}
    </aside>
  )
}
