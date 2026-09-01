import { useEffect, useState } from 'react'

/**
 * Tracks a CSS media query from JavaScript.
 *
 * Used where the phone layout is a different arrangement of components rather
 * than the same arrangement restyled - the export controls are a permanent
 * sidebar footer on a desktop and a tab on a phone, and rendering both and
 * hiding one with CSS would put two copies of every form control, and two of
 * every id, in the document.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/** The one breakpoint the app has, kept here so it cannot drift from the CSS. */
export const PHONE_QUERY = '(max-width: 1080px)'
