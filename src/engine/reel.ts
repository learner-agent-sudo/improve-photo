/**
 * Stage 3: turn the edited photos into a short video.
 *
 * Each photo gets a slot of a few seconds, drifts slowly while it is on screen
 * (the "Ken Burns" move every slideshow app uses, because a still photo in a
 * video reads as a frozen frame), and fades into the next. There is no sound
 * on purpose: Instagram, TikTok and Xiaohongshu all have their own licensed
 * music libraries, and adding a track there avoids both encoding audio here,
 * which older iPhones cannot do in a browser, and the question of baking a song
 * into the file.
 *
 * Frames are drawn on a 2D canvas and encoded with the browser's own hardware
 * encoder (WebCodecs), then wrapped as an MP4 by Mediabunny. Nothing leaves the
 * device. The same `drawReelFrame` paints the live preview and every encoded
 * frame, so the preview is what you get.
 */
import { bestLongEdge } from './collage'
import type { AspectKey } from './types'
import { ASPECT_RATIOS } from './types'

export type ReelMotion = 'gentle' | 'none'
export type ReelTransition = 'fade' | 'cut'
/** Fill crops to the frame; whole shows all of the photo over a blurred copy of itself. */
export type ReelFit = 'fill' | 'whole'

export interface ReelSettings {
  aspect: AspectKey
  secondsPerPhoto: number
  motion: ReelMotion
  transition: ReelTransition
  fit: ReelFit
}

export const DEFAULT_REEL: ReelSettings = {
  aspect: '9:16',
  secondsPerPhoto: 2.5,
  motion: 'gentle',
  transition: 'fade',
  fit: 'fill',
}

export const REEL_FPS = 30
/** Length of a crossfade, taken from the end of the outgoing photo's slot. */
export const FADE_SECONDS = 0.5
export const SECONDS_CHOICES = [1.5, 2.5, 4]
/** How far the slow zoom travels. More than this starts to feel like a camera move. */
const ZOOM = 0.08
/** Past this many photos the file gets long and the phone gets warm. */
export const MAX_REEL_PHOTOS = 30

/**
 * Pixel size for a shape. The short edge is always 1080, which is what every
 * platform's guidance asks for; the long edge comes from the same table the
 * collage uses (1080 x 1920 for 9:16), so a shape means the same thing in
 * both places. Both edges are even, which H.264 requires.
 */
export function reelSize(aspect: AspectKey): [number, number] {
  const ratio = aspect in ASPECT_RATIOS ? ASPECT_RATIOS[aspect as keyof typeof ASPECT_RATIOS] : 9 / 16
  const long = bestLongEdge(aspect)
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2)
  return ratio >= 1 ? [even(long), even(long / ratio)] : [even(long * ratio), even(long)]
}

export const reelDuration = (count: number, s: ReelSettings) => count * s.secondsPerPhoto

/** A photo on screen at some moment: which one, how opaque, how far through its move. */
export interface Visible {
  index: number
  alpha: number
  /** 0..1 progress through the photo's whole time on screen. */
  progress: number
}

/**
 * What is on screen at time t. Photo i owns the slot [i*S, (i+1)*S); with
 * fades on, photo i+1 starts appearing FADE seconds before its slot, drawn over
 * photo i. Pure, so the encoder and the preview cannot disagree.
 */
export function visibleAt(t: number, count: number, s: ReelSettings): Visible[] {
  if (count === 0) return []
  const S = s.secondsPerPhoto
  const fade = s.transition === 'fade' ? Math.min(FADE_SECONDS, S / 3) : 0
  const i = Math.min(count - 1, Math.max(0, Math.floor(t / S)))
  const span = (k: number) => {
    const start = k * S - (k > 0 ? fade : 0)
    const end = (k + 1) * S
    return Math.min(1, Math.max(0, (t - start) / (end - start)))
  }
  const out: Visible[] = [{ index: i, alpha: 1, progress: span(i) }]
  const next = i + 1
  if (fade > 0 && next < count) {
    const into = t - (next * S - fade)
    if (into > 0) out.push({ index: next, alpha: Math.min(1, into / fade), progress: span(next) })
  }
  return out
}

