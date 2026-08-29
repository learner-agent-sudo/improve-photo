/**
 * Stage 2: composing several photos into one.
 *
 * This module is data and geometry only. It reuses stage 1 wholesale - a
 * collage tile is the same photo, with the same colour edit and the same
 * perspective correction, simply cropped to the shape of its cell and rendered
 * at that cell's pixel size. Nothing in the WebGL pipeline needed to change.
 */
import { centredCrop, framedSize } from './geometry'
import { ASPECT_RATIOS, type AspectKey, type Edit } from './types'

/** A cell of the layout, normalised to the canvas: x, y, w, h in 0..1. */
export interface Cell {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  id: string
  name: string
  cells: Cell[]
}

/** One photo placed in one cell, framed within it. */
export interface Slot {
  photoId: string | null
  /** 1 fills the cell; above 1 crops in further. */
  zoom: number
  /** -1..1 of the slack left over after zooming. */
  offsetX: number
  offsetY: number
}

export const EMPTY_SLOT: Slot = { photoId: null, zoom: 1, offsetX: 0, offsetY: 0 }

export type TextFont =
  | 'fraunces'
  | 'playfair'
  | 'dmserif'
  | 'plex'
  | 'archivo'
  | 'anton'
  | 'bebas'
  | 'caveat'
  | 'mono'

export type TextStyle = 'plain' | 'outline' | 'plate'

export interface FontSpec {
  key: TextFont
  label: string
  stack: string
  /** Null when the family ships a single weight, so the panel can say so. */
  weights: [number, number] | null
  hasItalic: boolean
  /** Families that only ever read as capitals. */
  capsOnly?: boolean
}

/**
 * A deliberately small, contrasting set rather than a font menu.
 *
 * Each one does a job the others cannot: an editorial serif, a high-contrast
 * fashion serif, a heavy poster face, a condensed one for stacked headlines, a
 * handwritten note, and clean workhorses. Twenty near-identical sans faces
 * would be a longer list and a worse choice.
 */
export const FONTS: FontSpec[] = [
  { key: 'fraunces', label: 'Fraunces', stack: "'Fraunces', Georgia, serif", weights: [300, 900], hasItalic: true },
  { key: 'playfair', label: 'Playfair', stack: "'Playfair Display', Georgia, serif", weights: [400, 900], hasItalic: true },
  { key: 'dmserif', label: 'DM Serif', stack: "'DM Serif Display', Georgia, serif", weights: null, hasItalic: true },
  { key: 'plex', label: 'Plex Sans', stack: "'IBM Plex Sans', system-ui, sans-serif", weights: [300, 700], hasItalic: true },
  { key: 'archivo', label: 'Archivo', stack: "'Archivo', system-ui, sans-serif", weights: [400, 900], hasItalic: true },
  { key: 'anton', label: 'Anton', stack: "'Anton', Impact, sans-serif", weights: null, hasItalic: false },
  { key: 'bebas', label: 'Bebas', stack: "'Bebas Neue', Impact, sans-serif", weights: null, hasItalic: false, capsOnly: true },
  { key: 'caveat', label: 'Caveat', stack: "'Caveat', cursive", weights: [400, 700], hasItalic: false },
  { key: 'mono', label: 'Plex Mono', stack: "'IBM Plex Mono', ui-monospace, monospace", weights: [400, 600], hasItalic: true },
]

export const FONT_BY_KEY = new Map(FONTS.map((f) => [f.key, f]))

export interface TextLayer {
  id: string
  text: string
  /** Centre of the text block, normalised to the canvas. */
  x: number
  y: number
  /** Cap height as a fraction of the canvas short edge. */
  size: number
  color: string
  font: TextFont
  weight: number
  align: CanvasTextAlign
  /** Degrees. */
  rotation: number
  /** A soft drop shadow, so light text stays readable over a bright photo. */
  shadow: boolean
  italic: boolean
  uppercase: boolean
  /** Letter spacing, in em. Negative tightens. */
  tracking: number
  /** Solid, hollow, or sitting on a coloured plate. */
  style: TextStyle
  /** The plate's colour, when style is 'plate'. */
  plateColor: string
}

export interface CollageDoc {
  layoutId: string
  /** Resolved cells, so a generated layout stays stable while you work. */
  cells: Cell[]
  slots: Slot[]
  aspect: AspectKey
  /** Gap between cells, as a fraction of the canvas short edge. */
  gutter: number
  /** Margin around the whole collage. */
  padding: number
  /** Corner rounding on each tile. */
  radius: number
  background: string
  texts: TextLayer[]
}

/** Back-compat shape for callers that just want a stack by key. */
export const FONT_STACKS = Object.fromEntries(FONTS.map((f) => [f.key, f.stack])) as Record<
  TextFont,
  string
>

/** The CSS font shorthand for a layer, at a given pixel size. */
export function fontShorthand(t: TextLayer, px: number): string {
  const spec = FONT_BY_KEY.get(t.font) ?? FONTS[0]
  const italic = t.italic && spec.hasItalic ? 'italic ' : ''
  const weight = spec.weights
    ? Math.min(spec.weights[1], Math.max(spec.weights[0], Math.round(t.weight)))
    : 400
  return `${italic}${weight} ${px}px ${spec.stack}`
}

