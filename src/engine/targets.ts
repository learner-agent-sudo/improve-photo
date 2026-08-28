/**
 * Where the photo is going, expressed as a crop shape plus a pixel size.
 *
 * Sizes are the platforms' own current recommendations; sources are listed in
 * docs/ARCHITECTURE.md. They are deliberately not "as big as possible":
 * every one of these platforms re-encodes on upload, and handing them a file
 * far larger than they display just means their encoder, not ours, decides how
 * the picture ends up looking.
 */
import type { AspectKey } from './types'

export interface Target {
  id: string
  name: string
  note: string
  aspect: AspectKey
  /** 0 keeps the cropped source resolution. */
  longEdge: number
}

export const TARGETS: Target[] = [
  {
    id: 'original',
    name: 'Original framing',
    note: 'same shape, full size',
    aspect: 'original',
    longEdge: 0,
  },
  {
    id: 'xhs',
    name: 'Xiaohongshu 3:4',
    note: '1080 × 1440',
    aspect: '3:4',
    longEdge: 1440,
  },
  {
    id: 'ig-portrait',
    name: 'Instagram feed 4:5',
    note: '1080 × 1350',
    aspect: '4:5',
    longEdge: 1350,
  },
  {
    id: 'square',
    name: 'Square 1:1',
    note: '1080 × 1080',
    aspect: '1:1',
    longEdge: 1080,
  },
  {
    id: 'story',
    name: 'Story / Reels 9:16',
    note: '1080 × 1920',
    aspect: '9:16',
    longEdge: 1920,
  },
  {
    id: 'hero',
    name: 'Website hero 16:9',
    note: '1920 × 1080',
    aspect: '16:9',
    longEdge: 1920,
  },
  {
    id: 'web',
    name: 'Web / app asset',
    note: '2048 px long edge',
    aspect: 'original',
    longEdge: 2048,
  },
]

export const TARGET_BY_ID = new Map(TARGETS.map((t) => [t.id, t]))
