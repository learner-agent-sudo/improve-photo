/**
 * The luminance histogram of the *original* file.
 *
 * It is not live-updated as you drag, deliberately: its job is to show what you
 * started with, so you can see whether the shot was underexposed or was already
 * clipping before you decide how far to push anything.
 */
export function Histogram({ bins }: { bins: number[] }) {
  return (
    <>
      <div className="histogram" role="img" aria-label="Luminance histogram of the original photo">
        {bins.map((v, i) => (
          <i key={i} style={{ height: `${Math.max(2, Math.sqrt(v) * 100)}%` }} />
        ))}
      </div>
      <div className="histogram-legend">
        <span>Shadows</span>
        <span>Midtones</span>
        <span>Highlights</span>
      </div>
    </>
  )
}
