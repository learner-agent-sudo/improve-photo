import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { AdjustPanel } from './components/AdjustPanel'
import { ExportPanel, type ExportConfig } from './components/ExportPanel'
import { Filmstrip } from './components/Filmstrip'
import { Hero } from './components/Hero'
import { Stage, type Tool } from './components/Stage'
import { Toasts, type Toast } from './components/Toasts'
import { Exporter, saveBlob } from './engine/export'
import { aspectRatio, centredCrop, framedSize } from './engine/geometry'
import { applyPreset, PRESETS } from './engine/presets'
import { TARGETS } from './engine/targets'
import {
  NEUTRAL,
  NEUTRAL_GEOMETRY,
  NEUTRAL_LEVELS,
  type Adjustments,
  type Edit,
  type Geometry,
} from './engine/types'
import { createPhoto, decodeForExport, disposePhoto, type Photo } from './state/photos'

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
  const markCustom = useCallback(
    (patch: Partial<Adjustments>) => {
      onAdjust(patch)
      setPhotos((prev) =>
        prev.map((p) => (p.id === selectedId && p.presetId !== 'custom' ? { ...p, presetId: 'custom' } : p)),
      )
    },
    [onAdjust, selectedId],
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

  const resetToOriginal = useCallback(() => {
    patchEdit('preset:none', (e) => ({
      ...e,
      adjustments: { ...NEUTRAL },
      levels: { ...NEUTRAL_LEVELS },
    }))
    setPhotos((prev) => prev.map((p) => (p.id === selectedId ? { ...p, presetId: 'none' } : p)))
  }, [patchEdit, selectedId])

  /**
   * Copies the sliders to every photo but leaves each one's own measured black
   * and white points alone: a consistent look across the set, without forcing
   * one photo's levels onto a differently-exposed shot. Framing stays personal
   * to each photo, since what needs to stay in frame differs shot to shot.
   */
  const applyToAll = useCallback(() => {
    if (!selected) return
    const adjustments = { ...selected.edit.adjustments }
    const presetId = selected.presetId
    const next = photosRef.current.map((p) => {
      if (p.id === selected.id) return p
      entryFor(p.id).past.push(p.edit)
      return { ...p, presetId, edit: { ...p.edit, adjustments } }
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
        step(e.shiftKey ? 'redo' : 'undo')
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
  }, [selectedId, step])

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
          <small>Stage 1 · single photo</small>
        </div>

        {selected && (
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
              onClick={() => step('undo')}
              disabled={!canUndo}
              title="Undo  (Ctrl/Cmd + Z)"
            >
              ↶
            </button>
            <button
              className="btn btn-sm"
              onClick={() => step('redo')}
              disabled={!canRedo}
              title="Redo  (Ctrl/Cmd + Shift + Z)"
            >
              ↷
            </button>
          </div>
        )}

        {photos.length > 1 && (
          <button
            className="btn btn-sm"
            onClick={applyToAll}
            title="Copy these sliders to every photo. Each photo keeps its own measured black and white points, and its own framing."
          >
            Apply to all
          </button>
        )}

        <span className="privacy-note">Runs on this device only</span>
      </header>

      {photos.length === 0 || !selected ? (
        <div className="workspace">
          <Hero onFiles={addFiles} />
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
            onError={reportError}
          />
          <AdjustPanel
            photo={selected}
            tool={tool}
            onTool={setTool}
            onAdjust={markCustom}
            onGeometry={onGeometry}
            onResetFraming={onResetFraming}
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
