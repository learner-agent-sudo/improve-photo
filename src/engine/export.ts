/**
 * Full-resolution export.
 *
 * The exporter owns one WebGL context and reuses it for every photo in a
 * batch, because browsers only allow a handful of live contexts and a nine-dish
 * meal would otherwise churn through them.
 *
 * Re-encoding through a canvas also strips EXIF, which means GPS coordinates
 * and camera serial numbers do not travel with a photo you post publicly.
 */
import { Renderer } from './renderer'
import type { Edit, ExportFormat, ExportSettings } from './types'

const MIME: Record<ExportFormat, string> = {
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  png: 'image/png',
}

const EXT: Record<ExportFormat, string> = { jpeg: 'jpg', webp: 'webp', png: 'png' }

/** Browsers cap canvas area; stay well inside it so exports never fail silently. */
const MAX_EXPORT_PIXELS = 40_000_000
const MAX_EXPORT_EDGE = 8192

export interface ExportResult {
  blob: Blob
  width: number
  height: number
  filename: string
  /** What the browser actually encoded, which can differ if WebP is unsupported. */
  mime: string
}

function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mime: string,
  quality: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return (canvas as OffscreenCanvas).convertToBlob({ type: mime, quality })
  }
  return new Promise((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The browser could not encode the image.'))),
      mime,
      quality,
    )
  })
}

export function exportFilename(originalName: string, format: ExportFormat, w: number, h: number) {
  const base = originalName.replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '').trim() || 'photo'
  return `${base}-${w}x${h}.${EXT[format]}`
}

export class Exporter {
  private renderer: Renderer
  private canvas: HTMLCanvasElement | OffscreenCanvas

  constructor() {
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(2, 2)
    } else {
      const c = document.createElement('canvas')
      c.width = 2
      c.height = 2
      this.canvas = c
    }
    this.renderer = new Renderer(this.canvas)
  }

  async run(
    bitmap: ImageBitmap,
    edit: Edit,
    settings: ExportSettings,
    originalName: string,
    seed = 17,
  ): Promise<ExportResult> {
    this.renderer.setImage(bitmap)
    let [w, h] = this.renderer.outputSizeFor(edit, settings.longEdge)

    const long = Math.max(w, h)
    if (long > MAX_EXPORT_EDGE) {
      const s = MAX_EXPORT_EDGE / long
      w = Math.max(1, Math.round(w * s))
      h = Math.max(1, Math.round(h * s))
    }
    if (w * h > MAX_EXPORT_PIXELS) {
      const s = Math.sqrt(MAX_EXPORT_PIXELS / (w * h))
      w = Math.max(1, Math.round(w * s))
      h = Math.max(1, Math.round(h * s))
    }

    this.renderer.render(w, h, edit, { seed })
    const mime = MIME[settings.format]
    const blob = await canvasToBlob(this.canvas, mime, settings.quality)
    return {
      blob,
      width: w,
      height: h,
      mime: blob.type || mime,
      filename: exportFilename(originalName, settings.format, w, h),
    }
  }

  /**
   * Renders the edited photo and hands it back as a bitmap rather than a file:
   * the video maker draws these onto its own frames. Same pipeline, same
   * limits, so a photo in a video looks exactly like the photo exported.
   */
  async renderBitmap(bitmap: ImageBitmap, edit: Edit, longEdge: number, seed = 17): Promise<ImageBitmap> {
    this.renderer.setImage(bitmap)
    let [w, h] = this.renderer.outputSizeFor(edit, longEdge)
    const long = Math.max(w, h)
    if (long > MAX_EXPORT_EDGE) {
      const s = MAX_EXPORT_EDGE / long
      w = Math.max(1, Math.round(w * s))
      h = Math.max(1, Math.round(h * s))
    }
    this.renderer.render(w, h, edit, { seed })
    return createImageBitmap(this.canvas)
  }

  dispose() {
    this.renderer.dispose()
  }
}

/** Triggers a download without leaving the page. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