/** One photo, ready to draw. */
export interface ReelItem {
  image: CanvasImageSource
  width: number
  height: number
  /** A tiny copy of the photo that, stretched, makes a soft blurred backdrop. */
  backdrop: CanvasImageSource
}

/**
 * The backdrop for "whole photo" framing. Scaling a 24 px copy back up with
 * smoothing gives a blur that works in every browser, unlike ctx.filter, which
 * older Safari does not support - and it is computed once per photo, not per
 * frame.
 */
export function makeBackdrop(image: CanvasImageSource, w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  const bw = w >= h ? 24 : Math.max(2, Math.round((24 * w) / h))
  const bh = w >= h ? Math.max(2, Math.round((24 * h) / w)) : 24
  const c: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bw, bh) : Object.assign(document.createElement('canvas'), { width: bw, height: bh })
  const g = c.getContext('2d') as CanvasRenderingContext2D
  g.imageSmoothingQuality = 'high'
  g.drawImage(image, 0, 0, bw, bh)
  return c
}

/** Each photo moves a little differently, so a sequence does not feel mechanical. */
function moveFor(index: number) {
  const zoomIn = index % 2 === 0
  const dirs = [
    [0.6, 0.3],
    [-0.5, 0.4],
    [0.4, -0.5],
    [-0.6, -0.3],
  ]
  const [dx, dy] = dirs[index % dirs.length]
  return { zoomIn, dx, dy }
}

function drawOne(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  item: ReelItem,
  v: Visible,
  s: ReelSettings,
) {
  const { zoomIn, dx, dy } = moveFor(v.index)
  const p = s.motion === 'gentle' ? v.progress : 0.5
  const zoom = s.motion === 'gentle' ? 1 + ZOOM * (zoomIn ? p : 1 - p) : 1
  g.globalAlpha = v.alpha

  if (s.fit === 'whole') {
    // Backdrop first: the photo, blurred and dimmed, covering the frame.
    const cover = Math.max(W / item.width, H / item.height) * 1.08
    const bw = item.width * cover
    const bh = item.height * cover
    g.imageSmoothingEnabled = true
    g.drawImage(item.backdrop, (W - bw) / 2, (H - bh) / 2, bw, bh)
    g.fillStyle = `rgba(0, 0, 0, ${0.28 * v.alpha})`
    g.fillRect(0, 0, W, H)
    // Then the whole photo, contained, with half the movement.
    const fit = Math.min(W / item.width, H / item.height) * (1 + (zoom - 1) / 2)
    const w = item.width * fit
    const h = item.height * fit
    g.drawImage(item.image, (W - w) / 2, (H - h) / 2, w, h)
    return
  }

  // Fill: cover the frame, then spend the slack the zoom creates on a slow pan.
  const cover = Math.max(W / item.width, H / item.height) * zoom
  const w = item.width * cover
  const h = item.height * cover
  const slackX = w - W
  const slackY = h - H
  const t = s.motion === 'gentle' ? p - 0.5 : 0
  const x = (W - w) / 2 + slackX * dx * t
  const y = (H - h) / 2 + slackY * dy * t
  g.drawImage(item.image, x, y, w, h)
}

/** Paints the frame at time t. Missing items (still loading) are skipped. */
export function drawReelFrame(
  g: CanvasRenderingContext2D,
  W: number,
  H: number,
  t: number,
  count: number,
  items: (ReelItem | undefined)[],
  s: ReelSettings,
) {
  g.save()
  g.globalAlpha = 1
  g.fillStyle = '#0f0e0c'
  g.fillRect(0, 0, W, H)
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  for (const v of visibleAt(t, count, s)) {
    const item = items[v.index]
    if (item) drawOne(g, W, H, item, v, s)
  }
  g.restore()
}

