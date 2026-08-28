import type { Photo } from '../state/photos'
import { useFilePicker } from './Dropzone'

/**
 * The roll, in collage mode.
 *
 * Two ways to place a photo, because one of them fails on touch: drag a
 * thumbnail onto a frame, or select a frame and click a thumbnail.
 */
export function CollageTray({
  photos,
  used,
  onPlace,
  onFiles,
  hasSelection,
}: {
  photos: Photo[]
  used: Set<string>
  onPlace: (photoId: string) => void
  onFiles: (files: File[]) => void
  hasSelection: boolean
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
            className={`thumb tray${used.has(p.id) ? ' used' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/darkroom-photo', p.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={() => onPlace(p.id)}
            role="button"
            tabIndex={0}
            title={hasSelection ? `Put ${p.name} in the selected frame` : 'Select a frame first, or drag this onto one'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPlace(p.id)
              }
            }}
          >
            <img src={p.thumbUrl} alt="" draggable={false} />
            {used.has(p.id) && <span className="thumb-used" aria-label="already placed">✓</span>}
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
