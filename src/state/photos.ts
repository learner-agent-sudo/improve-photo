/**
 * Loading photos into the session.
 *
 * Nothing is uploaded and nothing is written to disk: a photo lives as an
 * ImageBitmap in this tab and disappears when the tab closes.
 *
 * Memory strategy: we keep only a downscaled preview per photo. The original
 * File is retained (that costs nothing, the browser already has it) and is
 * re-decoded at export time. Holding nine full-resolution 12 MP bitmaps would
 * be roughly half a gigabyte and would fall over on a phone.
 */
import { analyseBitmap } from '../engine/analysis'
import { autoEnhance, type AutoResult } from '../engine/auto'
import { decodeImageFile, fitBitmap, make2dCanvas } from '../engine/decode'
import { NEUTRAL_GEOMETRY, type Analysis, type Edit } from '../engine/types'

/** Long edge of the interactive preview. Big enough to judge sharpening. */
export const PREVIEW_EDGE = 2200
const THUMB_EDGE = 240

export interface Photo {
  id: string
  name: string
  file: File
  nativeWidth: number
  nativeHeight: number
  preview: ImageBitmap
  thumbUrl: string
  analysis: Analysis
  auto: AutoResult
  edit: Edit
  presetId: string
  /** Stable grain seed so a photo does not shimmer between renders. */
  seed: number
}

let counter = 0

async function makeThumbUrl(bitmap: ImageBitmap): Promise<string> {
  const small = await fitBitmap(bitmap, THUMB_EDGE)
  const { canvas, ctx } = make2dCanvas(small.width, small.height)
  ctx.drawImage(small, 0, 0)
  if (small !== bitmap) small.close()
  const blob =
    'convertToBlob' in canvas
      ? await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.82 })
      : await new Promise<Blob>((res, rej) =>
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? res(b) : rej(new Error('thumbnail encode failed'))),
            'image/jpeg',
            0.82,
          ),
        )
  return URL.createObjectURL(blob)
}

export async function createPhoto(file: File): Promise<Photo> {
  const full = await decodeImageFile(file)
  try {
    // Analyse at native resolution: the noise estimate is meaningless otherwise.
    const analysis = analyseBitmap(full)
    const auto = autoEnhance(analysis)
    const preview = await fitBitmap(full, PREVIEW_EDGE)
    const thumbUrl = await makeThumbUrl(full)

    return {
      id: `p${++counter}-${Date.now().toString(36)}`,
      name: file.name,
      file,
      nativeWidth: full.width,
      nativeHeight: full.height,
      preview,
      thumbUrl,
      analysis,
      auto,
      edit: {
        adjustments: auto.adjustments,
        levels: auto.levels,
        geometry: { ...NEUTRAL_GEOMETRY },
      },
      presetId: 'auto',
      seed: Math.floor(Math.random() * 997) + 3,
    }
  } finally {
    // The preview is an independent bitmap, so the full-size one can go now.
    full.close()
  }
}

export function disposePhoto(photo: Photo) {
  photo.preview.close()
  URL.revokeObjectURL(photo.thumbUrl)
}

/**
 * Re-decodes the original file for export.
 *
 * When the export is smaller than the original we decode at twice the target
 * long edge rather than full resolution. Beyond 2x the extra detail is thrown
 * away by the downscale anyway, and it keeps denoise and sharpening acting at
 * the same relative scale they did in the preview, so the file you download
 * matches what you approved on screen.
 */
export async function decodeForExport(photo: Photo, targetLongEdge: number): Promise<ImageBitmap> {
  const bitmap = await decodeImageFile(photo.file)
  if (targetLongEdge <= 0) return bitmap
  const cap = Math.min(Math.max(photo.nativeWidth, photo.nativeHeight), targetLongEdge * 2)
  const fitted = await fitBitmap(bitmap, cap)
  if (fitted !== bitmap) bitmap.close()
  return fitted
}
