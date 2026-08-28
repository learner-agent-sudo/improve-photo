import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cropFrame, cropPixelSize, targetAspect } from '../engine/geometry'
import { Renderer } from '../engine/renderer'
import type { Geometry } from '../engine/types'
import type { Photo } from '../state/photos'

/** Cap the backing store so a 4K monitor does not ask for a needlessly huge preview. */
const MAX_PREVIEW_EDGE = 2600

export function Stage({
  photo,
  onGeometry,
  onError,
}: {
  photo: Photo
  onGeometry: (patch: Partial<Geometry>) => void
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
  const [dragging, setDragging] = useState<null | 'pan' | 'wipe'>(null)
  const panStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 })

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
  const aspect = targetAspect(pw, ph, geo)

  // Fit the crop aspect into the available box.
  let cssW = box.w
  let cssH = cssW / aspect
  if (cssH > box.h) {
    cssH = box.h
    cssW = cssH * aspect
  }
  cssW = Math.max(1, Math.floor(cssW))
  cssH = Math.max(1, Math.floor(cssH))

  const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2)
  const frame = cropFrame(pw, ph, geo)
  let bw = Math.round(cssW * dpr)
  let bh = Math.round(cssH * dpr)
  // Never ask for more pixels than the source crop actually has, and never
  // exceed the cap. Both keep the aspect intact.
  const limit = Math.min(MAX_PREVIEW_EDGE, Math.max(frame.cw, frame.ch))
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
          split: compare ? split : -1,
          seed: photo.seed,
        })
      } catch (err) {
        onErrorRef.current((err as Error).message)
      }
    })
    return () => cancelAnimationFrame(frameReq.current)
  }, [photo, photo.edit, bw, bh, cssW, cssH, compare, split, box.w])

  // --- panning the crop -----------------------------------------------------
  const canPan = frame.slackX > 0.5 || frame.slackY > 0.5

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!canPan) return
      ;(e.target as Element).setPointerCapture(e.pointerId)
      panStart.current = { x: e.clientX, y: e.clientY, ox: geo.offsetX, oy: geo.offsetY }
      setDragging('pan')
    },
    [canPan, geo.offsetX, geo.offsetY],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragging !== 'pan') return
      // Screen pixels -> source pixels -> fraction of the available slack.
      const perPxX = frame.cw / Math.max(cssW, 1)
      const perPxY = frame.ch / Math.max(cssH, 1)
      const dx = ((e.clientX - panStart.current.x) * perPxX) / Math.max(frame.slackX, 1e-3)
      const dy = ((e.clientY - panStart.current.y) * perPxY) / Math.max(frame.slackY, 1e-3)
      onGeometry({
        offsetX: Math.max(-1, Math.min(1, panStart.current.ox - dx)),
        offsetY: Math.max(-1, Math.min(1, panStart.current.oy - dy)),
      })
    },
    [dragging, frame.cw, frame.ch, frame.slackX, frame.slackY, cssW, cssH, onGeometry],
  )

  const endDrag = useCallback(() => setDragging(null), [])

  // --- before/after wipe ----------------------------------------------------
  const onWipeMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragging !== 'wipe') return
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setSplit(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)))
    },
    [dragging],
  )

  const [cropW, cropH] = cropPixelSize(photo.nativeWidth, photo.nativeHeight, geo)

  return (
    <section className="stage">
      <div className="stage-canvas-wrap" ref={wrapRef}>
        <div
          className={`canvas-frame${canPan ? ' grabbable' : ''}${dragging === 'pan' ? ' grabbing' : ''}`}
          style={{ width: cssW, height: cssH }}
          onPointerMove={onWipeMove}
          onPointerUp={endDrag}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
          {compare && (
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
                  setDragging('wipe')
                }}
                onPointerUp={endDrag}
              />
            </>
          )}
        </div>
      </div>

      <div className="stage-bar">
        <strong>{photo.name}</strong>
        <span className="sep">/</span>
        <span>
          {photo.nativeWidth} × {photo.nativeHeight}
        </span>
        {(cropW !== photo.nativeWidth || cropH !== photo.nativeHeight) && (
          <>
            <span className="sep">→</span>
            <span>
              cropped {cropW} × {cropH}
            </span>
          </>
        )}
        <div className="topbar-spacer" />
        <button
          className="btn btn-sm"
          aria-pressed={compare}
          onClick={() => setCompare((v) => !v)}
        >
          {compare ? 'Hide before' : 'Compare'}
        </button>
      </div>
    </section>
  )
}
