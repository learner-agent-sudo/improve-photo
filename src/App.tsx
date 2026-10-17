import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { AdjustPanel } from './components/AdjustPanel'
import { ExportPanel, type ExportConfig } from './components/ExportPanel'
import { Filmstrip } from './components/Filmstrip'
import { Hero } from './components/Hero'
import { Stage, type Tool } from './components/Stage'
import { Toasts, type Toast } from './components/Toasts'
import { AiSettingsDialog } from './components/AiSettingsDialog'
import { loadAiSettings, saveAiSettings } from './ai/settings'
import { applyTheme, loadTheme, NEXT_THEME, THEME_LABEL, type Theme } from './state/theme'
import type { AiSettings, ProposedChange } from './ai/types'
import { CollageStage } from './components/CollageStage'
import { CollagePanel } from './components/CollagePanel'
import { CollageTray } from './components/CollageTray'
import { CollageExportPanel, collageSize, type CollageExportConfig } from './components/CollageExportPanel'
import {
  aspectValue,
  autoLayout,
  createCollage,
  resolveCells,
  EMPTY_SLOT,
  type CollageDoc,
  type TextLayer,
} from './engine/collage'
import { exportCollage, type CollageSource } from './engine/collageRender'
import { Exporter, saveBlob } from './engine/export'
import { aspectRatio, centredCrop, framedSize, outputToFrame, resolveCrop } from './engine/geometry'
import { apply } from './engine/matrix'
import { applyPreset, PRESETS } from './engine/presets'
import { TARGETS } from './engine/targets'
import {
  MAX_AREAS,
  NEUTRAL,
  NEUTRAL_GEOMETRY,
  NEUTRAL_LEVELS,
  NEUTRAL_MIX,
  type Adjustments,
  type AreaAdjust,
  type BandShift,
  type Edit,
  type Geometry,
} from './engine/types'
import { createPhoto, decodeForExport, disposePhoto, type Photo } from './state/photos'
import { loadLooks, makeLook, saveLooks, type Look } from './state/looks'

let toastId = 0

/** Consecutive changes with the same key inside this window collapse into one undo step. */
const COALESCE_MS = 700
const HISTORY_LIMIT = 80

