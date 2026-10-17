import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  cropInViewSpace,
  cropPixelSize,
  cropRectFromViewSpace,
  framedSize,
  fullViewSize,
  resolveCrop,
  type ViewMode,
} from '../engine/geometry'
import { Renderer } from '../engine/renderer'
import { rotatedSize } from '../engine/geometry'
import type { AreaAdjust, Geometry } from '../engine/types'
import type { Photo } from '../state/photos'
import { AreaOverlay } from './AreaOverlay'
import { CropOverlay } from './CropOverlay'
import { PerspectiveOverlay } from './PerspectiveOverlay'

export type Tool = 'adjust' | 'areas' | 'crop' | 'perspective'

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: 'adjust', label: 'Adjust', key: 'A', icon: '◐' },
  { id: 'areas', label: 'Areas', key: 'L', icon: '◎' },
  { id: 'crop', label: 'Crop', key: 'C', icon: '⌗' },
  { id: 'perspective', label: 'Perspective', key: 'P', icon: '◧' },
]

/** Cap the backing store so a 4K monitor does not ask for a needlessly huge preview. */
const MAX_PREVIEW_EDGE = 2600

const VIEW_FOR: Record<Tool, ViewMode> = {
  adjust: 'edit',
  areas: 'edit',
  crop: 'crop',
  perspective: 'perspective',
}

