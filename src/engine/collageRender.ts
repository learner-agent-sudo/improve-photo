/**
 * Drawing a collage.
 *
 * Each tile is rendered through the ordinary stage-1 WebGL pipeline at exactly
 * the pixel size it will occupy, then blitted 1:1 onto a 2D canvas that carries
 * the background, the gutters, the rounded corners and the text. Compositing in
 * 2D rather than in WebGL keeps text and rounded corners trivial and costs
 * nothing in quality, because every tile is already at its final resolution.
 */
import { displayText, fontShorthand, slotEdit, type CollageDoc, type TextLayer } from './collage'
import { make2dCanvas } from './decode'
import { Renderer } from './renderer'
import type { Edit } from './types'

export interface CollageSource {
  id: string
  preview: ImageBitmap
  edit: Edit
  seed: number
  /** Native size, used only to decide whether a tile would be upscaled. */
  nativeWidth: number
  nativeHeight: number
}

export interface DrawOptions {
  /** Outline empty cells and number them. Preview only; never in an export. */
  showPlaceholders?: boolean
  /** Draw a selection ring around this cell. */
  selectedCell?: number | null
  /** Draw a selection box around this text layer. */
  selectedText?: string | null
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function roundedPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  if (typeof (ctx as CanvasRenderingContext2D).roundRect === 'function') {
    ;(ctx as CanvasRenderingContext2D).roundRect(x, y, w, h, rr)
    return
  }
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

/** Pixel rectangle of every cell, given the canvas size and spacing. */
export function cellRects(doc: CollageDoc, W: number, H: number) {
  const short = Math.min(W, H)
  const pad = doc.padding * short
  const gut = doc.gutter * short
  // Expand the working area by half a gutter so that, after each cell is inset
  // by half a gutter, the outermost edges land exactly on the padding.
  const ax = pad - gut / 2
  const ay = pad - gut / 2
  const aw = W - 2 * pad + gut
  const ah = H - 2 * pad + gut
  return doc.cells.map((c) => ({
    x: ax + c.x * aw + gut / 2,
    y: ay + c.y * ah + gut / 2,
    w: Math.max(1, c.w * aw - gut),
    h: Math.max(1, c.h * ah - gut),
  }))
}

/**
 * Renders tiles and caches them.
 *
 * One WebGL context serves every tile. Cache keys use a revision number derived
 * from object identity: the app replaces a Photo object whenever its edit
 * changes, so a changed photo naturally misses the cache while an unchanged one
 * hits it - no deep comparison, and no stale tiles.
 */
export class CollageRenderer {
  private gl: Renderer
  private glCanvas: AnyCanvas
  private cache = new Map<string, AnyCanvas>()
  private revs = new WeakMap<object, number>()
  private nextRev = 1

  constructor() {
    this.glCanvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(2, 2)
        : Object.assign(document.createElement('canvas'), { width: 2, height: 2 })
    this.gl = new Renderer(this.glCanvas)
  }

  private rev(o: object): number {
    let r = this.revs.get(o)
    if (r === undefined) {
      r = this.nextRev++
      this.revs.set(o, r)
    }
    return r
  }

  private tile(src: CollageSource, edit: Edit, w: number, h: number): AnyCanvas {
    const key = `${src.id}:${this.rev(edit)}:${w}x${h}`
    const hit = this.cache.get(key)
    if (hit) return hit

    this.gl.setImage(src.preview)
    this.gl.render(w, h, edit, { seed: src.seed })

    const { canvas, ctx } = make2dCanvas(w, h)
    ctx.drawImage(this.glCanvas as CanvasImageSource, 0, 0)
    // Bounded so a long session cannot grow without limit.
    if (this.cache.size > 64) {
      const oldest = this.cache.keys().next().value
      if (oldest) this.cache.delete(oldest)
    }
    this.cache.set(key, canvas)
    return canvas
  }

  /** Forces every tile to be re-rendered, e.g. after the working images change. */
  invalidate() {
    this.cache.clear()
  }

  draw(
    ctx: Ctx2D,
    doc: CollageDoc,
    sources: Map<string, CollageSource>,
    W: number,
    H: number,
    opts: DrawOptions = {},
  ) {
    const short = Math.min(W, H)
    const rad = doc.radius * short

    ctx.save()
    ctx.fillStyle = doc.background
    ctx.fillRect(0, 0, W, H)

    const rects = cellRects(doc, W, H)
    rects.forEach((r, i) => {
      const slot = doc.slots[i]
      const src = slot?.photoId ? sources.get(slot.photoId) : undefined

      if (!src) {
        if (opts.showPlaceholders) {
          ctx.save()
          roundedPath(ctx, r.x, r.y, r.w, r.h, rad)
          ctx.fillStyle = 'rgba(0,0,0,0.06)'
          ctx.fill()
          ctx.setLineDash([6, 6])
          ctx.strokeStyle = 'rgba(0,0,0,0.28)'
          ctx.lineWidth = 1.5
          ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(0,0,0,0.38)'
          ctx.font = `500 ${Math.max(11, short * 0.028)}px 'IBM Plex Mono', ui-monospace, monospace`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(i + 1), r.x + r.w / 2, r.y + r.h / 2)
          ctx.restore()
        }
        return
      }

      const w = Math.max(1, Math.round(r.w))
      const h = Math.max(1, Math.round(r.h))
      const edit = slotEdit(src.edit, src.preview.width, src.preview.height, w / h, slot)
      const tile = this.tile(src, edit, w, h)

      ctx.save()
      roundedPath(ctx, r.x, r.y, r.w, r.h, rad)
      ctx.clip()
      ctx.drawImage(tile as CanvasImageSource, Math.round(r.x), Math.round(r.y), w, h)
      ctx.restore()
    })

