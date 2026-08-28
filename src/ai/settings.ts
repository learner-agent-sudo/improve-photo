/**
 * Where the AI configuration lives.
 *
 * localStorage, on this device, in this browser. Nothing is synced and nothing
 * is committed - which is the point: an API key in the repository would be
 * public the moment it was pushed, and scrapers find those within minutes.
 */
import { DEFAULT_AI_SETTINGS, type AiSettings } from './types'

const KEY = 'darkroom.ai.v1'

export function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_AI_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<AiSettings>
    return {
      ...DEFAULT_AI_SETTINGS,
      ...parsed,
      // Never let a stored value widen into something unexpected.
      transport: parsed.transport === 'direct' ? 'direct' : 'proxy',
      enabled: parsed.enabled === true,
    }
  } catch {
    return { ...DEFAULT_AI_SETTINGS }
  }
}

export function saveAiSettings(s: AiSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Private-browsing modes can refuse writes. The settings still work for
    // this session; they simply will not be remembered.
  }
}

export function clearAiSettings() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing useful to do */
  }
}

/** True when the settings are complete enough to actually make a call. */
export function isConfigured(s: AiSettings): boolean {
  if (!s.enabled || !s.model.trim()) return false
  return s.transport === 'proxy' ? s.proxyUrl.trim().length > 0 : s.apiKey.trim().length > 0
}
