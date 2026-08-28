import { useCallback, useRef, useState } from 'react'
import {
  aspectRatio,
  cropBoxInView,
  cropInViewSpace,
  cropRectFromViewSpace,
  framedSize,
} from '../engine/geometry'
import type { Geometry } from '../engine/types'
import type { Photo } from '../state/photos'

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

const CORNERS: Handle[] = ['nw', 'ne', 'se', 'sw']
const EDGES: Handle[] = ['n', 'e', 's', 'w']

interface DragState {
  handle: Handle
  x: number
  y: number
  l: number
  r: number
  t: number
  b: number
}

/**
 * The crop rectangle, with handles.
 *
 * While this is open the stage draws the whole straightened frame rather than
 * the finished crop, so the box has somewhere to grow into. The box stays
 * square to the screen and the photo tilts underneath it, which is how every
 * editor behaves and the only arrangement in which "straighten" feels like
 * levelling a horizon rather than rotating a picture.
 */
export function CropOverlay({
  photo,
  cssW,
  cssH,
  onGeometry,
}: {
  photo: Photo
  cssW: number
  cssH: number
  onGeometry: (patch: Partial<Geometry>) => void
}) {
  const w = photo.preview.width
  const h = photo.preview.height
  const geo = photo.edit.geometry
  const box = cropBoxInView(w, h, geo)
  const view = cropInViewSpace(w, h, geo)
  const [fw, fh] = framedSize(w, h, geo)
  const ratio = aspectRatio(geo.aspect, fw, fh)
  const minSize = 0.05 * Math.min(view.vw, view.vh)

  const drag = useRef<DragState | null>(null)
  const [active, setActive] = useState(false)

  const begin = useCallback(
    (handle: Handle) => (e: React.PointerEvent) => {
      e.stopPropagation()
      ;(e.target as Element).setPointerCapture(e.pointerId)
      drag.current = {
        handle,
        x: e.clientX,
        y: e.clientY,
        l: view.ex - view.cw / 2,
        r: view.ex + view.cw / 2,
        t: view.ey - view.ch / 2,
        b: view.ey + view.ch / 2,
      }
      setActive(true)
    },
    [view.ex, view.ey, view.cw, view.ch],
  )

  const move = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d) return
      const dx = ((e.clientX - d.x) * view.vw) / Math.max(cssW, 1)
      const dy = ((e.clientY - d.y) * view.vh) / Math.max(cssH, 1)

      let { l, r, t, b } = d

      if (d.handle === 'move') {
        l += dx
        r += dx
        t += dy
        b += dy
      } else {
        if (d.handle.includes('w')) l += dx
        if (d.handle.includes('e')) r += dx
        if (d.handle.includes('n')) t += dy
        if (d.handle.includes('s')) b += dy

        if (l > r - minSize) l = r - minSize
        if (t > b - minSize) t = b - minSize

        if (ratio !== null) {
          if (CORNERS.includes(d.handle)) {
            // Grow whichever axis the pointer pushed further, and pin the
            // opposite corner so the box does not slide while it resizes.
            let nw = r - l
            let nh = b - t
            if (nw / ratio > nh) nh = nw / ratio
            else nw = nh * ratio
            if (d.handle.includes('w')) l = r - nw
            else r = l + nw
            if (d.handle.includes('n')) t = b - nh
            else b = t + nh
          } else if (d.handle === 'n' || d.handle === 's') {
            const nw = (b - t) * ratio
            const mid = (l + r) / 2
            l = mid - nw / 2
            r = mid + nw / 2
          } else {
            const nh = (r - l) / ratio
            const mid = (t + b) / 2
            t = mid - nh / 2
            b = mid + nh / 2
          }
        }
      }

      onGeometry({
        crop: cropRectFromViewSpace(w, h, geo, (l + r) / 2, (t + b) / 2, r - l, b - t),
      })
    },
    [cssW, cssH, view.vw, view.vh, ratio, minSize, w, h, geo, onGeometry],
  )

  const end = useCallback(() => {
    drag.current = null
    setActive(false)
  }, [])

  const px = (v: number, of: number) => `${v * of}px`
  const cropW = Math.round(box.width * view.vw)
  const cropH = Math.round(box.height * view.vh)
  const scale = photo.nativeWidth / w

  return (
    <div
      className="crop-overlay"
      style={{ width: cssW, height: cssH }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <div
        className={`crop-box${active ? ' active' : ''}`}
        style={{
          left: px(box.left, cssW),
          top: px(box.top, cssH),
          width: px(box.width, cssW),
          height: px(box.height, cssH),
        }}
        onPointerDown={begin('move')}
      >
        <div className="crop-grid" aria-hidden="true">
          <i style={{ left: '33.333%' }} />
          <i style={{ left: '66.666%' }} />
          <b style={{ top: '33.333%' }} />
          <b style={{ top: '66.666%' }} />
        </div>

        {CORNERS.map((c) => (
          <span key={c} className={`crop-handle corner ${c}`} onPointerDown={begin(c)} />
        ))}
        {EDGES.map((c) => (
          <span key={c} className={`crop-handle edge ${c}`} onPointerDown={begin(c)} />
        ))}

        <span className="crop-readout">
          {Math.round(cropW * scale)} × {Math.round(cropH * scale)}
        </span>
      </div>
    </div>
  )
}