/** What actually gets drawn, after the uppercase switch. */
export const displayText = (t: TextLayer): string =>
  t.uppercase || FONT_BY_KEY.get(t.font)?.capsOnly ? t.text.toUpperCase() : t.text

const grid = (cols: number, rows: number): Cell[] => {
  const cells: Cell[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows })
    }
  }
  return cells
}

/** A row of `n` equal cells occupying a horizontal band. */
const band = (y: number, h: number, n: number): Cell[] =>
  Array.from({ length: n }, (_, i) => ({ x: i / n, y, w: 1 / n, h }))

/** A column of `n` equal cells occupying a vertical strip. */
const strip = (x: number, w: number, n: number): Cell[] =>
  Array.from({ length: n }, (_, i) => ({ x, y: i / n, w, h: 1 / n }))

/**
 * Hand-authored arrangements.
 *
 * A good grid for nine dishes is a design decision, not something a generic
 * algorithm arrives at, so the common counts are drawn by hand and the
 * generator below only covers whatever is left over.
 */
export const LAYOUTS: Layout[] = [
  { id: '1', name: 'Single', cells: [{ x: 0, y: 0, w: 1, h: 1 }] },

  { id: '2-cols', name: 'Side by side', cells: grid(2, 1) },
  { id: '2-rows', name: 'Stacked', cells: grid(1, 2) },

  { id: '3-hero-left', name: 'One big, two', cells: [{ x: 0, y: 0, w: 0.62, h: 1 }, ...strip(0.62, 0.38, 2)] },
  { id: '3-hero-top', name: 'Wide top, two', cells: [{ x: 0, y: 0, w: 1, h: 0.58 }, ...band(0.58, 0.42, 2)] },
  { id: '3-cols', name: 'Three columns', cells: grid(3, 1) },
  { id: '3-rows', name: 'Three rows', cells: grid(1, 3) },

  { id: '4-grid', name: 'Two by two', cells: grid(2, 2) },
  { id: '4-hero-left', name: 'One big, three', cells: [{ x: 0, y: 0, w: 0.6, h: 1 }, ...strip(0.6, 0.4, 3)] },
  { id: '4-hero-top', name: 'Wide top, three', cells: [{ x: 0, y: 0, w: 1, h: 0.52 }, ...band(0.52, 0.48, 3)] },
  { id: '4-cols', name: 'Four columns', cells: grid(4, 1) },

  { id: '5-hero-top', name: 'Wide top, four', cells: [{ x: 0, y: 0, w: 1, h: 0.5 }, ...band(0.5, 0.5, 4)] },
  { id: '5-hero-left', name: 'One big, four', cells: [{ x: 0, y: 0, w: 0.58, h: 1 }, ...strip(0.58, 0.42, 4)] },
  {
    id: '5-2-3',
    name: 'Two over three',
    cells: [...band(0, 0.5, 2), ...band(0.5, 0.5, 3)],
  },

  { id: '6-3x2', name: 'Three by two', cells: grid(3, 2) },
  { id: '6-2x3', name: 'Two by three', cells: grid(2, 3) },
  {
    id: '6-2-4',
    name: 'Two over four',
    cells: [...band(0, 0.55, 2), ...band(0.55, 0.45, 4)],
  },

  {
    id: '7-hero-6',
    name: 'Wide top, six',
    cells: [
      { x: 0, y: 0, w: 1, h: 0.4 },
      ...grid(3, 2).map((c) => ({ ...c, y: 0.4 + c.y * 0.6, h: c.h * 0.6 })),
    ],
  },

  { id: '8-4x2', name: 'Four by two', cells: grid(4, 2) },
  { id: '8-2x4', name: 'Two by four', cells: grid(2, 4) },

  { id: '9-3x3', name: 'Three by three', cells: grid(3, 3) },
  {
    id: '9-1-4-4',
    name: 'Wide top, eight',
    cells: [{ x: 0, y: 0, w: 1, h: 0.36 }, ...band(0.36, 0.32, 4), ...band(0.68, 0.32, 4)],
  },

  { id: '10-5x2', name: 'Five by two', cells: grid(5, 2) },
  { id: '12-4x3', name: 'Four by three', cells: grid(4, 3) },
  { id: '12-3x4', name: 'Three by four', cells: grid(3, 4) },
]

export const LAYOUT_BY_ID = new Map(LAYOUTS.map((l) => [l.id, l]))

/**
 * A generated arrangement for counts the library does not cover.
 *
 * Recursive binary splitting, cutting whichever way the current rectangle is
 * longest, which keeps the cells close to square whatever the canvas shape.
 */