interface HistoryEntry {
  past: Edit[]
  future: Edit[]
  lastKey: string
  lastAt: number
}

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('adjust')
  const [selectedArea, setSelectedArea] = useState<string | null>(null)
  const [looks, setLooks] = useState<Look[]>(() => loadLooks())
  const [aiSettings, setAiSettings] = useState<AiSettings>(() => loadAiSettings())
  const [aiDialog, setAiDialog] = useState(false)

  const [theme, setTheme] = useState<Theme>(() => loadTheme())
  const [mode, setMode] = useState<'enhance' | 'collage'>('enhance')
  // On a phone the controls start out of the way, so the picture gets the
  // screen. The class is inert above the phone breakpoint.
  const [sheetOpen, setSheetOpen] = useState(false)
  const [collage, setCollage] = useState<CollageDoc | null>(null)
  const [selectedCell, setSelectedCell] = useState<number | null>(0)
  const [selectedText, setSelectedText] = useState<string | null>(null)
  const [collageExport, setCollageExport] = useState<CollageExportConfig>({
    longEdge: 1440,
    format: 'jpeg',
    quality: 0.92,
  })
  const collageRef = useRef<CollageDoc | null>(collage)
  collageRef.current = collage
  const collageHist = useRef<HistoryEntry & { docs: CollageDoc[] }>({
    past: [],
    future: [],
    lastKey: '',
    lastAt: 0,
    docs: [],
  })
  const [toasts, setToasts] = useState<Toast[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [config, setConfig] = useState<ExportConfig>({
    targetId: 'original',
    format: 'jpeg',
    quality: 0.9,
  })

  const photosRef = useRef(photos)
  photosRef.current = photos
  const history = useRef(new Map<string, HistoryEntry>())

  const selected = useMemo(
    () => photos.find((p) => p.id === selectedId) ?? null,
    [photos, selectedId],
  )

  const notify = useCallback((kind: Toast['kind'], message: string) => {
    const id = ++toastId
    setToasts((t) => [...t, { id, kind, message }])
    if (kind !== 'error') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000)
  }, [])

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const reportError = useCallback((message: string) => notify('error', message), [notify])

  // --- edit history ---------------------------------------------------------
  const entryFor = (id: string): HistoryEntry => {
    let e = history.current.get(id)
    if (!e) {
      e = { past: [], future: [], lastKey: '', lastAt: 0 }
      history.current.set(id, e)
    }
    return e
  }

  /**
   * Applies an edit and records the previous one.
   *
   * Dragging a slider fires dozens of changes a second; without coalescing,
   * one undo would step back a single pixel of slider travel. Consecutive
   * changes to the same control collapse into one step.
   */
  const patchEdit = useCallback(
    (key: string, fn: (e: Edit) => Edit) => {
      const list = photosRef.current
      const idx = list.findIndex((p) => p.id === selectedId)
      if (idx < 0) return
      const cur = list[idx]
      const next = fn(cur.edit)
      if (next === cur.edit) return

      const h = entryFor(cur.id)
      const now = Date.now()
      if (!(h.lastKey === key && now - h.lastAt < COALESCE_MS && h.past.length > 0)) {
        h.past.push(cur.edit)
        if (h.past.length > HISTORY_LIMIT) h.past.shift()
      }
      h.lastKey = key
      h.lastAt = now
      h.future = []

      const nextList = list.slice()
      nextList[idx] = { ...cur, edit: next }
      // Keep the ref current so a fast drag does not read stale state between
      // renders and drop intermediate moves.
      photosRef.current = nextList
      setPhotos(nextList)
    },
    [selectedId],
  )

  const step = useCallback(
    (dir: 'undo' | 'redo') => {
      const list = photosRef.current
      const idx = list.findIndex((p) => p.id === selectedId)
      if (idx < 0) return
      const cur = list[idx]
      const h = entryFor(cur.id)
      const from = dir === 'undo' ? h.past : h.future
      const to = dir === 'undo' ? h.future : h.past
      if (from.length === 0) return
      to.push(cur.edit)
      const restored = from.pop()!
      h.lastKey = ''
      const nextList = list.slice()
      nextList[idx] = { ...cur, edit: restored }
      photosRef.current = nextList
      setPhotos(nextList)
    },
    [selectedId],
  )

  const stepCollage = useCallback((dir: 'undo' | 'redo') => {
    const cur = collageRef.current
    const h = collageHist.current
    if (!cur) return
    const from = dir === 'undo' ? h.docs : (h.future as unknown as CollageDoc[])
    const to = dir === 'undo' ? (h.future as unknown as CollageDoc[]) : h.docs
    if (from.length === 0) return
    to.push(cur)
    const restored = from.pop()!
    h.lastKey = ''
    collageRef.current = restored
    setCollage(restored)
  }, [])

  // Undo can take away the area that was selected; never point at a ghost.
  const liveArea =
    selected && (selected.edit.areas ?? []).some((a) => a.id === selectedArea) ? selectedArea : null

  const hist = selectedId ? history.current.get(selectedId) : undefined
  const canUndo = (hist?.past.length ?? 0) > 0
  const canRedo = (hist?.future.length ?? 0) > 0

  // --- loading --------------------------------------------------------------
  const addFiles = useCallback(
    async (files: File[]) => {
      setBusy(`Reading ${files.length} photo${files.length > 1 ? 's' : ''}…`)
      const loaded: Photo[] = []
      for (const file of files) {
        try {
          loaded.push(await createPhoto(file))
        } catch (err) {
          notify('error', (err as Error).message)
        }
      }
      if (loaded.length) {
        const target = TARGETS.find((t) => t.id === config.targetId)
        if (target && target.aspect !== 'original') {
          for (const p of loaded) {
            const [fw, fh] = framedSize(p.preview.width, p.preview.height, p.edit.geometry)
            p.edit.geometry.aspect = target.aspect
            p.edit.geometry.crop = centredCrop(aspectRatio(target.aspect, fw, fh), fw, fh)
          }
        }
        setPhotos((prev) => [...prev, ...loaded])
        setSelectedId((cur) => cur ?? loaded[0].id)
      }
      setBusy(null)
    },
    [config.targetId, notify],
  )

  const removePhoto = useCallback((id: string) => {
    history.current.delete(id)
    setPhotos((prev) => {
      const gone = prev.find((p) => p.id === id)
      if (gone) disposePhoto(gone)
      const next = prev.filter((p) => p.id !== id)
      setSelectedId((cur) => (cur === id ? (next[0]?.id ?? null) : cur))
      return next
    })
  }, [])

  // --- editing --------------------------------------------------------------
  const onAdjust = useCallback(
    (patch: Partial<Adjustments>) =>
      patchEdit(`adj:${Object.keys(patch).join()}`, (e) => ({
        ...e,
        adjustments: { ...e.adjustments, ...patch },
      })),
    [patchEdit],
  )

  const onGeometry = useCallback(
    (patch: Partial<Geometry>) =>
      patchEdit(`geo:${Object.keys(patch).join()}`, (e) => ({
        ...e,
        geometry: { ...e.geometry, ...patch },
      })),
    [patchEdit],
  )

  const onResetFraming = useCallback(
    () => patchEdit('geo:reset', (e) => ({ ...e, geometry: { ...NEUTRAL_GEOMETRY } })),
    [patchEdit],
  )

  // Manual slider moves clear the preset highlight, because the photo is no
  // longer what that preset produces.
  const clearPreset = useCallback(
    () =>
      setPhotos((prev) =>
        prev.map((p) => (p.id === selectedId && p.presetId !== 'custom' ? { ...p, presetId: 'custom' } : p)),
      ),
    [selectedId],
  )

  const markCustom = useCallback(
    (patch: Partial<Adjustments>) => {
      onAdjust(patch)
      clearPreset()
    },
    [onAdjust, clearPreset],
  )

  const onMix = useCallback(
    (band: number, patch: Partial<BandShift>) => {
      patchEdit(`mix:${band}:${Object.keys(patch).join()}`, (e) => ({
        ...e,
        mix: (e.mix ?? NEUTRAL_MIX).map((b, i) => (i === band ? { ...b, ...patch } : b)),
      }))
      clearPreset()
    },
    [patchEdit, clearPreset],
  )

  const onResetMix = useCallback(() => {
    patchEdit('mix:reset', (e) => ({ ...e, mix: NEUTRAL_MIX }))
    clearPreset()
  }, [patchEdit, clearPreset])

  // --- local adjustments ----------------------------------------------------
  // Switching photos puts the selection down; each photo has its own areas.
  useEffect(() => setSelectedArea(null), [selectedId])

  /**
   * A new area lands in the middle of what is on screen, sized to the crop
   * rather than to the whole photo - on a tight crop, a circle a quarter of the
   * photo wide would swallow the frame. It starts with a visible amount of
   * effect, so you can see at once what you are moving around.
   */
  const onAddArea = useCallback(
    (kind: AreaAdjust['kind']) => {
      const p = photosRef.current.find((x) => x.id === selectedId)
      if (!p || (p.edit.areas ?? []).length >= MAX_AREAS) return
      const pw = p.preview.width
      const ph = p.preview.height
      const fr = outputToFrame(pw, ph, p.edit.geometry, 'edit')
      if (!fr) return
      const c = resolveCrop(pw, ph, p.edit.geometry)
      const visible = Math.max(c.cw, c.ch) / Math.max(fr.rw, fr.rh)
      const at = (u: number, v: number) => apply(fr.m, u, v)
      const id = `a${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
      const mid = at(0.5, 0.5)
      const top = at(0.5, 0)
      const fade = at(0.5, 0.45)
      const area: AreaAdjust =
        kind === 'radial'
          ? { id, kind, x: mid.x, y: mid.y, rx: 0.24 * visible, ry: 0.24 * visible,
              x2: mid.x, y2: mid.y, feather: 0.6, invert: false, exposure: 0.4, warmth: 0 }
          : { id, kind, x: top.x, y: top.y, rx: 0.24, ry: 0.24,
              x2: fade.x, y2: fade.y, feather: 0.6, invert: false, exposure: -0.4, warmth: 0 }
      patchEdit(`area:add:${id}`, (e) => ({ ...e, areas: [...(e.areas ?? []), area] }))
      setSelectedArea(id)
      setTool('areas')
      // On a phone the open sheet covers the middle of the photo, which is
      // exactly where the new area lands. Put the sheet away so it can be
      // placed; the Areas tab brings the sliders back. (Inert on a desktop.)
      setSheetOpen(false)
    },
    [patchEdit, selectedId],
  )

  const onArea = useCallback(
    (id: string, patch: Partial<AreaAdjust>, key: string) =>
      patchEdit(`area:${id}:${key}`, (e) => ({
        ...e,
        areas: (e.areas ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a)),
      })),
    [patchEdit],
  )

  const onRemoveArea = useCallback(
    (id: string) => {
      patchEdit(`area:del:${id}`, (e) => ({
        ...e,
        areas: (e.areas ?? []).filter((a) => a.id !== id),
      }))
      setSelectedArea((cur) => (cur === id ? null : cur))
    },
    [patchEdit],
  )

  const choosePreset = useCallback(
    (presetId: string) => {
      const preset = PRESETS.find((x) => x.id === presetId)
      if (!preset || !selectedId) return
      // Presets always build on this photo's own Auto result, so switching
      // between them never compounds.
      patchEdit(`preset:${presetId}`, (e) => {
        const p = photosRef.current.find((x) => x.id === selectedId)!
        return { ...e, adjustments: applyPreset(p.auto.adjustments, preset), levels: p.auto.levels }
      })
      setPhotos((prev) => prev.map((p) => (p.id === selectedId ? { ...p, presetId } : p)))
    },
    [patchEdit, selectedId],
  )

  // --- saved looks ------------------------------------------------------------
  /** Like a preset: this photo's own Auto, plus the look's offsets and mix. */
  const applyLook = useCallback(
    (lookId: string) => {
      const look = looks.find((l) => l.id === lookId)
      if (!look || !selectedId) return
      patchEdit(`look:${lookId}`, (e) => {
        const p = photosRef.current.find((x) => x.id === selectedId)!
        return {
          ...e,
          adjustments: applyPreset(p.auto.adjustments, { id: look.id, name: look.name, hint: '', delta: look.delta }),
          levels: p.auto.levels,
          mix: look.mix,
        }
      })
      setPhotos((prev) => prev.map((p) => (p.id === selectedId ? { ...p, presetId: `look:${lookId}` } : p)))
    },
    [looks, patchEdit, selectedId],
  )

  const saveLook = useCallback(
    (name: string) => {
      const p = photosRef.current.find((x) => x.id === selectedId)
      if (!p) return
      const look = makeLook(name, p.edit, p.auto)
      const next = [...looks, look]
      setLooks(next)
      setPhotos((prev) => prev.map((x) => (x.id === p.id ? { ...x, presetId: `look:${look.id}` } : x)))
      if (saveLooks(next)) notify('ok', `Saved "${look.name}".`)
      else notify('info', `Saved "${look.name}" for this visit. This browser is not letting the app keep it after you close the page.`)
    },
    [looks, selectedId, notify],
  )

  const deleteLook = useCallback(
    (lookId: string) => {
      const next = looks.filter((l) => l.id !== lookId)
      setLooks(next)
      saveLooks(next)
    },
    [looks],
  )

  // "Original" means the file as it came off the phone, so the colour mix and
  // the areas go too. Framing stays: it is a different kind of decision.
  const resetToOriginal = useCallback(() => {
    patchEdit('preset:none', (e) => ({
      ...e,
      adjustments: { ...NEUTRAL },
      levels: { ...NEUTRAL_LEVELS },
      mix: NEUTRAL_MIX,
      areas: [],
    }))
    setPhotos((prev) => prev.map((p) => (p.id === selectedId ? { ...p, presetId: 'none' } : p)))
  }, [patchEdit, selectedId])

  /**
   * Copies the sliders and the colour mix to every photo but leaves each one's
   * own measured black and white points alone: a consistent look across the
   * set, without forcing one photo's levels onto a differently-exposed shot.
   * Framing and areas stay personal to each photo, since what needs to stay in
   * frame - and where the dish sits - differs shot to shot.
   */
  const applyToAll = useCallback(() => {
    if (!selected) return
    const adjustments = { ...selected.edit.adjustments }
    const mix = selected.edit.mix ?? NEUTRAL_MIX
    const presetId = selected.presetId
    const next = photosRef.current.map((p) => {
      if (p.id === selected.id) return p
      entryFor(p.id).past.push(p.edit)
      return { ...p, presetId, edit: { ...p.edit, adjustments, mix } }
    })
    photosRef.current = next
    setPhotos(next)
    notify('ok', `Applied to all ${next.length} photos.`)
  }, [selected, notify])

  // Changing the export target re-shapes every photo, because the export will
  // crop them all to that shape anyway.
  const updateConfig = useCallback((patch: Partial<ExportConfig>) => {
    setConfig((c) => ({ ...c, ...patch }))
    if (!patch.targetId) return
    const t = TARGETS.find((x) => x.id === patch.targetId)
    if (!t) return
    const next = photosRef.current.map((p) => {
      // A photo already in the target shape keeps the crop the user drew;
      // re-picking the same target should not throw their framing away.
      if (p.edit.geometry.aspect === t.aspect) return p
      const [fw, fh] = framedSize(p.preview.width, p.preview.height, p.edit.geometry)
      const ratio = aspectRatio(t.aspect, fw, fh)
      entryFor(p.id).past.push(p.edit)
      return {
        ...p,
        edit: {
          ...p.edit,
          geometry: { ...p.edit.geometry, aspect: t.aspect, crop: centredCrop(ratio, fw, fh) },
        },
      }
    })
    photosRef.current = next
    setPhotos(next)
  }, [])

  // --- exporting ------------------------------------------------------------
  const runExport = useCallback(
    async (list: Photo[], zipped: boolean) => {
      const target = TARGETS.find((t) => t.id === config.targetId) ?? TARGETS[0]
      const settings = { format: config.format, quality: config.quality, longEdge: target.longEdge }
      let exporter: Exporter | null = null
      try {
        exporter = new Exporter()
        const zip = zipped ? new JSZip() : null
        for (let i = 0; i < list.length; i++) {
          const photo = list[i]
          setBusy(`Rendering ${i + 1} of ${list.length}…`)
          const bitmap = await decodeForExport(photo, target.longEdge)
          try {
            const result = await exporter.run(bitmap, photo.edit, settings, photo.name, photo.seed)
            if (zip) zip.file(result.filename, result.blob)
            else saveBlob(result.blob, result.filename)
          } finally {
            bitmap.close()
          }
          await new Promise((r) => setTimeout(r, 0))
        }
        if (zip) {
          setBusy('Packing the zip…')
          const blob = await zip.generateAsync({ type: 'blob' })
          saveBlob(blob, `darkroom-${list.length}-photos.zip`)
        }
        notify('ok', `Exported ${list.length} photo${list.length > 1 ? 's' : ''}.`)
      } catch (err) {
        notify('error', `Export failed: ${(err as Error).message}`)
      } finally {
        exporter?.dispose()
        setBusy(null)
      }
    },
    [config, notify],
  )

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system' || typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-color-scheme: light)')
    const sync = () => applyTheme('system')
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [theme])

  // --- paste ----------------------------------------------------------------
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith('image/'),
      )
      if (files.length) {
        e.preventDefault()
        void addFiles(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  // --- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        const dir = e.shiftKey ? 'redo' : 'undo'
        if (mode === 'collage') stepCollage(dir)
        else step(dir)
        return
      }
      if (typing || e.metaKey || e.ctrlKey) return
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const list = photosRef.current
      if (list.length < 2) return
      e.preventDefault()
      const i = list.findIndex((p) => p.id === selectedId)
      const next = (i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length
      setSelectedId(list[next].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, step, stepCollage, mode])

  const updateAiSettings = useCallback((patch: Partial<AiSettings>) => {
    setAiSettings((prev) => {
      const next = { ...prev, ...patch }
      saveAiSettings(next)
      return next
    })
  }, [])

  /**
   * Applies an approved AI proposal as one undoable step, so a single Ctrl+Z
   * puts the photo back exactly as it was.
   */
  const applyAiProposal = useCallback(
    (changes: ProposedChange[], straighten?: number) => {
      patchEdit('ai:apply', (e) => {
        const adjustments = { ...e.adjustments }
        for (const c of changes) adjustments[c.key] = c.value
        return {
          ...e,
          adjustments,
          geometry: straighten === undefined ? e.geometry : { ...e.geometry, straighten },
        }
      })
      setPhotos((prev) => prev.map((p) => (p.id === selectedId ? { ...p, presetId: 'custom' } : p)))
      const bits = [
        changes.length ? `${changes.length} change${changes.length > 1 ? 's' : ''}` : '',
        straighten === undefined ? '' : 'straighten',
      ].filter(Boolean)
      notify('ok', `Applied ${bits.join(' and ')}.`)
    },
    [patchEdit, selectedId, notify],
  )

  // --- collage --------------------------------------------------------------
  const sources = useMemo(() => {
    const m = new Map<string, CollageSource>()
    for (const p of photos) {
      m.set(p.id, {
        id: p.id,
        preview: p.preview,
        edit: p.edit,
        seed: p.seed,
        nativeWidth: p.nativeWidth,
        nativeHeight: p.nativeHeight,
      })
    }
    return m
  }, [photos])

  /** Every collage edit goes through here, so undo covers the collage too. */
  const patchCollage = useCallback((patch: Partial<CollageDoc>, key = '') => {
    const prev = collageRef.current
    if (!prev) return
    const next = { ...prev, ...patch }
    const h = collageHist.current
    const now = Date.now()
    if (!(h.lastKey === key && now - h.lastAt < COALESCE_MS && h.docs.length > 0)) {
      h.docs.push(prev)
      if (h.docs.length > HISTORY_LIMIT) h.docs.shift()
    }
    h.lastKey = key
    h.lastAt = now
    h.future = []
    collageRef.current = next
    setCollage(next)
  }, [])

  const onCollageDoc = useCallback(
    (patch: Partial<CollageDoc>, key?: string) => {
      // A generated arrangement has to be recomputed when the canvas changes
      // shape, otherwise the cells keep the proportions of the old one.
      if (patch.aspect && collageRef.current?.layoutId === 'auto') {
        const cells = autoLayout(collageRef.current.cells.length, aspectValue(patch.aspect))
        const slots = cells.map((_, i) => collageRef.current!.slots[i] ?? { ...EMPTY_SLOT })
        patchCollage({ ...patch, cells, slots }, key)
        return
      }
      patchCollage(patch, key)
    },
    [patchCollage],
  )

  const chooseLayout = useCallback(
    (layoutId: string) => {
      const prev = collageRef.current
      if (!prev) return
      const cells = resolveCells(layoutId, Math.max(photosRef.current.length, 1), prev.aspect)
      // Carry the photos across in the order they were placed, so changing
      // arrangement rearranges rather than empties.
      const placed = prev.slots.filter((s) => s.photoId)
      const slots = cells.map((_, i) => (placed[i] ? { ...placed[i] } : { ...EMPTY_SLOT }))
      patchCollage({ layoutId, cells, slots }, 'layout')
      setSelectedCell(0)
    },
    [patchCollage],
  )

  const autoFill = useCallback(() => {
    const prev = collageRef.current
    if (!prev) return
    const list = photosRef.current
    patchCollage(
      {
        slots: prev.cells.map((_, i) =>
          list[i] ? { photoId: list[i].id, zoom: 1, offsetX: 0, offsetY: 0 } : { ...EMPTY_SLOT },
        ),
      },
      'fill',
    )
  }, [patchCollage])

  const shuffleCollage = useCallback(() => {
    const prev = collageRef.current
    if (!prev) return
    const ids = prev.slots.filter((s) => s.photoId).map((s) => s.photoId!)
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[ids[i], ids[j]] = [ids[j], ids[i]]
    }
    let k = 0
    patchCollage(
      {
        slots: prev.slots.map((s) =>
          s.photoId ? { ...s, photoId: ids[k++], offsetX: 0, offsetY: 0 } : s,
        ),
      },
      'shuffle',
    )
  }, [patchCollage])

  const placeInFrame = useCallback(
    (photoId: string) => {
      const prev = collageRef.current
      if (!prev) return
      const target =
        selectedCell !== null && selectedCell < prev.slots.length
          ? selectedCell
          : prev.slots.findIndex((s) => !s.photoId)
      if (target < 0) {
        notify('info', 'Every frame is full. Select one to replace it.')
        return
      }
      patchCollage(
        {
          slots: prev.slots.map((s, i) =>
            i === target ? { photoId, zoom: 1, offsetX: 0, offsetY: 0 } : s,
          ),
        },
        'fill',
      )
      const nextEmpty = prev.slots.findIndex((s, i) => i > target && !s.photoId)
      setSelectedCell(nextEmpty >= 0 ? nextEmpty : target)
    },
    [selectedCell, patchCollage, notify],
  )

  const addText = useCallback(() => {
    const prev = collageRef.current
    if (!prev) return
    const layer: TextLayer = {
      id: `t${Date.now().toString(36)}`,
      text: 'Tap to edit',
      x: 0.5,
      y: 0.88,
      size: 0.07,
      color: '#ffffff',
      font: 'fraunces',
      weight: 600,
      align: 'center',
      rotation: 0,
      shadow: true,
      italic: false,
      uppercase: false,
      tracking: 0,
      style: 'plain',
      plateColor: '#0f0e0c',
    }
    patchCollage({ texts: [...prev.texts, layer] }, 'text:add')
    setSelectedText(layer.id)
    setSelectedCell(null)
  }, [patchCollage])

  const runCollageExport = useCallback(async () => {
    const doc = collageRef.current
    if (!doc) return
    const [w, h] = collageSize(doc, collageExport.longEdge)
    setBusy('Rendering the collage…')
    try {
      const blob = await exportCollage(
        doc,
        sources,
        w,
        h,
        collageExport.format,
        collageExport.quality,
      )
      const ext = collageExport.format === 'jpeg' ? 'jpg' : collageExport.format
      saveBlob(blob, `collage-${w}x${h}.${ext}`)
      notify('ok', `Exported ${w} × ${h}.`)
    } catch (err) {
      notify('error', `Collage export failed: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [collageExport, sources, notify])

  const enterCollage = useCallback(() => {
    if (!collageRef.current) {
      const doc = createCollage(Math.max(photosRef.current.length, 2))
      doc.slots = doc.cells.map((_, i) =>
        photosRef.current[i]
          ? { photoId: photosRef.current[i].id, zoom: 1, offsetX: 0, offsetY: 0 }
          : { ...EMPTY_SLOT },
      )
      collageRef.current = doc
      setCollage(doc)
      setSelectedCell(0)
    }
    setMode('collage')
  }, [])

  const selectPhoto = useCallback((id: string) => {
    setSelectedId(id)
    setTool('adjust')
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          <span className="lens" />
          <h1>Darkroom</h1>
          <small>{mode === 'collage' ? 'Stage 2 · collage' : 'Stage 1 · single photo'}</small>
        </div>

        {photos.length > 0 && (
          <div className="mode-switch" role="tablist" aria-label="Mode">
            <button
              role="tab"
              className="mode-btn"
              aria-selected={mode === 'enhance'}
              onClick={() => setMode('enhance')}
            >
              Enhance
            </button>
            <button
              role="tab"
              className="mode-btn"
              aria-selected={mode === 'collage'}
              onClick={enterCollage}
            >
              Collage
            </button>
          </div>
        )}

        {selected && mode === 'enhance' && (
          <div className="chip-row">
            <button
              className="chip"
              aria-pressed={selected.presetId === 'none'}
              onClick={resetToOriginal}
              title="Show the file exactly as it came off the phone"
            >
              Original
            </button>
            {PRESETS.map((p) => (
              <button
                key={p.id}
                className="chip"
                aria-pressed={selected.presetId === p.id}
                onClick={() => choosePreset(p.id)}
                title={p.hint}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}

        <div className="topbar-spacer" />

        {selected && (
          <div className="undo-pair">
            <button
              className="btn btn-sm"
              onClick={() => (mode === 'collage' ? stepCollage('undo') : step('undo'))}
              disabled={mode === 'collage' ? collageHist.current.docs.length === 0 : !canUndo}
              title="Undo  (Ctrl/Cmd + Z)"
            >
              ↶
            </button>
            <button
              className="btn btn-sm"
              onClick={() => (mode === 'collage' ? stepCollage('redo') : step('redo'))}
              disabled={
                mode === 'collage'
                  ? (collageHist.current.future as unknown[]).length === 0
                  : !canRedo
              }
              title="Redo  (Ctrl/Cmd + Shift + Z)"
            >
              ↷
            </button>
          </div>
        )}

        {photos.length > 1 && mode === 'enhance' && (
          <button
            className="btn btn-sm"
            onClick={applyToAll}
            title="Copy these sliders to every photo. Each photo keeps its own measured black and white points, and its own framing."
          >
            Apply to all
          </button>
        )}

        <button
          className="btn btn-sm theme-btn"
          onClick={() => setTheme((t) => NEXT_THEME[t])}
          title={`Appearance: ${THEME_LABEL[theme]}. Click to change.`}
          aria-label={`Appearance: ${THEME_LABEL[theme]}`}
        >
          {theme === 'system' ? '◐' : theme === 'light' ? '☀' : '☾'}
        </button>

        <span className="privacy-note">Runs on this device only</span>
      </header>

      {photos.length === 0 || !selected ? (
        <div className="workspace">
          <Hero onFiles={addFiles} />
        </div>
      ) : mode === 'collage' && collage ? (
        <div className="workspace collage-mode">
          <CollageTray
            photos={photos}
            used={new Set(collage.slots.map((s) => s.photoId).filter(Boolean) as string[])}
            onPlace={placeInFrame}
            onFiles={addFiles}
            hasSelection={selectedCell !== null}
          />
          <CollageStage
            doc={collage}
            sources={sources}
            selectedCell={selectedCell}
            selectedText={selectedText}
            onDoc={onCollageDoc}
            onSelectCell={setSelectedCell}
            onSelectText={setSelectedText}
            onError={reportError}
          />
          <CollagePanel
            doc={collage}
            photoCount={photos.length}
            selectedCell={selectedCell}
            selectedText={selectedText}
            onDoc={onCollageDoc}
            onLayout={chooseLayout}
            onSelectText={setSelectedText}
            onAutoFill={autoFill}
            onShuffle={shuffleCollage}
            onClearAll={() =>
              onCollageDoc({ slots: collage.cells.map(() => ({ ...EMPTY_SLOT })) }, 'clear')
            }
            onClearCell={(i) =>
              onCollageDoc(
                { slots: collage.slots.map((sl, k) => (k === i ? { ...EMPTY_SLOT } : sl)) },
                'clear',
              )
            }
            onAddText={addText}
            collapsed={!sheetOpen}
            onExpand={() => setSheetOpen((v) => !v)}
            footer={
              <CollageExportPanel
                doc={collage}
                config={collageExport}
                onChange={(patch) => setCollageExport((c) => ({ ...c, ...patch }))}
                onExport={runCollageExport}
                busy={busy !== null}
                filled={collage.slots.filter((sl) => sl.photoId).length}
              />
            }
          />
        </div>
      ) : (
        <div className="workspace">
          <Filmstrip
            photos={photos}
            selectedId={selectedId}
            onSelect={selectPhoto}
            onRemove={removePhoto}
            onFiles={addFiles}
          />
          <Stage
            photo={selected}
            tool={tool}
            onTool={setTool}
            onGeometry={onGeometry}
            selectedArea={liveArea}
            onSelectArea={setSelectedArea}
            onArea={onArea}
            onError={reportError}
          />
          <AdjustPanel
            photo={selected}
            tool={tool}
            onTool={setTool}
            onAdjust={markCustom}
            onMix={onMix}
            onResetMix={onResetMix}
            selectedArea={liveArea}
            onSelectArea={setSelectedArea}
            onAddArea={onAddArea}
            onArea={onArea}
            onRemoveArea={onRemoveArea}
            looks={looks}
            onApplyLook={applyLook}
            onSaveLook={saveLook}
            onDeleteLook={deleteLook}
            onGeometry={onGeometry}
            onResetFraming={onResetFraming}
            aiSettings={aiSettings}
            onOpenAiSettings={() => setAiDialog(true)}
            onApplyAi={applyAiProposal}
            collapsed={!sheetOpen}
            onExpand={() => setSheetOpen((v) => !v)}
            footer={
              <ExportPanel
                photo={selected}
                config={config}
                onChange={updateConfig}
                count={photos.length}
                busy={busy !== null}
                onExportOne={() => runExport([selected], false)}
                onExportAll={() => runExport(photos, true)}
              />
            }
          />
        </div>
      )}

      {aiDialog && (
        <AiSettingsDialog
          settings={aiSettings}
          onChange={updateAiSettings}
          onClose={() => setAiDialog(false)}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />

      {busy && (
        <div className="busy">
          <div className="busy-card">
            <div className="busy-ring" />
            <span>{busy}</span>
          </div>
        </div>
      )}
    </div>
  )
}
