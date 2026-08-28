import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { AdjustPanel } from './components/AdjustPanel'
import { ExportPanel, type ExportConfig } from './components/ExportPanel'
import { Filmstrip } from './components/Filmstrip'
import { Hero } from './components/Hero'
import { Stage } from './components/Stage'
import { Toasts, type Toast } from './components/Toasts'
import { Exporter, saveBlob } from './engine/export'
import { applyPreset, PRESETS } from './engine/presets'
import { TARGETS } from './engine/targets'
import {
  NEUTRAL,
  NEUTRAL_GEOMETRY,
  NEUTRAL_LEVELS,
  type Adjustments,
  type Geometry,
} from './engine/types'
import { createPhoto, decodeForExport, disposePhoto, type Photo } from './state/photos'

let toastId = 0

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [config, setConfig] = useState<ExportConfig>({
    targetId: 'original',
    format: 'jpeg',
    quality: 0.9,
  })

  const photosRef = useRef(photos)
  photosRef.current = photos

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
        // A newly chosen export target should apply to incoming photos too.
        const target = TARGETS.find((t) => t.id === config.targetId)
        if (target) {
          for (const p of loaded) p.edit.geometry.aspect = target.aspect
        }
        setPhotos((prev) => [...prev, ...loaded])
        setSelectedId((cur) => cur ?? loaded[0].id)
      }
      setBusy(null)
    },
    [config.targetId, notify],
  )

  const removePhoto = useCallback((id: string) => {
    setPhotos((prev) => {
      const gone = prev.find((p) => p.id === id)
      if (gone) disposePhoto(gone)
      const next = prev.filter((p) => p.id !== id)
      setSelectedId((cur) => (cur === id ? (next[0]?.id ?? null) : cur))
      return next
    })
  }, [])

  // --- editing --------------------------------------------------------------
  const patchSelected = useCallback(
    (fn: (p: Photo) => Photo) => {
      setPhotos((prev) => prev.map((p) => (p.id === selectedId ? fn(p) : p)))
    },
    [selectedId],
  )

  const onAdjust = useCallback(
    (patch: Partial<Adjustments>) =>
      patchSelected((p) => ({
        ...p,
        presetId: 'custom',
        edit: { ...p.edit, adjustments: { ...p.edit.adjustments, ...patch } },
      })),
    [patchSelected],
  )

  const onGeometry = useCallback(
    (patch: Partial<Geometry>) =>
      patchSelected((p) => ({ ...p, edit: { ...p.edit, geometry: { ...p.edit.geometry, ...patch } } })),
    [patchSelected],
  )

  const onResetFraming = useCallback(
    () =>
      patchSelected((p) => ({
        ...p,
        edit: {
          ...p.edit,
          geometry: { ...NEUTRAL_GEOMETRY, aspect: p.edit.geometry.aspect },
        },
      })),
    [patchSelected],
  )

  const choosePreset = useCallback(
    (presetId: string) => {
      const preset = PRESETS.find((x) => x.id === presetId)
      if (!preset) return
      patchSelected((p) => ({
        ...p,
        presetId,
        // Presets always build on this photo's own Auto result, so switching
        // between them never compounds.
        edit: {
          ...p.edit,
          adjustments: applyPreset(p.auto.adjustments, preset),
          levels: p.auto.levels,
        },
      }))
    },
    [patchSelected],
  )

  const resetToOriginal = useCallback(
    () =>
      patchSelected((p) => ({
        ...p,
        presetId: 'none',
        edit: { ...p.edit, adjustments: { ...NEUTRAL }, levels: { ...NEUTRAL_LEVELS } },
      })),
    [patchSelected],
  )

  /**
   * Copies the sliders to every photo but leaves each one's own measured black
   * and white points alone: a consistent look across the set, without forcing
   * one photo's levels onto a differently-exposed shot.
   */
  const applyToAll = useCallback(() => {
    if (!selected) return
    const adjustments = { ...selected.edit.adjustments }
    const presetId = selected.presetId
    setPhotos((prev) =>
      prev.map((p) => (p.id === selected.id ? p : { ...p, presetId, edit: { ...p.edit, adjustments } })),
    )
    notify('ok', `Applied to all ${photos.length} photos.`)
  }, [selected, photos.length, notify])

  // Changing the export target re-shapes every photo, because the export will
  // crop them all to that shape anyway.
  const updateConfig = useCallback((patch: Partial<ExportConfig>) => {
    setConfig((c) => {
      const next = { ...c, ...patch }
      if (patch.targetId) {
        const t = TARGETS.find((x) => x.id === patch.targetId)
        if (t) {
          setPhotos((prev) =>
            prev.map((p) => ({ ...p, edit: { ...p.edit, geometry: { ...p.edit.geometry, aspect: t.aspect } } })),
          )
        }
      }
      return next
    })
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
          // Yield so the progress label actually paints between photos.
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
  // Copying an image in another app or browser tab and pressing Ctrl/Cmd+V here
  // is often quicker than saving it to disk first.
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
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.isContentEditable)) return
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
  }, [selectedId])

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

        {photos.length > 1 && (
          <button
            className="btn btn-sm"
            onClick={applyToAll}
            title="Copy these sliders to every photo. Each photo keeps its own measured black and white points."
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
            onSelect={setSelectedId}
            onRemove={removePhoto}
            onFiles={addFiles}
          />
          <Stage
            photo={selected}
            onGeometry={onGeometry}
            onError={reportError}
          />
          <AdjustPanel
            photo={selected}
            onAdjust={onAdjust}
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
