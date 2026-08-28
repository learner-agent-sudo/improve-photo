import { useCallback, useRef, useState } from 'react'
import { fromPerspectiveView, toPerspectiveView } from '../engine/geometry'
import { apply, unitSquareToQuad, type Pt } from '../engine/matrix'
import { UNIT_QUAD, type Geometry } from '../engine/types'
import type { Photo } from '../state/photos'
import { Loupe } from './Loupe'

const LABELS = ['top left', 'top right', 'bottom right', 'bottom left']

/**
 * The four-corner perspective tool.
 *
 * You mark the quadrilateral in the photo that is really a rectangle - the rim
 * of a plate seen from across the table, a menu held at an angle, a picture on
 * a wall - and the engine maps it back to a rectangle. That is what turns an
 * off-axis snap into a face-on one.
 *
 * While this is open the stage deliberately shows the photo *uncorrected*, so
 * the handles stay under your finger instead of chasing the correction they are
 * creating. Close the tool to see the result.
 */
export function PerspectiveOverlay({
  photo,
  cssW,
  cssH,
  canvas,
  onGeometry,
}: {
  photo: Photo
  cssW: number
  cssH: number
  canvas: HTMLCanvasElement | null
  onGeometry: (patch: Partial<Geometry>) => void
}) {
  const geo = photo.edit.geometry
  const corners = geo.corners ?? UNIT_QUAD
  const toView = toPerspectiveView(geo)
  const toSource = fromPerspectiveView(geo)
  const viewPts = corners.map((p) => apply(toView, p.x, p.y))

  const [dragging, setDragging] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const pointerToSource = useCallback(
    (e: React.PointerEvent): Pt | null => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return null
      const u = (e.clientX - rect.left) / Math.max(rect.width, 1)
      const v = (e.clientY - rect.top) / Math.max(rect.height, 1)
      const s = apply(toSource, u, v)
      // A little slack outside the frame is useful - it lets you square up an
      // object whose corner falls just off the edge of the photo.
      return {
        x: Math.min(1.25, Math.max(-0.25, s.x)),
        y: Math.min(1.25, Math.max(-0.25, s.y)),
      }
    },
    [toSource],
  )

  const move = useCallback(
    (e: React.PointerEvent) => {
      if (dragging === null) return
      const p = pointerToSource(e)
      if (!p) return
      const next = corners.map((c, i) => (i === dragging ? p : c)) as [Pt, Pt, Pt, Pt]
      onGeometry({ corners: next })
    },
    [dragging, corners, pointerToSource, onGeometry],
  )

  const end = useCallback(() => setDragging(null), [])

  // A projective map sends straight lines to straight lines, so the guide grid
  // inside the quad needs only its endpoints.
  const quadMap = unitSquareToQuad(viewPts)
  const gridLine = (a: [number, number], b: [number, number]) => {
    const p = apply(quadMap, a[0], a[1])
    const q = apply(quadMap, b[0], b[1])
    return { x1: p.x * cssW, y1: p.y * cssH, x2: q.x * cssW, y2: q.y * cssH }
  }
  const guides = [
    gridLine([1 / 3, 0], [1 / 3, 1]),
    gridLine([2 / 3, 0], [2 / 3, 1]),
    gridLine([0, 1 / 3], [1, 1 / 3]),
    gridLine([0, 2 / 3], [1, 2 / 3]),
  ]

  const polygon = viewPts.map((p) => `${p.x * cssW},${p.y * cssH}`).join(' ')
  const dragPt = dragging !== null ? viewPts[dragging] : null

  return (
    <div
      ref={rootRef}
      className="persp-overlay"
      style={{ width: cssW, height: cssH }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <svg width={cssW} height={cssH} aria-hidden="true">
        <defs>
          <mask id="persp-mask">
            <rect width={cssW} height={cssH} fill="white" />
            <polygon points={polygon} fill="black" />
          </mask>
        </defs>
        <rect width={cssW} height={cssH} fill="rgba(10,9,8,0.58)" mask="url(#persp-mask)" />
        {guides.map((g, i) => (
          <line key={i} {...g} stroke="rgba(242,160,61,0.30)" strokeWidth={1} />
        ))}
        <polygon
          points={polygon}
          fill="none"
          stroke="var(--amber)"
          strokeWidth={1.5}
          strokeDasharray="6 4"
        />
      </svg>

      {viewPts.map((p, i) => (
        <button
          key={i}
          className={`persp-handle${dragging === i ? ' dragging' : ''}`}
          style={{ left: p.x * cssW, top: p.y * cssH }}
          aria-label={`Perspective corner, ${LABELS[i]}`}
          onPointerDown={(e) => {
            ;(e.target as Element).setPointerCapture(e.pointerId)
            setDragging(i)
          }}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 0.02 : 0.004
            const d: Record<string, [number, number]> = {
              ArrowLeft: [-step, 0],
              ArrowRight: [step, 0],
              ArrowUp: [0, -step],
              ArrowDown: [0, step],
            }
            const delta = d[e.key]
            if (!delta) return
            e.preventDefault()
            // Nudge in view space, then convert, so the arrow keys agree with
            // what is on screen even when the photo is rotated or mirrored.
            const v = apply(toView, corners[i].x, corners[i].y)
            const s = apply(toSource, v.x + delta[0], v.y + delta[1])
            const next = corners.map((c, j) => (j === i ? s : c)) as [Pt, Pt, Pt, Pt]
            onGeometry({ corners: next })
          }}
        />
      ))}

      {dragPt && (
        <Loupe
          source={canvas}
          u={dragPt.x}
          v={dragPt.y}
          side={dragPt.x > 0.5 ? 'left' : 'right'}
        />
      )}
    </div>
  )
}
