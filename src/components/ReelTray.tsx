import type { Photo } from '../state/photos'
import { useFilePicker } from './Dropzone'

/**
 * The roll, in video mode: every photo in the order it will play, numbered.
 * A tap takes a photo out of the video or puts it back. The order itself is
 * changed in the panel, where there is room for proper buttons on a phone.
 */
export function ReelTray({
  photos,
  off,
  onToggle,
  onFiles,
}: {
  /** All photos, in video order. */
  photos: Photo[]
  off: Set<string>
  onToggle: (id: string) => void
  onFiles: (files: File[]) => void
}) {
  const { input, open } = useFilePicker(onFiles)
  let n = 0

  return (
    <aside className="strip">
      {input}
      <div className="strip-head">
        <span>In the video</span>
        <span>{photos.filter((p) => !off.has(p.id)).length}</span>
      </div>
      <div className="strip-list">
        {photos.map((p) => {
          const out = off.has(p.id)
          const pos = out ? null : ++n
          return (
            <button
              key={p.id}
              className={`thumb reel-thumb${out ? ' out' : ''}`}
              aria-pressed={!out}
              aria-label={out ? `${p.name}: left out. Tap to put it back.` : `${p.name}: number ${pos}. Tap to leave it out.`}
              title={out ? 'Left out. Tap to put it back.' : 'Tap to leave this photo out.'}
              onClick={() => onToggle(p.id)}
            >
              <img src={p.thumbUrl} alt="" />
              <span className="reel-badge">{out ? '–' : pos}</span>
            </button>
          )
        })}
        <button className="thumb-add" onClick={open} title="Add more photos">
          <span aria-hidden="true">+</span>
          <em>Add</em>
        </button>
      </div>
    </aside>
  )
}
