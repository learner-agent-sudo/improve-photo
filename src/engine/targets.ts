/**
 * Where the photo is going, named by the place rather than by the ratio.
 *
 * "4:5 · 1080 × 1350" tells you nothing about whether it suits the post you are
 * about to make; "Instagram post" does. The numbers stay, as the second line.
 *
 * Sizes are each platform's own current recommendation; sources are listed in
 * docs/ARCHITECTURE.md. They are deliberately not "as large as possible":
 * every one of these services re-encodes on upload, and handing them a file far
 * larger than they display just means their encoder, not ours, decides how the
 * picture ends up looking.
 */
import type { AspectKey } from './types'

export interface Target {
  id: string
  /** The heading it appears under in the menu. */
  group: string
  /** What it is for, in the user's language. */
  name: string
  /** Shape and pixel size. */
  note: string
  aspect: AspectKey
  /** 0 keeps the cropped source resolution. */
  longEdge: number
  /** One line on when to reach for it. */
  hint: string
}

export const TARGETS: Target[] = [
  {
    id: 'original',
    group: 'Keep as shot',
    name: 'Original framing',
    note: 'same shape, full size',
    aspect: 'original',
    longEdge: 0,
    hint: 'No cropping and no downscaling — the whole photo at full resolution.',
  },

  {
    id: 'xhs',
    group: 'Xiaohongshu / RED',
    name: 'Xiaohongshu post',
    note: '3:4 · 1080 × 1440',
    aspect: '3:4',
    longEdge: 1440,
    hint: 'The tall shape the feed favours. Fills the most screen.',
  },

  {
    id: 'ig-post',
    group: 'Instagram',
    name: 'Instagram post',
    note: '4:5 · 1080 × 1350',
    aspect: '4:5',
    longEdge: 1350,
    hint: 'The tallest a feed post is allowed to be, and it fits the profile grid.',
  },
  {
    id: 'ig-square',
    group: 'Instagram',
    name: 'Instagram square',
    note: '1:1 · 1080 × 1080',
    aspect: '1:1',
    longEdge: 1080,
    hint: 'Safe in a carousel, where mixed shapes get cropped to match.',
  },
  {
    id: 'ig-reel',
    group: 'Instagram',
    name: 'Reel or Story cover',
    note: '9:16 · 1080 × 1920',
    aspect: '9:16',
    longEdge: 1920,
    hint: 'Full screen. Keep anything important away from the top and bottom fifth, where the interface sits.',
  },

  {
    id: 'fb-post',
    group: 'Facebook',
    name: 'Facebook post',
    note: '4:5 · 1080 × 1350',
    aspect: '4:5',
    longEdge: 1350,
    hint: 'The portrait shape that takes the most feed space.',
  },
  {
    id: 'fb-square',
    group: 'Facebook',
    name: 'Facebook square',
    note: '1:1 · 1080 × 1080',
    aspect: '1:1',
    longEdge: 1080,
    hint: 'Reliable across the feed on both phone and desktop.',
  },
  {
    id: 'fb-link',
    group: 'Facebook',
    name: 'Shared link preview',
    note: '1.91:1 · 1200 × 630',
    aspect: '1.91:1',
    longEdge: 1200,
    hint: 'The wide banner shown when a link to your site is posted.',
  },

  {
    id: 'tiktok',
    group: 'TikTok',
    name: 'TikTok cover',
    note: '9:16 · 1080 × 1920',
    aspect: '9:16',
    longEdge: 1920,
    hint: 'Full screen, same as a Reel.',
  },

  {
    id: 'pinterest',
    group: 'Pinterest',
    name: 'Pinterest pin',
    note: '2:3 · 1000 × 1500',
    aspect: '2:3',
    longEdge: 1500,
    hint: 'Pinterest says other shapes may be shown less.',
  },

  {
    id: 'yt-thumb',
    group: 'YouTube',
    name: 'Video thumbnail',
    note: '16:9 · 1280 × 720',
    aspect: '16:9',
    longEdge: 1280,
    hint: 'The minimum YouTube accepts, and it must stay under 2 MB.',
  },

  {
    id: 'hero',
    group: 'Your own website',
    name: 'Wide banner',
    note: '16:9 · 1920 × 1080',
    aspect: '16:9',
    longEdge: 1920,
    hint: 'A full-width header image.',
  },
  {
    id: 'web',
    group: 'Your own website',
    name: 'Page image',
    note: 'original shape · 2048 px',
    aspect: 'original',
    longEdge: 2048,
    hint: 'Keeps the shape, small enough to load quickly.',
  },
]

export const TARGET_BY_ID = new Map(TARGETS.map((t) => [t.id, t]))

/** The menu's headings, in the order they were declared. */
export const TARGET_GROUPS: string[] = [...new Set(TARGETS.map((t) => t.group))]
