import { useCallback, useRef, useState } from 'react'
import { outputToFrame } from '../engine/geometry'
import { apply, invert, type Pt } from '../engine/matrix'
import type { AreaAdjust } from '../engine/types'
import type { Photo } from '../state/photos'

type Handle = 'move' | 'rx' | 'ry' | 'start' | 'end'

interface Drag {
  id: string
  handle: Handle
  /** The area and the pointer, both in area UV, when the drag began. */
  area: AreaAdjust
  from: Pt
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Handles for the local adjustments, drawn over the finished crop.
 *
 * Areas are stored on the rectified photo (see AreaAdjust), so everything here
 * goes through one affine map and its inverse: output UV <-> area UV. The
 * ellipse is drawn as a polyline through that map rather than as an SVG
 * <ellipse>, because a straightened photo turns it on screen.
 */
export function AreaOverlay({
  photo,
  cssW,
  cssH,
  selectedId,
  onSelect,
  onChange,
}: {
  photo: Photo
  cssW: number
  cssH: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  onChange: (id: string, patch: Partial<AreaAdjust>, key: string) => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)

  const frame = outputToFrame(photo.preview.width, photo.preview.height, photo.edit.geometry, 'edit')
  const areas = photo.edit.areas ?? []

  const toArea = frame?.m
  const toOut = frame ? invert(frame.m) : null
  const long = frame ? Math.max(frame.rw, frame.rh) : 1
  // Area UV per long-edge unit, on each axis.
  const ux = frame ? frame.rw / long : 1
  const uy = frame ? frame.rh / long : 1

  const screen = (x: number, y: number) => {
    const p = apply(toOut!, x, y)
    return { x: p.x * cssW, y: p.y * cssH }
  }

  const pointerToArea = useCallback(
    (e: React.PointerEvent | PointerEvent): Pt | null => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect || !toArea) return null
      const u = (e.clientX - rect.left) / Math.max(rect.width, 1)
      const v = (e.clientY - rect.top) / Math.max(rect.height, 1)
      return apply(toArea, u, v)
    },
    [toArea],
  )

  const move = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return
      const p = pointerToArea(e)
      if (!p) return
      const a = drag.area
      const dx = p.x - drag.from.x
      const dy = p.y - drag.from.y
      // A little slack past the edges: a gradient often wants to start just
      // outside the photo so its full-strength end is not visible as a line.
      const pos = (v: number) => clamp(v, -0.3, 1.3)
      let patch: Partial<AreaAdjust>
      switch (drag.handle) {
        case 'move':
          patch =
            a.kind === 'radial'
              ? { x: pos(a.x + dx), y: pos(a.y + dy) }
              : { x: pos(a.x + dx), y: pos(a.y + dy), x2: pos(a.x2 + dx), y2: pos(a.y2 + dy) }
          break
        case 'rx':
          patch = { rx: clamp(Math.abs(p.x - a.x) * ux, 0.02, 1.5) }
          break
        case 'ry':
          patch = { ry: clamp(Math.abs(p.y - a.y) * uy, 0.02, 1.5) }
          break
        case 'start':
          patch = { x: pos(p.x), y: pos(p.y) }
          break
        case 'end':
          patch = { x2: pos(p.x), y2: pos(p.y) }
          break
      }
      onChange(drag.id, patch, drag.handle)
    },
    [drag, pointerToArea, onChange, ux, uy],
  )

  const end = useCallback(() => setDrag(null), [])

  if (!frame || !toOut) return null

  const begin = (e: React.PointerEvent, area: AreaAdjust, handle: Handle) => {
    e.stopPropagation()
    const from = pointerToArea(e)
    if (!from) return
    ;(e.target as Element).setPointerCapture(e.pointerId)
    onSelect(area.id)
    setDrag({ id: area.id, handle, area, from })
  }

  /** Arrow keys nudge in screen space, so they agree with what is on screen. */
  const nudge = (e: React.KeyboardEvent, area: AreaAdjust, handle: Handle) => {
    const step = e.shiftKey ? 0.04 : 0.008
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const delta = d[e.key]
    if (!delta) return
    e.preventDefault()
    if (handle === 'rx' || handle === 'ry') {
      const grow = delta[0] + -delta[1]
      const key = handle
      onChange(area.id, { [key]: clamp(area[key] + grow, 0.02, 1.5) }, handle)
      return
    }
    const shift = (x: number, y: number) => {
      const s = apply(toOut, x, y)
      return apply(frame.m, s.x + delta[0], s.y + delta[1])
    }
    if (handle === 'end') {
      const q = shift(area.x2, area.y2)
      onChange(area.id, { x2: q.x, y2: q.y }, handle)
    } else {
      const q = shift(area.x, area.y)
      const patch: Partial<AreaAdjust> = { x: q.x, y: q.y }
      if (handle === 'move' && area.kind === 'linear') {
        patch.x2 = area.x2 + (q.x - area.x)
        patch.y2 = area.y2 + (q.y - area.y)
      }
      onChange(area.id, patch, handle)
    }
  }

  const ellipse = (a: AreaAdjust, scale: number) => {
    const pts: string[] = []
    for (let k = 0; k < 48; k++) {
      const t = (k / 48) * Math.PI * 2
      const s = screen(a.x + ((a.rx * scale) / ux) * Math.cos(t), a.y + ((a.ry * scale) / uy) * Math.sin(t))
      pts.push(`${s.x.toFixed(1)},${s.y.toFixed(1)}`)
    }
    return pts.join(' ')
  }

  /** A line across the whole frame through p, square to the gradient's direction. */
  const across = (a: AreaAdjust, px: number, py: number) => {
    const dx = (a.x2 - a.x) * ux
    const dy = (a.y2 - a.y) * uy
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len) * 3
    const ny = (dx / len) * 3
    const p = screen(px + nx / ux, py + ny / uy)
    const q = screen(px - nx / ux, py - ny / uy)
    return { x1: p.x, y1: p.y, x2: q.x, y2: q.y }
  }

  const handle = (
    a: AreaAdjust,
    h: Handle,
    at: { x: number; y: number },
    label: string,
    variant = '',
  ) => (
    <button
      key={`${a.id}-${h}`}
      className={`area-handle ${variant}${drag?.id === a.id && drag.handle === h ? ' dragging' : ''}`}
      style={{ left: at.x, top: at.y }}
      aria-label={label}
      onPointerDown={(e) => begin(e, a, h)}
      onKeyDown={(e) => nudge(e, a, h)}
    />
  )

  return (
    <div
      ref={rootRef}
      className="area-overlay"
      style={{ width: cssW, height: cssH }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerDown={(e) => {
        // A tap on the photo itself, not on a handle, puts the selection down.
        if (e.target === e.currentTarget) onSelect(null)
      }}
    >
      <svg width={cssW} height={cssH} aria-hidden="true">
        {areas.map((a) => {
          const on = a.id === selectedId
          const stroke = on ? 'var(--amber)' : 'rgba(244,239,230,0.55)'
          if (a.kind === 'radial') {
            return (
              <g key={a.id} opacity={on ? 1 : 0.7}>
                <polygon points={ellipse(a, 1)} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={3} />
                <polygon points={ellipse(a, 1)} fill="none" stroke={stroke} strokeWidth={1.5} />
                {on && (
                  <polygon
                    points={ellipse(a, 1 - clamp(a.feather, 0.05, 1))}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={1}
                    strokeDasharray="4 4"
                  />
                )}
              </g>
            )
          }
          const s = screen(a.x, a.y)
          const t = screen(a.x2, a.y2)
          return (
            <g key={a.id} opacity={on ? 1 : 0.7}>
              <line {...across(a, a.x, a.y)} stroke="rgba(0,0,0,0.35)" strokeWidth={3} />
              <line {...across(a, a.x, a.y)} stroke={stroke} strokeWidth={1.5} />
              {on && (
                <>
                  <line {...across(a, a.x2, a.y2)} stroke={stroke} strokeWidth={1} strokeDasharray="5 4" />
                  <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={stroke} strokeWidth={1} strokeDasharray="2 4" />
                </>
              )}
            </g>
          )
        })}
      </svg>

      {areas.map((a, i) => {
        const n = i + 1
        if (a.id !== selectedId) {
          // Unselected areas show one pin, which is also how you pick them.
          const at = a.kind === 'radial' ? screen(a.x, a.y) : screen((a.x + a.x2) / 2, (a.y + a.y2) / 2)
          return handle(a, 'move', at, `Select area ${n}`, 'pin')
        }
        if (a.kind === 'radial') {
          return [
            handle(a, 'move', screen(a.x, a.y), `Area ${n}, move`, 'centre'),
            handle(a, 'rx', screen(a.x + a.rx / ux, a.y), `Area ${n}, width`),
            handle(a, 'ry', screen(a.x, a.y + a.ry / uy), `Area ${n}, height`),
          ]
        }
        return [
          handle(a, 'start', screen(a.x, a.y), `Area ${n}, full-strength end`, 'centre'),
          handle(a, 'end', screen(a.x2, a.y2), `Area ${n}, faded end`),
          handle(a, 'move', screen((a.x + a.x2) / 2, (a.y + a.y2) / 2), `Area ${n}, move`, 'mid'),
        ]
      })}
    </div>
  )
}
