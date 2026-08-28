import { useCallback } from 'react'

export interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step?: number
  /** Fill the track outward from zero rather than from the left edge. */
  bipolar?: boolean
  /** Turns the raw value into the number shown on the right. */
  display?: (v: number) => string
  onChange: (v: number) => void
  onReset: () => void
}

const asPercent = (v: number) => `${Math.round(v * 100)}`

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  bipolar,
  display = asPercent,
  onChange,
  onReset,
}: SliderProps) {
  const isBipolar = bipolar ?? min < 0
  const pos = (value - min) / (max - min)
  const zero = isBipolar ? (0 - min) / (max - min) : 0
  const a = Math.min(pos, zero) * 100
  const b = Math.max(pos, zero) * 100
  const track =
    `linear-gradient(90deg, var(--ink-700) 0 ${a}%, var(--amber) ${a}% ${b}%, var(--ink-700) ${b}% 100%)`

  const touched = Math.abs(value) > 0.005

  // Double-click on the row is the standard "put this control back" gesture in
  // photo editors, and it saves a reset button next to every slider.
  const handleDoubleClick = useCallback(() => onReset(), [onReset])

  return (
    <div className={`slider${touched ? ' touched' : ''}`} onDoubleClick={handleDoubleClick}>
      <div className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{display(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ ['--track' as string]: track }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}
