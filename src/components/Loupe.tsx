import { useEffect, useRef } from 'react'

/**
 * A magnified view of the pixels under a dragged handle.
 *
 * Placing a perspective corner exactly on the edge of a plate or a menu is the
 * whole job of that tool, and a fingertip or cursor covers precisely the pixels
 * you are aiming at. The loupe puts them back where you can see them.
 */
export function Loupe({
  source,
  /** Position to magnify, in 0..1 of the source canvas. */
  u,
  v,
  /** Which side to sit on, so the loupe never hides the point of interest. */
  side,
}: {
  source: HTMLCanvasElement | null
  u: number
  v: number
  side: 'left' | 'right'
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const dest = ref.current
    if (!dest || !source || !source.width) return
    const ctx = dest.getContext('2d')
    if (!ctx) return
    const size = dest.width
    const zoom = 5
    const half = size / (2 * zoom)
    const sx = u * source.width
    const sy = v * source.height

    ctx.imageSmoothingEnabled = false // crisp pixels beat a smooth blur when aiming
    ctx.fillStyle = '#0a0908'
    ctx.fillRect(0, 0, size, size)
    ctx.drawImage(source, sx - half, sy - half, half * 2, half * 2, 0, 0, size, size)

    ctx.strokeStyle = 'rgba(242, 160, 61, 0.95)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(size / 2, 0)
    ctx.lineTo(size / 2, size)
    ctx.moveTo(0, size / 2)
    ctx.lineTo(size, size / 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(242, 160, 61, 0.35)'
    ctx.strokeRect(size / 2 - 6, size / 2 - 6, 12, 12)
  }, [source, u, v])

  return (
    <div className={`loupe ${side}`} aria-hidden="true">
      <canvas ref={ref} width={132} height={132} />
    </div>
  )
}
