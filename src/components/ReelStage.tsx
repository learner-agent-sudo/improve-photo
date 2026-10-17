import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  drawReelFrame,
  makeBackdrop,
  reelDuration,
  reelSize,
  type ReelItem,
  type ReelSettings,
} from '../engine/reel'
import { cropPixelSize } from '../engine/geometry'
import { Renderer } from '../engine/renderer'
import type { Edit } from '../engine/types'
import type { Photo } from '../state/photos'

/** The preview is drawn small: it only has to look right, not be the file. */
const PREVIEW_MAX_EDGE = 900
const PREVIEW_ITEM_EDGE = 1000

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

interface Cached {
  edit: Edit
  item: ReelItem
}

/**
 * The video preview: the real frames, drawn by the same function the encoder
 * uses, at screen size. Once a video has been made it is shown instead, as the
 * actual file playing.
 */
export function ReelStage({
  photos,
  settings,
  resultUrl,
  onError,
}: {
  photos: Photo[]
  settings: ReelSettings
  resultUrl: string | null
  onError: (message: string) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const cache = useRef(new Map<string, Cached>())
  const [ready, setReady] = useState(0)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [playing, setPlaying] = useState(true)
  const [time, setTime] = useState(0)
  const timeRef = useRef(0)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const duration = reelDuration(photos.length, settings)
  const [VW, VH] = reelSize(settings.aspect)

  // One WebGL context, offscreen, for rendering each photo's edit once.
  useEffect(() => {
    try {
      const c: HTMLCanvasElement | OffscreenCanvas =
        typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas')
      rendererRef.current = new Renderer(c)
    } catch (err) {
      onErrorRef.current((err as Error).message)
    }
    const store = cache.current
    return () => {
      for (const c of store.values()) (c.item.image as ImageBitmap).close?.()
      store.clear()
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
  }, [])

  // Render any photo that is new, or whose edit changed since last time.
  useEffect(() => {
    const r = rendererRef.current
    if (!r) return
    let cancelled = false
    ;(async () => {
      for (const p of photos) {
        if (cancelled) return
        const hit = cache.current.get(p.id)
        if (hit && hit.edit === p.edit) continue
        const [cw, ch] = cropPixelSize(p.preview.width, p.preview.height, p.edit.geometry)
        r.setImage(p.preview)
        const [w, h] = r.outputSizeFor(p.edit, Math.min(PREVIEW_ITEM_EDGE, Math.max(cw, ch)))
        r.render(w, h, p.edit, { seed: p.seed })
        const image = await createImageBitmap(r.canvas)
        if (cancelled) {
          image.close()
          return
        }
        ;(hit?.item.image as ImageBitmap | undefined)?.close?.()
        cache.current.set(p.id, {
          edit: p.edit,
          item: { image, width: image.width, height: image.height, backdrop: makeBackdrop(image, image.width, image.height) },
        })
        setReady((n) => n + 1)
        // Let the page breathe between photos on a slow phone.
        await new Promise((res) => setTimeout(res, 0))
      }
      // Photos taken out of the video no longer need their preview.
      const keep = new Set(photos.map((p) => p.id))
      for (const [id, c] of cache.current) {
        if (!keep.has(id)) {
          ;(c.item.image as ImageBitmap).close?.()
          cache.current.delete(id)
        }
      }
    })().catch((err) => onErrorRef.current((err as Error).message))
    return () => {
      cancelled = true
    }
  }, [photos])

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Fit the frame's shape into the space, leaving room for the controls.
  const aspect = VW / VH
  let cssW = box.w
  let cssH = cssW / aspect
  if (cssH > box.h - 52) {
    cssH = Math.max(0, box.h - 52)
    cssW = cssH * aspect
  }
  cssW = Math.max(1, Math.floor(cssW))
  cssH = Math.max(1, Math.floor(cssH))
  const dpr = Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 2)
  const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(cssW * dpr, cssH * dpr))
  const bw = Math.max(2, Math.round(cssW * dpr * scale))
  const bh = Math.max(2, Math.round(cssH * dpr * scale))

  const draw = useCallback(
    (t: number) => {
      const c = canvasRef.current
      if (!c) return
      if (c.width !== bw || c.height !== bh) {
        c.width = bw
        c.height = bh
      }
      const g = c.getContext('2d')
      if (!g) return
      const items = photos.map((p) => cache.current.get(p.id)?.item)
      drawReelFrame(g, bw, bh, t, photos.length, items, settings)
    },
    [bw, bh, photos, settings],
  )

  // Playback: wall-clock time, looping, like the apps play it.
  useEffect(() => {
    if (resultUrl) return
    if (!playing || duration <= 0) {
      draw(timeRef.current)
      return
    }
    let raf = 0
    let last = performance.now()
    let tick = 0
    const loop = (now: number) => {
      timeRef.current = (timeRef.current + (now - last) / 1000) % duration
      last = now
      draw(timeRef.current)
      // The clock label does not need 60 updates a second.
      if (++tick % 6 === 0) setTime(timeRef.current)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, duration, draw, resultUrl, ready])

  // Fewer photos or shorter slots can leave the playhead past the new end.
  useEffect(() => {
    if (timeRef.current >= duration) {
      timeRef.current = 0
      setTime(0)
    }
  }, [duration])

  const seek = (t: number) => {
    timeRef.current = Math.min(Math.max(0, t), Math.max(0, duration - 0.001))
    setTime(timeRef.current)
    draw(timeRef.current)
  }

  return (
    <section className="stage reel-stage">
      <div className="stage-canvas-wrap reel" ref={wrapRef}>
        {photos.length === 0 ? (
          <p className="reel-empty">Choose at least one photo for the video.</p>
        ) : resultUrl ? (
          <video
            className="reel-video"
            src={resultUrl}
            style={{ width: cssW, height: cssH }}
            controls
            playsInline
            loop
            muted
            autoPlay
          />
        ) : (
          <>
            <div className="canvas-frame reel-frame" style={{ width: cssW, height: cssH }}>
              <canvas ref={canvasRef} style={{ width: cssW, height: cssH }} aria-label="Video preview" />
            </div>
            <div className="reel-controls" style={{ width: cssW }}>
              <button
                className="btn btn-sm reel-play"
                onClick={() => setPlaying((v) => !v)}
                aria-label={playing ? 'Pause preview' : 'Play preview'}
              >
                {playing ? '❚❚' : '▶'}
              </button>
              <input
                type="range"
                className="reel-scrub"
                min={0}
                max={Math.max(0.01, duration)}
                step={0.01}
                value={Math.min(time, duration)}
                aria-label="Preview position"
                onChange={(e) => {
                  setPlaying(false)
                  seek(Number(e.target.value))
                }}
              />
              <span className="reel-clock">
                {clock(time)} / {clock(duration)}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