export function Stage({
  photo,
  tool,
  onTool,
  onGeometry,
  selectedArea,
  onSelectArea,
  onArea,
  onError,
}: {
  photo: Photo
  tool: Tool
  onTool: (t: Tool) => void
  onGeometry: (patch: Partial<Geometry>) => void
  selectedArea: string | null
  onSelectArea: (id: string | null) => void
  onArea: (id: string, patch: Partial<AreaAdjust>, key: string) => void
  onError: (message: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const frameReq = useRef(0)
  const loadedFor = useRef<string | null>(null)

  const [box, setBox] = useState({ w: 0, h: 0 })
  const [compare, setCompare] = useState(false)
  const [split, setSplit] = useState(0.5)
  const [panning, setPanning] = useState(false)
  const [wiping, setWiping] = useState(false)
  const panStart = useRef({ x: 0, y: 0, ex: 0, ey: 0 })

  // Held in a ref so the renderer effect below can have empty deps. A WebGL
  // context is expensive and browsers only allow a handful at once, so it must
  // be created exactly once per mount - not every time a parent re-renders.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // --- renderer lifecycle ---------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      rendererRef.current = new Renderer(canvas)
    } catch (err) {
      onErrorRef.current((err as Error).message)
      return
    }
    return () => {
      rendererRef.current?.dispose()
      rendererRef.current = null
      loadedFor.current = null
    }
  }, [])

  // --- track the available space -------------------------------------------
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect
      setBox({ w: Math.max(0, r.width), h: Math.max(0, r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const geo = photo.edit.geometry
  const pw = photo.preview.width
  const ph = photo.preview.height
  const view = VIEW_FOR[tool]

  // Each tool frames the photo differently: Adjust shows the finished crop,
  // Crop shows the whole straightened frame so the box can grow, Perspective
  // shows the photo untouched so the handles stay put.
  let viewW: number
  let viewH: number
  if (view === 'edit') {
    const c = resolveCrop(pw, ph, geo)
    viewW = c.cw
    viewH = c.ch
  } else if (view === 'crop') {
    ;[viewW, viewH] = fullViewSize(pw, ph, geo)
  } else {
    ;[viewW, viewH] = rotatedSize(pw, ph, geo.rotate90)
  }
  const aspect = viewW / viewH

  let cssW = box.w
  let cssH = cssW / aspect
  if (cssH > box.h) {
    cssH = box.h
    cssW = cssH * aspect
  }
  cssW = Math.max(1, Math.floor(cssW))
  cssH = Math.max(1, Math.floor(cssH))

  const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2)
  let bw = Math.round(cssW * dpr)
  let bh = Math.round(cssH * dpr)
  const limit = Math.min(MAX_PREVIEW_EDGE, Math.max(viewW, viewH))
  const longest = Math.max(bw, bh)
  if (longest > limit) {
    const s = limit / longest
    bw = Math.max(1, Math.round(bw * s))
    bh = Math.max(1, Math.round(bh * s))
  }

  // --- draw ----------------------------------------------------------------
  useLayoutEffect(() => {
    const r = rendererRef.current
    const canvas = canvasRef.current
    if (!r || !canvas || box.w === 0) return

    if (loadedFor.current !== photo.id) {
      r.setImage(photo.preview)
      loadedFor.current = photo.id
    }
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`

    cancelAnimationFrame(frameReq.current)
    frameReq.current = requestAnimationFrame(() => {
      try {
        r.render(bw, bh, photo.edit, {
          split: compare && tool === 'adjust' ? split : -1,
          seed: photo.seed,
          view,
        })
      } catch (err) {
        onErrorRef.current((err as Error).message)
      }
    })
    return () => cancelAnimationFrame(frameReq.current)
  }, [photo, photo.edit, bw, bh, cssW, cssH, compare, split, box.w, view, tool])

  // --- drag the photo inside its crop, in Adjust ---------------------------
  const inView = cropInViewSpace(pw, ph, geo)
  const [fw, fh] = framedSize(pw, ph, geo)
  const canPan =
    tool === 'adjust' && (inView.cw < fw - 1 || inView.ch < fh - 1)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!canPan) return
      ;(e.target as Element).setPointerCapture(e.pointerId)
      panStart.current = { x: e.clientX, y: e.clientY, ex: inView.ex, ey: inView.ey }
      setPanning(true)
    },
    [canPan, inView.ex, inView.ey],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!panning) return
      // Dragging right should move the photo right, so the crop moves left.
      const dx = ((e.clientX - panStart.current.x) * inView.cw) / Math.max(cssW, 1)
      const dy = ((e.clientY - panStart.current.y) * inView.ch) / Math.max(cssH, 1)
      onGeometry({
        crop: cropRectFromViewSpace(
          pw,
          ph,
          geo,
          panStart.current.ex - dx,
          panStart.current.ey - dy,
          inView.cw,
          inView.ch,
        ),
      })
    },
    [panning, inView.cw, inView.ch, cssW, cssH, pw, ph, geo, onGeometry],
  )

  const endPan = useCallback(() => setPanning(false), [])

  // --- before/after wipe ----------------------------------------------------
  const onWipeMove = useCallback(
    (e: React.PointerEvent) => {
      if (!wiping) return
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setSplit(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
    },
    [wiping],
  )

  // --- keyboard tool switching ---------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 'c') onTool(tool === 'crop' ? 'adjust' : 'crop')
      else if (k === 'l') onTool(tool === 'areas' ? 'adjust' : 'areas')
      else if (k === 'p') onTool(tool === 'perspective' ? 'adjust' : 'perspective')
      else if (k === 'a' || e.key === 'Escape') onTool('adjust')
      else if (k === '\\') setCompare((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, onTool])

  const [cropW, cropH] = cropPixelSize(photo.nativeWidth, photo.nativeHeight, geo)
  const cropped = cropW !== photo.nativeWidth || cropH !== photo.nativeHeight

  return (
    <section className="stage">
      <div className="tool-rail" role="tablist" aria-label="Tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tool === t.id}
            className="tool-btn"
            onClick={() => onTool(t.id)}
            title={`${t.label}  (${t.key})`}
          >
            <span aria-hidden="true">{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <div className="stage-canvas-wrap" ref={wrapRef}>
        <div
          className={`canvas-frame${canPan ? ' grabbable' : ''}${panning ? ' grabbing' : ''}`}
          style={{ width: cssW, height: cssH }}
          onPointerMove={onWipeMove}
          onPointerUp={() => setWiping(false)}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
          />

          {tool === 'crop' && (
            <CropOverlay photo={photo} cssW={cssW} cssH={cssH} onGeometry={onGeometry} />
          )}

          {tool === 'areas' && (
            <AreaOverlay
              photo={photo}
              cssW={cssW}
              cssH={cssH}
              selectedId={selectedArea}
              onSelect={onSelectArea}
              onChange={onArea}
            />
          )}

          {tool === 'perspective' && (
            <PerspectiveOverlay
              photo={photo}
              cssW={cssW}
              cssH={cssH}
              canvas={canvasRef.current}
              onGeometry={onGeometry}
            />
          )}

          {tool === 'adjust' && compare && (
            <>
              <span className="wipe-label before">Before</span>
              <span className="wipe-label after">After</span>
              <div
                className="wipe-handle"
                style={{ left: `${split * 100}%` }}
                role="separator"
                aria-label="Before and after divider"
                onPointerDown={(e) => {
                  ;(e.target as Element).setPointerCapture(e.pointerId)
                  setWiping(true)
                }}
                onPointerUp={() => setWiping(false)}
              />
            </>
          )}
        </div>

        {tool === 'perspective' && (
          <p className="stage-hint">
            Drag the four corners onto something that is <b>really</b> a rectangle — the rim of
            the plate, the edge of the table, a menu. Arrow keys nudge; hold Shift to move faster.
          </p>
        )}
        {tool === 'areas' && (photo.edit.areas ?? []).length === 0 && (
          <p className="stage-hint">
            Add a <b>circle</b> or a <b>gradient</b> in the Areas panel, then drag it here.
          </p>
        )}
        {tool === 'crop' && (
          <p className="stage-hint">
            Drag the edges and corners. Pick a shape or lock it to <b>Free</b> in the Frame panel.
          </p>
        )}
      </div>

      <div className="stage-bar">
        <strong>{photo.name}</strong>
        <span className="sep">/</span>
        <span>
          {photo.nativeWidth} × {photo.nativeHeight}
        </span>
        {cropped && (
          <>
            <span className="sep">→</span>
            <span>
              {cropW} × {cropH}
            </span>
          </>
        )}
        {geo.corners && <span className="tag">perspective corrected</span>}
        {!photo.previewIsSource && (
          <span title="The on-screen preview is rendered from a 2200 px copy. The export is rendered from the original.">
            preview {Math.round((photo.preview.width / photo.nativeWidth) * 100)}%
          </span>
        )}
        <div className="topbar-spacer" />
        {tool === 'adjust' ? (
          <button className="btn btn-sm" aria-pressed={compare} onClick={() => setCompare((v) => !v)}>
            {compare ? 'Hide before' : 'Compare'}
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={() => onTool('adjust')}>
            Done
          </button>
        )}
      </div>
    </section>
  )
}
