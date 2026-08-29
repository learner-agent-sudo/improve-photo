import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { aspectValue, EMPTY_SLOT, type CollageDoc } from '../engine/collage'
import { CollageRenderer, cellRects, measureText, type CollageSource } from '../engine/collageRender'

const MAX_CANVAS_EDGE = 2200
/** How long a finger must rest on a tile before it lifts out for swapping. */
const LIFT_MS = 420
/** Movement past this cancels the long press and becomes a pan. */
const LIFT_SLOP = 9

type Mode = 'pan' | 'lift' | 'text' | 'pinch'

interface DragState {
  mode: Mode
  index: number
  textId?: string
  startX: number
  startY: number
  baseX: number
  baseY: number
  baseZoom: number
  pinchStart: number
}

/**
 * The collage canvas.
 *
 * Gestures are chosen so the common one is the cheap one: a plain drag always
 * repositions the photo inside its frame and never turns into something else
 * halfway through. Swapping two photos is a deliberate long press, which is
 * also the only arrangement that works on a touchscreen, where there is no
 * hover and no right button to hang a second meaning on.
 */
export function CollageStage({
  doc,
  sources,
  selectedCell,
  selectedText,
  onDoc,
  onSelectCell,
  onSelectText,
  onError,
}: {
  doc: CollageDoc
  sources: Map<string, CollageSource>
  selectedCell: number | null
  selectedText: string | null
  onDoc: (patch: Partial<CollageDoc>, coalesceKey?: string) => void
  onSelectCell: (i: number | null) => void
  onSelectText: (id: string | null) => void
  onError: (message: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<CollageRenderer | null>(null)
  const raf = useRef(0)
  const drag = useRef<DragState | null>(null)
  const liftTimer = useRef<number | undefined>(undefined)
  const pointers = useRef(new Map<number, { x: number; y: number }>())

  const [box, setBox] = useState({ w: 0, h: 0 })
  const [lifted, setLifted] = useState<number | null>(null)
  const [dropCell, setDropCell] = useState<number | null>(null)

  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    try {
      rendererRef.current = new CollageRenderer()
    } catch (err) {
      onErrorRef.current((err as Error).message)
    }
    return () => {
      rendererRef.current?.dispose()
      rendererRef.current = null
      window.clearTimeout(liftTimer.current)
    }
  }, [])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) =>
      setBox({ w: Math.max(0, e.contentRect.width), h: Math.max(0, e.contentRect.height) }),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const aspect = aspectValue(doc.aspect)
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
  const longest = Math.max(bw, bh)
  if (longest > MAX_CANVAS_EDGE) {
    const s = MAX_CANVAS_EDGE / longest
    bw = Math.round(bw * s)
    bh = Math.round(bh * s)
  }

  // --- draw ------------------------------------------------------------------
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const r = rendererRef.current
    if (!canvas || !r || box.w === 0) return
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      try {
        r.draw(ctx, doc, sources, bw, bh, {
          showPlaceholders: true,
          selectedCell: dropCell ?? (lifted !== null ? lifted : selectedCell),
          selectedText,
        })
      } catch (err) {
        onErrorRef.current((err as Error).message)
      }
    })
    return () => cancelAnimationFrame(raf.current)
  }, [doc, sources, bw, bh, cssW, cssH, box.w, selectedCell, selectedText, dropCell, lifted])

  // --- hit testing -----------------------------------------------------------
  const toCanvas = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return null
      return {
        x: ((e.clientX - rect.left) / Math.max(rect.width, 1)) * bw,
        y: ((e.clientY - rect.top) / Math.max(rect.height, 1)) * bh,
      }
    },
    [bw, bh],
  )

  const cellAt = useCallback(
    (p: { x: number; y: number }) => {
      const rects = cellRects(doc, bw, bh)
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return i
      }
      return null
    },
    [doc, bw, bh],
  )

  const textAt = useCallback(
    (p: { x: number; y: number }) => {
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx) return null
      const short = Math.min(bw, bh)
      for (let i = doc.texts.length - 1; i >= 0; i--) {
        const t = doc.texts[i]
        const px = Math.max(4, t.size * short)
        const m = measureText(ctx, t, px)
        const a = (-t.rotation * Math.PI) / 180
        const dx = p.x - t.x * bw
        const dy = p.y - t.y * bh
        const lx = dx * Math.cos(a) - dy * Math.sin(a)
        const ly = dx * Math.sin(a) + dy * Math.cos(a)
        const ox = t.align === 'center' ? -m.w / 2 : t.align === 'right' ? -m.w : 0
        // A generous margin, because a fingertip is far wider than a glyph.
        const pad = Math.max(px * 0.35, 14)
        if (lx >= ox - pad && lx <= ox + m.w + pad && Math.abs(ly) <= m.h / 2 + pad) return t.id
      }
      return null
    },
    [doc.texts, bw, bh],
  )

  // --- slot helpers ----------------------------------------------------------
  const setSlot = useCallback(
    (i: number, patch: Partial<(typeof doc.slots)[number]>, key: string) =>
      onDoc({ slots: doc.slots.map((s, k) => (k === i ? { ...s, ...patch } : s)) }, key),
    [doc.slots, onDoc],
  )

  const zoomBy = useCallback(
    (i: number, delta: number) => {
      const s = doc.slots[i]
      if (!s?.photoId) return
      setSlot(i, { zoom: Math.max(1, Math.min(4, s.zoom + delta)) }, `zoom:${i}`)
    },
    [doc.slots, setSlot],
  )

  const resetSlot = useCallback(
    (i: number) => setSlot(i, { zoom: 1, offsetX: 0, offsetY: 0 }, `reset:${i}`),
    [setSlot],
  )

  // --- pointers --------------------------------------------------------------
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const p = toCanvas(e)
      if (!p) return
      ;(e.target as Element).setPointerCapture(e.pointerId)
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

      // Second finger on the same tile: pinch to zoom.
      if (pointers.current.size === 2 && drag.current && drag.current.mode !== 'text') {
        const [a, b] = [...pointers.current.values()]
        window.clearTimeout(liftTimer.current)
        drag.current = {
          ...drag.current,
          mode: 'pinch',
          baseZoom: doc.slots[drag.current.index]?.zoom ?? 1,
          pinchStart: Math.hypot(a.x - b.x, a.y - b.y),
        }
        setLifted(null)
        return
      }
      if (pointers.current.size > 1) return

      const tid = textAt(p)
      if (tid) {
        const t = doc.texts.find((x) => x.id === tid)!
        onSelectText(tid)
        onSelectCell(null)
        drag.current = {
          mode: 'text',
          index: -1,
          textId: tid,
          startX: p.x,
          startY: p.y,
          baseX: t.x,
          baseY: t.y,
          baseZoom: 1,
          pinchStart: 0,
        }
        return
      }

      const i = cellAt(p)
      onSelectText(null)
      onSelectCell(i)
      if (i === null) return
      const slot = doc.slots[i]
      if (!slot?.photoId) return

      drag.current = {
        mode: 'pan',
        index: i,
        startX: p.x,
        startY: p.y,
        baseX: slot.offsetX,
        baseY: slot.offsetY,
        baseZoom: slot.zoom,
        pinchStart: 0,
      }
      // Hold still and the tile lifts out, ready to trade places.
      window.clearTimeout(liftTimer.current)
      liftTimer.current = window.setTimeout(() => {
        if (drag.current?.mode === 'pan' && drag.current.index === i) {
          drag.current.mode = 'lift'
          setLifted(i)
        }
      }, LIFT_MS)
    },
    [toCanvas, textAt, cellAt, doc.texts, doc.slots, onSelectCell, onSelectText],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (pointers.current.has(e.pointerId)) {
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      }
      const p = toCanvas(e)
      if (!p) return

      if (d.mode === 'pinch') {
        const vals = [...pointers.current.values()]
        if (vals.length < 2) return
        const dist = Math.hypot(vals[0].x - vals[1].x, vals[0].y - vals[1].y)
        const ratio = dist / Math.max(d.pinchStart, 1)
        setSlot(
          d.index,
          { zoom: Math.max(1, Math.min(4, d.baseZoom * ratio)) },
          `zoom:${d.index}`,
        )
        return
      }

      if (d.mode === 'text') {
        onDoc(
          {
            texts: doc.texts.map((t) =>
              t.id === d.textId
                ? { ...t, x: d.baseX + (p.x - d.startX) / bw, y: d.baseY + (p.y - d.startY) / bh }
                : t,
            ),
          },
          `text-move:${d.textId}`,
        )
        return
      }

      if (d.mode === 'lift') {
        setDropCell(cellAt(p))
        return
      }

      // Panning. Moving cancels the pending long press, and the drag is never
      // reinterpreted as something else however far it travels.
      if (Math.hypot(p.x - d.startX, p.y - d.startY) > LIFT_SLOP) {
        window.clearTimeout(liftTimer.current)
      }
      const r = cellRects(doc, bw, bh)[d.index]
      if (!r) return
      const dx = ((p.x - d.startX) / (r.w / 2)) * -1
      const dy = ((p.y - d.startY) / (r.h / 2)) * -1
      setSlot(
        d.index,
        {
          offsetX: Math.max(-1, Math.min(1, d.baseX + dx)),
          offsetY: Math.max(-1, Math.min(1, d.baseY + dy)),
        },
        'slot-pan',
      )
    },
    [toCanvas, cellAt, doc, bw, bh, onDoc, setSlot],
  )

  const endPointer = useCallback(
    (e: React.PointerEvent) => {
      pointers.current.delete(e.pointerId)
      window.clearTimeout(liftTimer.current)
      const d = drag.current
      if (pointers.current.size > 0) return
      drag.current = null
      setLifted(null)
      setDropCell(null)
      if (!d || d.mode !== 'lift') return

      const p = toCanvas(e)
      const target = p ? cellAt(p) : null
      if (target === null || target === d.index) return
      const slots = doc.slots.slice()
      const tmp = slots[d.index]
      slots[d.index] = slots[target]
      slots[target] = tmp
      onDoc({ slots }, 'slot-swap')
      onSelectCell(target)
    },
    [toCanvas, cellAt, doc.slots, onDoc, onSelectCell],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const p = toCanvas(e)
      if (!p) return
      const i = cellAt(p)
      if (i === null) return
      zoomBy(i, e.deltaY > 0 ? -0.08 : 0.08)
    },
    [toCanvas, cellAt, zoomBy],
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const p = toCanvas(e)
      if (!p) return
      const i = cellAt(p)
      if (i !== null && doc.slots[i]?.photoId) resetSlot(i)
    },
    [toCanvas, cellAt, doc.slots, resetSlot],
  )

  // --- dropping a photo from the roll ---------------------------------------
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const p = toCanvas(e)
      setDropCell(p ? cellAt(p) : null)
    },
    [toCanvas, cellAt],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDropCell(null)
      const photoId = e.dataTransfer.getData('text/darkroom-photo')
      const p = toCanvas(e)
      const i = p ? cellAt(p) : null
      if (!photoId || i === null) return
      onDoc(
        {
          slots: doc.slots.map((s, k) =>
            k === i ? { photoId, zoom: 1, offsetX: 0, offsetY: 0 } : s,
          ),
        },
        'slot-fill',
      )
      onSelectCell(i)
    },
    [toCanvas, cellAt, doc.slots, onDoc, onSelectCell],
  )

  const filled = doc.slots.filter((s) => s.photoId).length
  const activeSlot = selectedCell !== null ? doc.slots[selectedCell] : undefined
  const showTools = !!activeSlot?.photoId

  return (
    <section className="stage">
      <div className="stage-canvas-wrap collage" ref={wrapRef}>
        <div
          className={`canvas-frame${lifted !== null ? ' lifting' : ''}`}
          style={{ width: cssW, height: cssH }}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onWheel={onWheel}
            onDoubleClick={onDoubleClick}
            onDragOver={onDragOver}
            onDragLeave={() => setDropCell(null)}
            onDrop={onDrop}
          />
        </div>

        {showTools && selectedCell !== null && (
          <div className="tile-tools" role="toolbar" aria-label="Selected frame">
            <button className="tile-btn" onClick={() => zoomBy(selectedCell, -0.15)} aria-label="Zoom out">
              −
            </button>
            <span className="tile-zoom">{(activeSlot.zoom * 100).toFixed(0)}%</span>
            <button className="tile-btn" onClick={() => zoomBy(selectedCell, 0.15)} aria-label="Zoom in">
              +
            </button>
            <span className="tile-sep" />
            <button className="tile-btn wide" onClick={() => resetSlot(selectedCell)}>
              Reset
            </button>
            <button
              className="tile-btn wide"
              onClick={() =>
                onDoc(
                  { slots: doc.slots.map((s, k) => (k === selectedCell ? { ...EMPTY_SLOT } : s)) },
                  'clear',
                )
              }
            >
              Remove
            </button>
          </div>
        )}

        {filled === 0 && (
          <p className="stage-hint">
            Tap a frame, then tap a photo below. Or drag a photo straight onto one.
          </p>
        )}
      </div>

      <div className="stage-bar">
        <strong>Collage</strong>
        <span className="sep">/</span>
        <span>
          {filled} of {doc.cells.length} filled
        </span>
        <div className="topbar-spacer" />
        <span className="gesture-hint">
          drag to move the photo · pinch or scroll to zoom · hold to swap · double-tap to reset
        </span>
      </div>
    </section>
  )
}
