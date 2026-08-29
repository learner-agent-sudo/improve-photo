/**
 * Light, dark, or whatever the device is set to.
 *
 * The choice lives on the document root as `data-theme`, and its absence means
 * "follow the system" - which is why the CSS keys the light palette off both a
 * `prefers-color-scheme` query and an explicit attribute.
 */
export type Theme = 'system' | 'light' | 'dark'

const KEY = 'darkroom.theme'

/** Colour of the browser chrome on mobile, per resolved theme. */
const CHROME = { dark: '#131110', light: '#f6f1e7' }

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

export function resolveTheme(t: Theme): 'light' | 'dark' {
  if (t !== 'system') return t
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

export function applyTheme(t: Theme) {
  const root = document.documentElement
  if (t === 'system') delete root.dataset.theme
  else root.dataset.theme = t
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', CHROME[resolveTheme(t)])
  try {
    if (t === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
  } catch {
    // Private browsing can refuse writes; the choice still holds for this session.
  }
}

export const NEXT_THEME: Record<Theme, Theme> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

export const THEME_LABEL: Record<Theme, string> = {
  system: 'Following the device',
  light: 'Light',
  dark: 'Dark',
}
