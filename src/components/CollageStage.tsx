import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { aspectValue, type CollageDoc } from '../engine/collage'
import { CollageRenderer, cellRects, measureText, type CollageSource } from '../engine/collageRender'

const MAX_CANVAS_EDGE = 2200

interface Drag {
  kind: 'pan' | 'swap' | 'text'
  index: number
  textId?: string
  startX: number
  startY: number
  baseX: number
  baseY: number
  moved: boolean
}

/**
 * The collage canvas and everything you can do to it directly.
 *
 * Dragging inside a tile pans the photo within its frame. Drag out of the tile
 * and it becomes a swap instead - the pan is rolled back and the tile you drop
 * on trades places - which is the behaviour a collage app is expected to have
 * without needing a separate mode for it.
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
  const drag = useRef<Drag | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
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
          selectedCell: dropCell ?? selectedCell,
          selectedText,
        })
      } catch (err) {
        onErrorRef.current((err as Error).message)
      }
    })
    return () => cancelAnimationFrame(raf.current)
  }, [doc, sources, bw, bh, cssW, cssH, box.w, selectedCell, selectedText, dropCell])

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
      // Topmost first, matching what the eye picks.
      for (let i = doc.texts.length - 1; i >= 0; i--) {
        const t = doc.texts[i]
        const px = Math.max(4, t.size * short)
        const m = measureText(ctx, t.text, px, t.weight, t.font)
        const cx = t.x * bw
        const cy = t.y * bh
        const a = (-t.rotation * Math.PI) / 180
        const dx = p.x - cx
        const dy = p.y - cy
        const lx = dx * Math.cos(a) - dy * Math.sin(a)
        const ly = dx * Math.sin(a) + dy * Math.cos(a)
        const ox = t.align === 'center' ? -m.w / 2 : t.align === 'right' ? -m.w : 0
        if (lx >= ox - px * 0.3 && lx <= ox + m.w + px * 0.3 && Math.abs(ly) <= m.h / 2 + px * 0.25) {
          return t.id
        }
      }
      return null
    },
    [doc.texts, bw, bh],
  )

  // --- pointer ---------------------------------------------------------------
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const p = toCanvas(e)
      if (!p) return
      ;(e.target as Element).setPointerCapture(e.pointerId)

      const tid = textAt(p)
      if (tid) {
        const t = doc.texts.find((x) => x.id === tid)!
        onSelectText(tid)
        onSelectCell(null)
        drag.current = { kind: 'text', index: -1, textId: tid, startX: p.x, startY: p.y, baseX: t.x, baseY: t.y, moved: false }
        return
      }

      const i = cellAt(p)
      onSelectText(null)
      onSelectCell(i)
      if (i === null) return
      const slot = doc.slots[i]
      if (!slot?.photoId) return
      drag.current = {
        kind: 'pan',
        index: i,
        startX: p.x,
        startY: p.y,
        baseX: slot.offsetX,
        baseY: slot.offsetY,
        moved: false,
      }
    },
    [toCanvas, textAt, cellAt, doc.texts, doc.slots, onSelectCell, onSelectText],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      const p = toCanvas(e)
      if (!d || !p) return
      d.moved = true

      if (d.kind === 'text') {
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

      const over = cellAt(p)
      if (d.kind === 'pan' && over !== null && over !== d.index) {
        // Left the tile: this is a swap, so undo the panning done so far.
        d.kind = 'swap'
        onDoc(
          {
            slots: doc.slots.map((s, i) =>
              i === d.index ? { ...s, offsetX: d.baseX, offsetY: d.baseY } : s,
            ),
          },
          'slot-pan',
        )
      }

      if (d.kind === 'swap') {
        setDropCell(over)
        return
      }

      const rects = cellRects(doc, bw, bh)
      const r = rects[d.index]
      const slot = doc.slots[d.index]
      if (!r || !slot) return
      // Two units of offset span the whole slack, so divide by half the tile.
      const dx = ((p.x - d.startX) / (r.w / 2)) * -1
      const dy = ((p.y - d.startY) / (r.h / 2)) * -1
      onDoc(
        {
          slots: doc.slots.map((s, i) =>
            i === d.index
              ? {
                  ...s,
                  offsetX: Math.max(-1, Math.min(1, d.baseX + dx)),
                  offsetY: Math.max(-1, Math.min(1, d.baseY + dy)),
                }
              : s,
          ),
        },
        'slot-pan',
      )
    },
    [toCanvas, cellAt, doc, bw, bh, onDoc],
  )

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      drag.current = null
      setDropCell(null)
      if (!d) return
      if (d.kind !== 'swap') return
      const p = toCanvas(e)
      const target = p ? cellAt(p) : null
      if (target === null || target === d.index) return
      const slots = doc.slots.slice()
      const a = slots[d.index]
      slots[d.index] = slots[target]
      slots[target] = a
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
      if (i === null || !doc.slots[i]?.photoId) return
      const step = e.deltaY > 0 ? -0.08 : 0.08
      onDoc(
        {
          slots: doc.slots.map((s, k) =>
            k === i ? { ...s, zoom: Math.max(1, Math.min(3, s.zoom + step)) } : s,
          ),
        },
        `slot-zoom:${i}`,
      )
    },
    [toCanvas, cellAt, doc.slots, onDoc],
  )

  // --- dropping a photo from the tray ---------------------------------------
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

  return (
    <section className="stage">
      <div className="stage-canvas-wrap collage" ref={wrapRef}>
        <div className="canvas-frame" style={{ width: cssW, height: cssH }}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={onWheel}
            onDragOver={onDragOver}
            onDragLeave={() => setDropCell(null)}
            onDrop={onDrop}
          />
        </div>
        {filled === 0 && (
          <p className="stage-hint">
            Drag a photo from the left onto a frame, or select a frame and click a photo.
          </p>
        )}
      </div>

      <div className="stage-bar">
        <strong>Collage</strong>
        <span className="sep">/</span>
        <span>
          {filled} of {doc.cells.length} frames filled
        </span>
        <div className="topbar-spacer" />
        <span>drag to reposition · drag out to swap · scroll to zoom</span>
      </div>
    </section>
  )
}
