import { useCallback, useRef, useState, type ReactNode } from 'react'

export const ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif'

export function useFilePicker(onFiles: (files: File[]) => void) {
  const ref = useRef<HTMLInputElement | null>(null)
  const input = (
    <input
      ref={ref}
      type="file"
      accept={ACCEPT}
      multiple
      className="sr-only"
      onChange={(e) => {
        const files = Array.from(e.target.files ?? [])
        if (files.length) onFiles(files)
        // Reset so picking the same file twice still fires a change event.
        e.target.value = ''
      }}
    />
  )
  return { input, open: () => ref.current?.click() }
}

export function Dropzone({
  onFiles,
  children,
}: {
  onFiles: (files: File[]) => void
  children?: ReactNode
}) {
  const [over, setOver] = useState(false)
  const { input, open } = useFilePicker(onFiles)

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setOver(false)
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name))
      if (files.length) onFiles(files)
    },
    [onFiles],
  )

  return (
    <>
      {input}
      <button
        type="button"
        className={`dropzone${over ? ' over' : ''}`}
        onClick={open}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
      >
        {children ?? (
          <>
            <div className="aperture" />
            <strong>Drop photos here, or choose files</strong>
            <span>JPEG, PNG, WebP or AVIF · as many as you like · nothing is uploaded</span>
          </>
        )}
      </button>
    </>
  )
}
