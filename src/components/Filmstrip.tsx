import type { Photo } from '../state/photos'
import { useFilePicker } from './Dropzone'

export function Filmstrip({
  photos,
  selectedId,
  onSelect,
  onRemove,
  onFiles,
}: {
  photos: Photo[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
  onFiles: (files: File[]) => void
}) {
  const { input, open } = useFilePicker(onFiles)

  return (
    <aside className="strip">
      {input}
      <div className="strip-head">
        <span>Roll</span>
        <span>{photos.length}</span>
      </div>
      <div className="strip-list">
        {photos.map((p, i) => (
          <div
            key={p.id}
            className="thumb"
            aria-current={p.id === selectedId}
            onClick={() => onSelect(p.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(p.id)
              }
            }}
          >
            <img src={p.thumbUrl} alt="" />
            <button
              className="thumb-remove"
              aria-label={`Remove ${p.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onRemove(p.id)
              }}
            >
              ✕
            </button>
            <div className="thumb-meta">
              <span className="thumb-index">{String(i + 1).padStart(2, '0')}</span>
              <span title={p.name}>{p.name}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="strip-foot">
        <button className="btn btn-sm" onClick={open}>
          + Add photos
        </button>
      </div>
    </aside>
  )
}