    // --- text ---------------------------------------------------------------
    for (const t of doc.texts) {
      drawText(ctx, t, W, H, short)
    }

    // --- selection, preview only -------------------------------------------
    if (opts.selectedCell != null && rects[opts.selectedCell]) {
      const r = rects[opts.selectedCell]
      ctx.save()
      roundedPath(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2, rad)
      ctx.strokeStyle = '#f2a03d'
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.restore()
    }

    if (opts.selectedText) {
      const t = doc.texts.find((x) => x.id === opts.selectedText)
      if (t) {
        const px = Math.max(4, t.size * short)
        const box = measureText(ctx, t, px)
        ctx.save()
        ctx.translate(t.x * W, t.y * H)
        ctx.rotate((t.rotation * Math.PI) / 180)
        const ox = t.align === 'center' ? -box.w / 2 : t.align === 'right' ? -box.w : 0
        ctx.strokeStyle = '#f2a03d'
        ctx.lineWidth = 1.5
        ctx.setLineDash([5, 4])
        ctx.strokeRect(ox - px * 0.2, -box.h / 2 - px * 0.15, box.w + px * 0.4, box.h + px * 0.3)
        ctx.restore()
      }
    }

    ctx.restore()
  }

  dispose() {
    this.cache.clear()
    this.gl.dispose()
  }
}

/** Applies a layer's typography to a context. Shared so measuring matches drawing. */
function applyFont(ctx: Ctx2D, t: TextLayer, px: number) {
  ctx.font = fontShorthand(t, px)
  // Not in every engine yet; assigning it where it is missing is harmless, and
  // preview and export share the same canvas API so they can never disagree.
  ;(ctx as CanvasRenderingContext2D).letterSpacing = `${t.tracking.toFixed(3)}em`
}

export function measureText(ctx: Ctx2D, t: TextLayer, px: number) {
  const prevFont = ctx.font
  const prevSpacing = (ctx as CanvasRenderingContext2D).letterSpacing
  applyFont(ctx, t, px)
  const lines = displayText(t).split('\n')
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 1)
  ctx.font = prevFont
  ;(ctx as CanvasRenderingContext2D).letterSpacing = prevSpacing
  return { w, h: lines.length * px * 1.22, lines }
}

/**
 * One text layer.
 *
 * Order matters: the plate is laid down before the shadow is turned on, so the
 * plate itself casts nothing and the shadow belongs to the letters alone. A
 * shadowed plate would read as a smudge behind a solid block.
 */
function drawText(ctx: Ctx2D, t: TextLayer, W: number, H: number, short: number) {
  const px = Math.max(4, t.size * short)
  ctx.save()
  ctx.translate(t.x * W, t.y * H)
  ctx.rotate((t.rotation * Math.PI) / 180)
  applyFont(ctx, t, px)
  ctx.textAlign = t.align
  ctx.textBaseline = 'middle'

  const lines = displayText(t).split('\n')
  const lh = px * 1.22
  const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 1)
  const originX = t.align === 'center' ? -widest / 2 : t.align === 'right' ? -widest : 0

  if (t.style === 'plate') {
    const padX = px * 0.32
    const padY = px * 0.2
    const boxH = lines.length * lh
    ctx.fillStyle = t.plateColor
    roundedPath(
      ctx,
      originX - padX,
      -boxH / 2 - padY + (lh - px) / 2,
      widest + padX * 2,
      boxH + padY * 2,
      px * 0.18,
    )
    ctx.fill()
  }

  if (t.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.5)'
    ctx.shadowBlur = px * 0.28
    ctx.shadowOffsetY = px * 0.05
  }

  if (t.style === 'outline') {
    ctx.strokeStyle = t.color
    ctx.lineWidth = Math.max(1, px * 0.055)
    ctx.lineJoin = 'round'
    lines.forEach((line, i) => ctx.strokeText(line, 0, (i - (lines.length - 1) / 2) * lh))
  } else {
    ctx.fillStyle = t.color
    lines.forEach((line, i) => ctx.fillText(line, 0, (i - (lines.length - 1) / 2) * lh))
  }
  ctx.restore()
}

/**
 * Renders the finished collage for download.
 *
 * Waits for the web fonts first: an export that raced the font load would fall
 * back to a system serif and silently differ from what was on screen.
 */
export async function exportCollage(
  doc: CollageDoc,
  sources: Map<string, CollageSource>,
  W: number,
  H: number,
  format: 'jpeg' | 'webp' | 'png',
  quality: number,
): Promise<Blob> {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready
    } catch {
      /* proceed with whatever is loaded */
    }
  }
  const { canvas, ctx } = make2dCanvas(W, H)
  const renderer = new CollageRenderer()
  try {
    renderer.draw(ctx, doc, sources, W, H, { showPlaceholders: false })
  } finally {
    renderer.dispose()
  }
  const mime = `image/${format}`
  if ('convertToBlob' in canvas) {
    return (canvas as OffscreenCanvas).convertToBlob({ type: mime, quality })
  }
  return new Promise<Blob>((res, rej) =>
    (canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? res(b) : rej(new Error('The browser could not encode the collage.'))),
      mime,
      quality,
    ),
  )
}
