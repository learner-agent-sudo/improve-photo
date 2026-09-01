import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { aspectValue, EMPTY_SLOT, type CollageDoc } from '../engine/collage'
import { CollageRenderer, cellRects, measureText, type CollageSource } from '../engine/collageRender'

const MAX_CANVAS_EDGE = 2200
/** How long a finger must rest on a tile before it lifts out for swapping. */
const LIFT_MS = 420
/** Movement past this cancels the long press and becomes a pan. */
const LIFT_SLOP = 9
/** How far in the view can be pushed. Past 4x a phone screen shows one tile. */
const MAX_VIEW = 4
/** Two taps closer than this in time and place count as a double tap. */
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP = 24

type Mode = 'pan' | 'lift' | 'text' | 'view' | 'viewpan'

/** Where the picture sits inside its frame: a scale about the centre, then a shift. */
interface View {
  s: number
  x: number
  y: number
}

const FIT: View = { s: 1, x: 0, y: 0 }

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
  /** For a view gesture: the view when the fingers landed, and where they landed. */
  baseView?: View
  anchorX?: number
  anchorY?: number
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

  // The view is a CSS transform on the frame, so pinching is instant - it never
  // waits on a re-render of the collage. `renderScale` follows it once the
  // fingers lift, and that is what re-renders the canvas at a matching pixel
  // count, so a picture held at 3x is drawn at 3x rather than merely magnified.
  const [view, setView] = useState<View>(FIT)
  const [renderScale, setRenderScale] = useState(1)
  const settle = useRef<number | undefined>(undefined)
  const lastTap = useRef({ t: 0, x: 0, y: 0 })

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
  let bw = Math.round(cssW * dpr * renderScale)
  let bh = Math.round(cssH * dpr * renderScale)
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

  // --- the view --------------------------------------------------------------
  /**
   * Keeps the frame overlapping the screen.
   *
   * At fit there is no slack and the frame stays centred; zoomed in, the shift
   * is limited to the part of the frame that hangs off each edge, so the
   * picture can never be flung away and lost.
   */
  const clampView = useCallback(
    (v: View): View => {
      const s = Math.max(1, Math.min(MAX_VIEW, v.s))
      const slackX = Math.max(0, (cssW * s - box.w) / 2)
      const slackY = Math.max(0, (cssH * s - box.h) / 2)
      return {
        s,
        x: Math.max(-slackX, Math.min(slackX, v.x)),
        y: Math.max(-slackY, Math.min(slackY, v.y)),
      }
    },
    [cssW, cssH, box.w, box.h],
  )

  /** Redraws at a pixel count matching the zoom, once the fingers are still. */
  const settleRender = useCallback((s: number) => {
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => setRenderScale(Math.max(1, Math.min(MAX_VIEW, s))), 140)
  }, [])

  const zoomView = useCallback(
    (factor: number, atX?: number, atY?: number) => {
      const wrap = wrapRef.current?.getBoundingClientRect()
      setView((cur) => {
        const s = Math.max(1, Math.min(MAX_VIEW, cur.s * factor))
        if (!wrap || atX === undefined || atY === undefined) {
          const k = s / cur.s
          settleRender(s)
          return clampView({ s, x: cur.x * k, y: cur.y * k })
        }
        // Hold whatever sits under the fingers still while the scale changes.
        const cx = wrap.left + wrap.width / 2
        const cy = wrap.top + wrap.height / 2
        const localX = (atX - cx - cur.x) / cur.s
        const localY = (atY - cy - cur.y) / cur.s
        settleRender(s)
        return clampView({ s, x: atX - cx - s * localX, y: atY - cy - s * localY })
      })
    },
    [clampView, settleRender],
  )

  const fitView = useCallback(() => {
    setView(FIT)
    setRenderScale(1)
  }, [])

  // A canvas that changes shape or size should start from a whole view again.
  useEffect(() => {
    setView(FIT)
    setRenderScale(1)
  }, [doc.aspect, doc.layoutId])

  useEffect(() => () => window.clearTimeout(settle.current), [])

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

      // Two fingers always mean the same thing: make the whole collage bigger
      // or smaller. An earlier attempt gave the pinch to the selected frame's
      // own photo when the fingers landed on it, which read well on paper and
      // was unusable in practice - a frame is always selected, and the first
      // finger selects whatever it touches, so the same gesture did different
      // things depending on invisible state. Reframing a photo inside its cell
      // is the +/- pair on the frame's own toolbar, which says what it does.
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        window.clearTimeout(liftTimer.current)
        setLifted(null)
        drag.current = {
          mode: 'view',
          index: -1,
          startX: 0,
          startY: 0,
          baseX: 0,
          baseY: 0,
          baseZoom: 1,
          pinchStart: dist,
          baseView: view,
          anchorX: (a.x + b.x) / 2,
          anchorY: (a.y + b.y) / 2,
        }
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
      const slot = i === null ? undefined : doc.slots[i]

      // One finger, one rule, at every zoom level: inside the frame you have
      // chosen, it moves that photo; anywhere else, it drags the whole picture.
      //
      // The choosing is what makes it unambiguous, and unlike the selection the
      // pinch used to consult, this one is on screen - the chosen frame carries
      // a ring and its own toolbar. It costs a tap before a photo can be moved,
      // and buys a drag that behaves the same whether you are looking at the
      // whole collage or at one corner of it. Without that, zooming in would be
      // a trap: the tiles fill the screen, leaving nothing to grab to get back.
      const onChosen = i !== null && i === selectedCell && !!slot?.photoId
      if (!onChosen) {
        onSelectCell(i)
        drag.current = {
          mode: 'viewpan',
          index: -1,
          startX: e.clientX,
          startY: e.clientY,
          baseX: 0,
          baseY: 0,
          baseZoom: 1,
          pinchStart: 0,
          baseView: view,
        }
        return
      }

      drag.current = {
        mode: 'pan',
        index: i,
        startX: p.x,
        startY: p.y,
        baseX: slot!.offsetX,
        baseY: slot!.offsetY,
        baseZoom: slot!.zoom,
        pinchStart: 0,
      }
      // Moving a photo redraws its tile on every frame, and while the view is
      // enlarged that tile is being drawn at several times the pixel count.
      // Drop back to fit resolution for the duration of the drag: the picture
      // is moving, so nobody is reading its detail, and it sharpens again the
      // moment the finger lifts. Only the backing store changes - the canvas
      // keeps its CSS size, so nothing on screen moves.
      window.clearTimeout(settle.current)
      setRenderScale(1)
      // Hold still and the tile lifts out, ready to trade places.
      window.clearTimeout(liftTimer.current)
      liftTimer.current = window.setTimeout(() => {
        if (drag.current?.mode === 'pan' && drag.current.index === i) {
          drag.current.mode = 'lift'
          setLifted(i)
        }
      }, LIFT_MS)
    },
    [toCanvas, textAt, cellAt, doc.texts, doc.slots, onSelectCell, onSelectText, selectedCell, view, clampView],
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

      if (d.mode === 'viewpan' && d.baseView) {
        setView(
          clampView({
            s: d.baseView.s,
            x: d.baseView.x + (e.clientX - d.startX),
            y: d.baseView.y + (e.clientY - d.startY),
          }),
        )
        return
      }

      // Zooming and panning the view are the same gesture: scale by how far the
      // fingers spread, shift by where their midpoint went. Doing them together
      // is what makes the point between the fingers stay put.
      if (d.mode === 'view') {
        const vals = [...pointers.current.values()]
        if (vals.length < 2 || !d.baseView) return
        const wrap = wrapRef.current?.getBoundingClientRect()
        if (!wrap) return
        const dist = Math.hypot(vals[0].x - vals[1].x, vals[0].y - vals[1].y)
        const mx = (vals[0].x + vals[1].x) / 2
        const my = (vals[0].y + vals[1].y) / 2
        const s = Math.max(1, Math.min(MAX_VIEW, d.baseView.s * (dist / Math.max(d.pinchStart, 1))))
        const cx = wrap.left + wrap.width / 2
        const cy = wrap.top + wrap.height / 2
        const localX = ((d.anchorX ?? mx) - cx - d.baseView.x) / d.baseView.s
        const localY = ((d.anchorY ?? my) - cy - d.baseView.y) / d.baseView.s
        setView(clampView({ s, x: mx - cx - s * localX, y: my - cy - s * localY }))
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
    [toCanvas, cellAt, doc, bw, bh, onDoc, setSlot, clampView],
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

      // A pinch is never a tap.
      if (d?.mode === 'view') {
        settleRender(view.s)
        return
      }

      // Double tap, counted here rather than left to dblclick, because a canvas
      // with touch-action: none does not reliably raise one on a phone.
      //
      // It means zoom, wherever it lands. Giving it a second meaning on a photo
      // - "put this one back" - made it unreachable everywhere else, because a
      // filled collage is photos edge to edge and has essentially no background
      // left to tap. Putting a photo back is the Reset button on the frame's
      // own toolbar, which was already there and says so.
      const now = Date.now()
      const prev = lastTap.current
      const quick =
        now - prev.t < DOUBLE_TAP_MS &&
        Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_SLOP
      lastTap.current = quick ? { t: 0, x: 0, y: 0 } : { t: now, x: e.clientX, y: e.clientY }
      if (quick && (!d || d.mode === 'pan' || d.mode === 'viewpan')) {
        if (view.s > 1.02) fitView()
        else zoomView(2, e.clientX, e.clientY)
        return
      }

      // Whatever the gesture was, the picture is still now: draw it properly.
      if (view.s > 1.02) settleRender(view.s)
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
    [toCanvas, cellAt, doc.slots, onDoc, onSelectCell, view.s, settleRender, fitView, zoomView],
  )

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      // Ctrl or Command with the wheel is what every map and drawing tool uses
      // for "zoom the view", and it is also what a trackpad pinch sends.
      if (e.ctrlKey || e.metaKey) {
        zoomView(e.deltaY > 0 ? 0.92 : 1.08, e.clientX, e.clientY)
        return
      }
      const p = toCanvas(e)
      if (!p) return
      const i = cellAt(p)
      if (i === null) return
      zoomBy(i, e.deltaY > 0 ? -0.08 : 0.08)
    },
    [toCanvas, cellAt, zoomBy, zoomView],
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
          style={{
            width: cssW,
            height: cssH,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          }}
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
            onWheel={onWheel}
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

        {view.s > 1.02 && (
          <div className="view-chip" role="toolbar" aria-label="Zoom">
            <button
              className="view-btn"
              onClick={() => zoomView(1 / 1.4)}
              aria-label="Zoom out"
            >
              −
            </button>
            <span className="view-level" aria-live="polite">
              {Math.round(view.s * 100)}%
            </span>
            <button className="view-btn" onClick={() => zoomView(1.4)} aria-label="Zoom in">
              +
            </button>
            <button className="view-btn wide" onClick={fitView}>
              Fit
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
          pinch or double-tap to enlarge · drag to move around · tap a photo, then drag it to
          reframe · hold to swap two · Reset puts one back
        </span>
      </div>
    </section>
  )
}