/**
 * How large to render a photo so it still covers the frame at full zoom,
 * without wasting memory on pixels the frame never shows.
 */
export function itemLongEdge(cropAspect: number, W: number, H: number): number {
  const need = 1 + ZOOM + 0.02
  const w = Math.max(W, H * cropAspect) * need
  const h = w / cropAspect
  return Math.ceil(Math.min(2600, Math.max(w, h)))
}

export class ReelCancelled extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'ReelCancelled'
  }
}

/**
 * Can this browser make the video? Checked before anything is rendered, so an
 * unsupported browser gets an explanation instead of a failed export.
 */
export async function canMakeReel(aspect: AspectKey): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false
  try {
    const { canEncodeVideo, Quality } = await import('./mp4')
    const [width, height] = reelSize(aspect)
    return await canEncodeVideo('avc', { width, height, quality: new Quality({ bitrate: bitrateFor(width, height) }) })
  } catch {
    return false
  }
}

/** About 8 Mbit/s at 1080 x 1920, in proportion for other shapes. */
function bitrateFor(w: number, h: number) {
  return Math.round(Math.max(4_000_000, (8_000_000 * w * h) / (1080 * 1920)))
}

/**
 * Encodes the video. Photos are prepared on demand and released as soon as
 * they are off screen, so only two full-size photos are ever in memory - a
 * twenty-photo reel would otherwise want several hundred megabytes on a phone.
 */
export async function encodeReel(opts: {
  count: number
  settings: ReelSettings
  prepare: (index: number, longEdgeFor: (cropAspect: number) => number) => Promise<ReelItem>
  release: (item: ReelItem) => void
  onProgress: (fraction: number) => void
  signal: AbortSignal
  /**
   * H.264 unless told otherwise. VP9 exists only for testing in open-source
   * Chromium, which ships without an H.264 encoder; the app never asks for it,
   * because Instagram and friends want H.264.
   */
  codec?: 'avc' | 'vp9'
}): Promise<Blob> {
  const { count, settings, prepare, release, onProgress, signal, codec = 'avc' } = opts
  const [W, H] = reelSize(settings.aspect)
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, Quality } = await import('./mp4')

  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H })
  const g = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D

  const output = new Output({
    // Fast start puts the index at the front, so the file can begin playing
    // before it has finished downloading - which is how the apps preview it.
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  })
  const source = new CanvasSource(canvas, {
    codec,
    quality: new Quality({ bitrate: bitrateFor(W, H) }),
    keyFrameInterval: 2,
  })
  output.addVideoTrack(source, { frameRate: REEL_FPS })
  await output.start()

  const items: (ReelItem | undefined)[] = new Array(count)
  const longEdgeFor = (a: number) => itemLongEdge(a, W, H)
  const frames = Math.round(reelDuration(count, settings) * REEL_FPS)
  try {
    for (let f = 0; f < frames; f++) {
      if (signal.aborted) throw new ReelCancelled()
      const t = f / REEL_FPS
      const visible = visibleAt(t, count, settings)
      const needed = new Set(visible.map((v) => v.index))
      for (const i of needed) if (!items[i]) items[i] = await prepare(i, longEdgeFor)
      // Anything before the earliest visible photo will never be shown again.
      const first = Math.min(...needed)
      for (let i = 0; i < first; i++) {
        const it = items[i]
        if (it) {
          release(it)
          items[i] = undefined
        }
      }
      drawReelFrame(g, W, H, t, count, items, settings)
      await source.add(t, 1 / REEL_FPS)
      if (f % 5 === 0) onProgress(f / frames)
    }
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  } finally {
    for (const it of items) if (it) release(it)
  }
  onProgress(1)
  const buffer = (output.target as InstanceType<typeof BufferTarget>).buffer
  if (!buffer) throw new Error('The video came out empty.')
  return new Blob([buffer], { type: 'video/mp4' })
}
