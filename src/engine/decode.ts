/**
 * Turning a picked File into an ImageBitmap the GPU can take.
 *
 * Two things matter here and both bite phone photos specifically:
 *  - EXIF orientation. A portrait iPhone shot is stored landscape with an
 *    orientation tag; ignore it and every portrait photo arrives sideways.
 *  - HEIC. iPhones default to HEIC, which Safari decodes and most other
 *    browsers do not. We detect it and say something useful instead of
 *    failing with a blank canvas.
 */

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedFormatError'
  }
}

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1',
])

/** Sniffs the ISO-BMFF major brand, which is more reliable than the file name. */
export async function isHeif(file: File): Promise<boolean> {
  if (/\.(heic|heif)$/i.test(file.name)) return true
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    if (head.length < 12) return false
    const box = String.fromCharCode(head[4], head[5], head[6], head[7])
    if (box !== 'ftyp') return false
    const brand = String.fromCharCode(head[8], head[9], head[10], head[11])
    return HEIF_BRANDS.has(brand)
  } catch {
    return false
  }
}

async function decodeViaImgElement(file: File): Promise<ImageBitmap> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    // The CSS initial value of image-orientation is from-image, so modern
    // browsers apply the EXIF rotation for us on this path.
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return await createImageBitmap(img)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function decodeImageFile(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    // Older Safari rejects the options bag for Blob sources; fall back.
  }
  try {
    return await decodeViaImgElement(file)
  } catch (err) {
    if (await isHeif(file)) {
      throw new UnsupportedFormatError(
        `${file.name} is a HEIC/HEIF file and this browser cannot open it. ` +
          'Safari can. Otherwise set iPhone Settings > Camera > Formats to "Most Compatible" ' +
          'so new photos are saved as JPEG, or share the photo to yourself first, which converts it.',
      )
    }
    throw new UnsupportedFormatError(
      `${file.name} could not be read as an image (${(err as Error).message || 'unknown error'}).`,
    )
  }
}

/** Downscales so the long edge fits `maxEdge`, preserving aspect. */
export async function fitBitmap(bitmap: ImageBitmap, maxEdge: number): Promise<ImageBitmap> {
  const long = Math.max(bitmap.width, bitmap.height)
  if (long <= maxEdge) return bitmap
  const s = maxEdge / long
  return createImageBitmap(bitmap, {
    resizeWidth: Math.max(1, Math.round(bitmap.width * s)),
    resizeHeight: Math.max(1, Math.round(bitmap.height * s)),
    resizeQuality: 'high',
  })
}

/** OffscreenCanvas where available, a detached canvas otherwise (older Safari). */
export function make2dCanvas(w: number, h: number): {
  canvas: OffscreenCanvas | HTMLCanvasElement
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (ctx) return { canvas, ctx: ctx as OffscreenCanvasRenderingContext2D }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not get a 2D canvas context.')
  return { canvas, ctx }
}