export function autoLayout(count: number, canvasAspect: number): Cell[] {
  const split = (rect: Cell, n: number): Cell[] => {
    if (n <= 1) return [rect]
    const a = Math.ceil(n / 2)
    const f = a / n
    const wide = (rect.w * canvasAspect) / rect.h >= 1
    if (wide) {
      return [
        ...split({ ...rect, w: rect.w * f }, a),
        ...split({ x: rect.x + rect.w * f, y: rect.y, w: rect.w * (1 - f), h: rect.h }, n - a),
      ]
    }
    return [
      ...split({ ...rect, h: rect.h * f }, a),
      ...split({ x: rect.x, y: rect.y + rect.h * f, w: rect.w, h: rect.h * (1 - f) }, n - a),
    ]
  }
  return split({ x: 0, y: 0, w: 1, h: 1 }, Math.max(1, count))
}

export const aspectValue = (a: AspectKey, fallback = 3 / 4): number =>
  a === 'original' || a === 'free' ? fallback : ASPECT_RATIOS[a]

/**
 * The canvas shapes offered for a collage, named by where people post them.
 *
 * `best` is the long edge each platform publishes as its upload size, so
 * picking it hands the platform exactly what it asks for and leaves it nothing
 * to resample. Everything else in the size menu is derived from it.
 */
export interface ShapeUse {
  key: AspectKey
  /** The ratio itself, for people who think in ratios. */
  label: string
  /** Where it goes - short enough for a button. */
  use: string
  /** Long edge in pixels the platform asks for. */
  best: number
  /** Spelled out, for the export menu. */
  bestFor: string
}

export const COLLAGE_SHAPES: ShapeUse[] = [
  { key: '3:4', label: '3:4', use: 'Xiaohongshu', best: 1440, bestFor: 'Xiaohongshu / RED' },
  { key: '4:5', label: '4:5', use: 'IG / FB post', best: 1350, bestFor: 'an Instagram or Facebook post' },
  { key: '1:1', label: '1:1', use: 'Square post', best: 1080, bestFor: 'a square post anywhere' },
  { key: '9:16', label: '9:16', use: 'Reel / Story', best: 1920, bestFor: 'Reels, Stories and TikTok' },
  { key: '4:3', label: '4:3', use: 'Classic', best: 1440, bestFor: 'a classic camera shape' },
  { key: '16:9', label: '16:9', use: 'YouTube / web', best: 1920, bestFor: 'YouTube and website banners' },
]

export const SHAPE_BY_KEY = new Map(COLLAGE_SHAPES.map((s) => [s.key, s]))

/** The long edge a shape is happiest at, falling back for shapes not listed. */
export const bestLongEdge = (a: AspectKey): number => SHAPE_BY_KEY.get(a)?.best ?? 1440

/** Cells for a layout id, resolving the generated case. */
export function resolveCells(layoutId: string, count: number, aspect: AspectKey): Cell[] {
  if (layoutId === 'auto') return autoLayout(count, aspectValue(aspect))
  return LAYOUT_BY_ID.get(layoutId)?.cells ?? autoLayout(count, aspectValue(aspect))
}

/** Layouts worth offering for this many photos: exact fits first. */
export function layoutsFor(count: number): Layout[] {
  return [...LAYOUTS]
    .filter((l) => l.cells.length <= Math.max(count, 1) + 3)
    .sort((a, b) => Math.abs(a.cells.length - count) - Math.abs(b.cells.length - count))
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * The edit to render for one tile.
 *
 * The photo keeps everything the user did to it in stage 1 - exposure, colour,
 * perspective, rotation - and only the crop is replaced, with the largest
 * rectangle of the cell's shape, then narrowed by the slot's own zoom and pan.
 * That is why a photo looks identical alone and inside a grid.
 */
export function slotEdit(
  edit: Edit,
  previewW: number,
  previewH: number,
  cellAspect: number,
  slot: Slot,
): Edit {
  const [fw, fh] = framedSize(previewW, previewH, edit.geometry)
  const base = centredCrop(cellAspect, fw, fh)
  const zoom = Math.max(1, slot.zoom)
  const w = base.w / zoom
  const h = base.h / zoom
  const slackX = Math.max(0, 1 - w)
  const slackY = Math.max(0, 1 - h)
  const cx = 0.5 + (clamp(slot.offsetX, -1, 1) * slackX) / 2
  const cy = 0.5 + (clamp(slot.offsetY, -1, 1) * slackY) / 2
  return {
    ...edit,
    geometry: {
      ...edit.geometry,
      aspect: 'free',
      crop: {
        x: clamp(cx - w / 2, 0, 1 - w),
        y: clamp(cy - h / 2, 0, 1 - h),
        w,
        h,
      },
    },
  }
}

export function createCollage(count: number): CollageDoc {
  const preferred = LAYOUTS.find((l) => l.cells.length === count)
  const layoutId = preferred?.id ?? 'auto'
  const aspect: AspectKey = '3:4'
  const cells = resolveCells(layoutId, count, aspect)
  return {
    layoutId,
    cells,
    slots: cells.map(() => ({ ...EMPTY_SLOT })),
    aspect,
    gutter: 0.012,
    padding: 0.012,
    radius: 0.014,
    background: '#f4efe6',
    texts: [],
  }
}
